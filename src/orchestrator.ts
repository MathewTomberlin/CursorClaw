import type { AutonomyStateStore, ProactiveIntent } from "./autonomy-state.js";
import type { IntegrityFinding, MemoryStore } from "./memory.js";
import {
  AutonomyBudget,
  CronService,
  HeartbeatRunner,
  WorkflowRuntime,
  type WorkflowState
} from "./scheduler.js";
import type { CronJobDefinition, WorkflowDefinition } from "./types.js";

export interface AutonomyOrchestratorOptions {
  cronService: CronService;
  heartbeat: HeartbeatRunner;
  budget: AutonomyBudget;
  workflow: WorkflowRuntime;
  memory: MemoryStore;
  autonomyStateStore?: AutonomyStateStore;
  heartbeatChannelId: string;
  cronTickMs: number;
  integrityScanEveryMs: number;
  intentTickMs?: number;
  /** If set, used only for the first heartbeat schedule (e.g. when BIRTH.md exists so user sees a proactive message soon). */
  firstHeartbeatDelayMs?: number;
  onCronRun: (job: CronJobDefinition) => Promise<void>;
  onHeartbeatTurn: (channelId: string) => Promise<string>;
  onProactiveIntent?: (intent: ProactiveIntent) => Promise<boolean>;
  onIntegrityScan?: (findings: IntegrityFinding[]) => void;
}

export class AutonomyOrchestrator {
  private cronTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private integrityTimer: NodeJS.Timeout | null = null;
  private intentTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastHeartbeatResult: "HEARTBEAT_OK" | "SENT" = "HEARTBEAT_OK";
  private latestIntegrityFindings: IntegrityFinding[] = [];
  private pendingProactiveIntents = 0;
  private firstHeartbeatNotYetScheduled = true;
  private firstHeartbeatRunDone = false;

  constructor(private readonly options: AutonomyOrchestratorOptions) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.hydrateState().catch(() => undefined);
    if (this.options.cronTickMs > 0) {
      this.cronTimer = setInterval(() => {
        void this.options.cronService.tick(this.options.onCronRun).catch(() => undefined);
      }, this.options.cronTickMs);
    }
    this.scheduleHeartbeat(0);
    if (this.options.integrityScanEveryMs > 0) {
      this.integrityTimer = setInterval(() => {
        void this.scanIntegrity().catch(() => undefined);
      }, this.options.integrityScanEveryMs);
    }
    if (this.options.autonomyStateStore && this.options.onProactiveIntent) {
      const everyMs = this.options.intentTickMs ?? 1_000;
      this.intentTimer = setInterval(() => {
        void this.dispatchProactiveIntents().catch(() => undefined);
      }, everyMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.integrityTimer) {
      clearInterval(this.integrityTimer);
      this.integrityTimer = null;
    }
    if (this.intentTimer) {
      clearInterval(this.intentTimer);
      this.intentTimer = null;
    }
    await this.persistBudgetState();
    await this.options.cronService.flushState();
  }

  async runWorkflow(
    definition: WorkflowDefinition,
    args: {
      idempotencyKey: string;
      approval: (stepId: string) => Promise<boolean>;
    }
  ): Promise<WorkflowState> {
    return this.options.workflow.run(definition, args);
  }

  async queueProactiveIntent(args: {
    channelId: string;
    text: string;
    notBeforeMs?: number;
  }): Promise<ProactiveIntent> {
    if (!this.options.autonomyStateStore) {
      throw new Error("autonomy state store is not configured");
    }
    const queued = await this.options.autonomyStateStore.queueIntent(args);
    this.pendingProactiveIntents += 1;
    return queued;
  }

  getState(): {
    running: boolean;
    lastHeartbeatResult: "HEARTBEAT_OK" | "SENT";
    latestIntegrityFindings: IntegrityFinding[];
    pendingProactiveIntents: number;
  } {
    return {
      running: this.running,
      lastHeartbeatResult: this.lastHeartbeatResult,
      latestIntegrityFindings: [...this.latestIntegrityFindings],
      pendingProactiveIntents: this.pendingProactiveIntents
    };
  }

  private scheduleHeartbeat(unreadEvents: number): void {
    if (!this.running) {
      return;
    }
    const useFirstDelay =
      this.firstHeartbeatNotYetScheduled &&
      this.options.firstHeartbeatDelayMs != null &&
      this.options.firstHeartbeatDelayMs > 0;
    if (useFirstDelay) {
      this.firstHeartbeatNotYetScheduled = false;
    }
    const intervalMs = useFirstDelay
      ? this.options.firstHeartbeatDelayMs!
      : this.options.heartbeat.nextInterval({ unreadEvents });
    this.heartbeatTimer = setTimeout(() => {
      void this.runHeartbeat().finally(() => {
        this.scheduleHeartbeat(0);
      });
    }, intervalMs);
  }

  private async runHeartbeat(): Promise<void> {
    if (!this.running) {
      return;
    }
    const bypassBudget =
      this.options.firstHeartbeatDelayMs != null && this.options.firstHeartbeatDelayMs > 0 && !this.firstHeartbeatRunDone;
    const result = await this.options.heartbeat.runOnce({
      channelId: this.options.heartbeatChannelId,
      budget: this.options.budget,
      turn: () => this.options.onHeartbeatTurn(this.options.heartbeatChannelId),
      bypassBudget
    });
    this.firstHeartbeatRunDone = true;
    this.lastHeartbeatResult = result;
    await this.persistBudgetState();
  }

  private async scanIntegrity(): Promise<void> {
    const findings = await this.options.memory.integrityScan();
    this.latestIntegrityFindings = findings;
    this.options.onIntegrityScan?.(findings);
  }

  private async dispatchProactiveIntents(): Promise<void> {
    if (!this.running || !this.options.autonomyStateStore || !this.options.onProactiveIntent) {
      return;
    }
    const pending = await this.options.autonomyStateStore.listPendingIntents();
    this.pendingProactiveIntents = pending.length;
    for (const intent of pending) {
      if (!this.options.budget.allow(intent.channelId)) {
        continue;
      }
      const delivered = await this.options.onProactiveIntent(intent);
      if (delivered) {
        await this.options.autonomyStateStore.markIntentSent(intent.id);
      }
    }
    const remaining = await this.options.autonomyStateStore.listPendingIntents();
    this.pendingProactiveIntents = remaining.length;
    await this.persistBudgetState();
  }

  private async hydrateState(): Promise<void> {
    if (!this.options.autonomyStateStore) {
      return;
    }
    const state = await this.options.autonomyStateStore.load();
    this.options.budget.importState(state.budget);
    this.options.budget.clearChannel(this.options.heartbeatChannelId);
    this.pendingProactiveIntents = state.intents.filter((intent) => intent.status === "pending").length;
  }

  private async persistBudgetState(): Promise<void> {
    if (!this.options.autonomyStateStore) {
      return;
    }
    await this.options.autonomyStateStore.upsertBudget(this.options.budget.exportState());
  }
}
