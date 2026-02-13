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
  heartbeatChannelId: string;
  cronTickMs: number;
  integrityScanEveryMs: number;
  onCronRun: (job: CronJobDefinition) => Promise<void>;
  onHeartbeatTurn: (channelId: string) => Promise<string>;
  onIntegrityScan?: (findings: IntegrityFinding[]) => void;
}

export class AutonomyOrchestrator {
  private cronTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private integrityTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastHeartbeatResult: "HEARTBEAT_OK" | "SENT" = "HEARTBEAT_OK";
  private latestIntegrityFindings: IntegrityFinding[] = [];

  constructor(private readonly options: AutonomyOrchestratorOptions) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
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

  getState(): {
    running: boolean;
    lastHeartbeatResult: "HEARTBEAT_OK" | "SENT";
    latestIntegrityFindings: IntegrityFinding[];
  } {
    return {
      running: this.running,
      lastHeartbeatResult: this.lastHeartbeatResult,
      latestIntegrityFindings: [...this.latestIntegrityFindings]
    };
  }

  private scheduleHeartbeat(unreadEvents: number): void {
    if (!this.running) {
      return;
    }
    const intervalMs = this.options.heartbeat.nextInterval({ unreadEvents });
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
    const result = await this.options.heartbeat.runOnce({
      channelId: this.options.heartbeatChannelId,
      budget: this.options.budget,
      turn: () => this.options.onHeartbeatTurn(this.options.heartbeatChannelId)
    });
    this.lastHeartbeatResult = result;
  }

  private async scanIntegrity(): Promise<void> {
    const findings = await this.options.memory.integrityScan();
    this.latestIntegrityFindings = findings;
    this.options.onIntegrityScan?.(findings);
  }
}
