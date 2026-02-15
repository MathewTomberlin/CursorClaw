import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import cronParser from "cron-parser";

import type {
  AutonomyBudgetConfig,
  CronJobDefinition,
  HeartbeatConfig,
  WorkflowDefinition
} from "./types.js";

export interface HeartbeatTickInput {
  unreadEvents: number;
  now?: Date;
}

export interface AutonomyBudgetState {
  hourly: Record<string, number[]>;
  daily: Record<string, number[]>;
}

export class AutonomyBudget {
  private readonly hourly = new Map<string, number[]>();
  private readonly daily = new Map<string, number[]>();

  constructor(private readonly config: AutonomyBudgetConfig) {}

  allow(channelId: string, now = new Date()): boolean {
    const hourTs = now.getTime() - 60 * 60_000;
    const dayTs = now.getTime() - 24 * 60 * 60_000;
    const hourWindow = (this.hourly.get(channelId) ?? []).filter((ts) => ts >= hourTs);
    const dayWindow = (this.daily.get(channelId) ?? []).filter((ts) => ts >= dayTs);
    this.hourly.set(channelId, hourWindow);
    this.daily.set(channelId, dayWindow);

    if (this.config.quietHours) {
      const hour = now.getUTCHours(); // quiet hours are interpreted in UTC
      const { startHour, endHour } = this.config.quietHours;
      if (startHour <= endHour && hour >= startHour && hour < endHour) {
        return false;
      }
      if (startHour > endHour && (hour >= startHour || hour < endHour)) {
        return false;
      }
    }
    if (hourWindow.length >= this.config.maxPerHourPerChannel) {
      return false;
    }
    if (dayWindow.length >= this.config.maxPerDayPerChannel) {
      return false;
    }
    hourWindow.push(now.getTime());
    dayWindow.push(now.getTime());
    this.hourly.set(channelId, hourWindow);
    this.daily.set(channelId, dayWindow);
    return true;
  }

  exportState(): AutonomyBudgetState {
    return {
      hourly: Object.fromEntries(this.hourly.entries()),
      daily: Object.fromEntries(this.daily.entries())
    };
  }

  importState(state: Partial<AutonomyBudgetState> | undefined): void {
    this.hourly.clear();
    this.daily.clear();
    if (!state) {
      return;
    }
    for (const [channelId, timestamps] of Object.entries(state.hourly ?? {})) {
      if (!Array.isArray(timestamps)) {
        continue;
      }
      this.hourly.set(
        channelId,
        timestamps.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      );
    }
    for (const [channelId, timestamps] of Object.entries(state.daily ?? {})) {
      if (!Array.isArray(timestamps)) {
        continue;
      }
      this.daily.set(
        channelId,
        timestamps.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      );
    }
  }

  /** Clear all timestamps for a channel (e.g. heartbeat after restart so limit applies to current run only). */
  clearChannel(channelId: string): void {
    this.hourly.delete(channelId);
    this.daily.delete(channelId);
  }
}

export class HeartbeatRunner {
  private currentIntervalMs: number;
  /** Resolves to current config so hot-reload (config.reload) applies on next tick. */
  private readonly getConfig: () => HeartbeatConfig;

  constructor(configOrGetter: HeartbeatConfig | (() => HeartbeatConfig)) {
    this.getConfig = typeof configOrGetter === "function" ? configOrGetter : () => configOrGetter;
    this.currentIntervalMs = this.getConfig().everyMs;
  }

  nextInterval(input: HeartbeatTickInput): number {
    const config = this.getConfig();
    const now = input.now ?? new Date();
    if (config.activeHours) {
      const { startHour, endHour } = config.activeHours;
      const hour = now.getHours();
      const inActiveWindow =
        startHour <= endHour
          ? hour >= startHour && hour < endHour
          : hour >= startHour || hour < endHour;
      if (!inActiveWindow) {
        this.currentIntervalMs = config.maxMs;
        return this.currentIntervalMs;
      }
    }

    if (input.unreadEvents > 20) {
      this.currentIntervalMs = Math.max(config.minMs, Math.floor(this.currentIntervalMs * 0.5));
    } else if (input.unreadEvents > 8) {
      this.currentIntervalMs = Math.max(config.minMs, Math.floor(this.currentIntervalMs * 0.75));
    } else if (input.unreadEvents === 0) {
      this.currentIntervalMs = Math.min(config.maxMs, Math.floor(this.currentIntervalMs * 1.2));
    }
    return this.currentIntervalMs;
  }

  async runOnce(args: {
    channelId: string;
    budget: AutonomyBudget;
    turn: () => Promise<string>;
    /** When true, run the turn even if budget would deny. Orchestrator sets this for every scheduled heartbeat so heartbeats run on interval; budget applies to other proactive channels only. */
    bypassBudget?: boolean;
  }): Promise<"HEARTBEAT_OK" | "SENT"> {
    const config = this.getConfig();
    if (!config.enabled) {
      if (process.env.NODE_ENV !== "test") {
        console.warn("[CursorClaw] heartbeat skipped: disabled in config");
      }
      return "HEARTBEAT_OK";
    }
    if (args.bypassBudget !== true && !args.budget.allow(args.channelId)) {
      if (process.env.NODE_ENV !== "test") {
        console.warn("[CursorClaw] heartbeat skipped: budget limit or quiet hours for channel", args.channelId);
      }
      return "HEARTBEAT_OK";
    }
    const result = await args.turn();
    if (result.trim() === "HEARTBEAT_OK") {
      return "HEARTBEAT_OK";
    }
    return "SENT";
  }
}

function parseDurationToMs(input: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(input.trim());
  if (!m) {
    throw new Error(`invalid duration: ${input}`);
  }
  const multiplier: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000
  };
  const amountToken = m[1];
  const unitToken = m[2];
  if (!amountToken || !unitToken || multiplier[unitToken] === undefined) {
    throw new Error(`invalid duration token: ${input}`);
  }
  const amount = Number.parseInt(amountToken, 10);
  return amount * multiplier[unitToken];
}

interface CronStateRecord {
  def: CronJobDefinition;
  retries: number;
  lastError?: string;
  running: boolean;
}

export class CronService {
  private readonly jobs = new Map<string, CronStateRecord>();
  private activeRuns = 0;

  constructor(
    private readonly options: {
      maxConcurrentRuns: number;
      stateFile: string;
    }
  ) {}

  addJob(def: Omit<CronJobDefinition, "id">): CronJobDefinition {
    const id = randomUUID();
    const full: CronJobDefinition = {
      ...def,
      id
    };
    this.setNextRun(full, this.computeNextRun(full, Date.now()));
    this.jobs.set(id, { def: full, retries: 0, running: false });
    return full;
  }

  listJobs(): CronJobDefinition[] {
    return [...this.jobs.values()].map((record) => record.def);
  }

  async tick(runJob: (job: CronJobDefinition) => Promise<void>, now = Date.now()): Promise<void> {
    for (const [id, record] of this.jobs.entries()) {
      if (this.activeRuns >= this.options.maxConcurrentRuns) {
        break;
      }
      if (record.running) {
        continue;
      }
      if (!this.isDue(record.def, now)) {
        continue;
      }
      record.running = true;
      this.activeRuns += 1;
      try {
        await runJob(record.def);
        record.retries = 0;
        delete record.lastError;
        this.setNextRun(record.def, this.computeNextRun(record.def, now));
      } catch (error) {
        record.retries += 1;
        record.lastError = String(error);
        if (record.retries > record.def.maxRetries) {
          this.setNextRun(record.def, this.computeNextRun(record.def, now));
          record.retries = 0;
        } else {
          record.def.nextRunAt = now + record.def.backoffMs * 2 ** (record.retries - 1);
        }
      } finally {
        record.running = false;
        this.activeRuns -= 1;
      }
    }
    await this.persistState();
  }

  async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.options.stateFile, "utf8");
      const parsed = JSON.parse(raw) as CronStateRecord[];
      this.jobs.clear();
      for (const record of parsed) {
        this.jobs.set(record.def.id, record);
      }
    } catch {
      // No state yet.
    }
  }

  async flushState(): Promise<void> {
    await this.persistState();
  }

  private isDue(job: CronJobDefinition, now: number): boolean {
    if (job.nextRunAt === undefined) {
      const nextRunAt = this.computeNextRun(job, now - 1);
      if (nextRunAt === undefined) {
        return false;
      }
      job.nextRunAt = nextRunAt;
    }
    return now >= job.nextRunAt;
  }

  private computeNextRun(job: CronJobDefinition, fromMs: number): number | undefined {
    if (job.type === "at") {
      const runAt = Number.parseInt(job.expression, 10);
      return runAt > fromMs ? runAt : undefined;
    }
    if (job.type === "every") {
      return fromMs + parseDurationToMs(job.expression);
    }
    const interval = cronParser.CronExpressionParser.parse(job.expression, {
      currentDate: new Date(fromMs)
    });
    return interval.next().getTime();
  }

  private setNextRun(job: CronJobDefinition, nextRunAt: number | undefined): void {
    if (nextRunAt === undefined) {
      delete job.nextRunAt;
      return;
    }
    job.nextRunAt = nextRunAt;
  }

  private async persistState(): Promise<void> {
    await mkdir(dirname(this.options.stateFile), { recursive: true });
    await writeFile(this.options.stateFile, JSON.stringify([...this.jobs.values()], null, 2), "utf8");
  }
}

export interface WorkflowState {
  workflowId: string;
  idempotencyKey: string;
  completedStepIds: string[];
}

export class WorkflowRuntime {
  private readonly state = new Map<string, WorkflowState>();

  constructor(private readonly stateDir: string) {}

  async run(def: WorkflowDefinition, args: {
    idempotencyKey: string;
    approval: (stepId: string) => Promise<boolean>;
  }): Promise<WorkflowState> {
    const key = `${def.id}:${args.idempotencyKey}`;
    const existing = this.state.get(key) ?? (await this.loadPersistedState(def.id, args.idempotencyKey));
    const runtimeState: WorkflowState = existing ?? {
      workflowId: def.id,
      idempotencyKey: args.idempotencyKey,
      completedStepIds: []
    };
    for (const step of def.steps) {
      if (runtimeState.completedStepIds.includes(step.id)) {
        continue;
      }
      if (step.requiresApproval) {
        const approved = await args.approval(step.id);
        if (!approved) {
          throw new Error(`workflow step denied: ${step.id}`);
        }
      }
      await step.run();
      runtimeState.completedStepIds.push(step.id);
      await this.persist(runtimeState);
    }
    this.state.set(key, runtimeState);
    return runtimeState;
  }

  private async persist(state: WorkflowState): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const file = this.getStateFile(state.workflowId, state.idempotencyKey);
    await writeFile(file, JSON.stringify(state, null, 2), "utf8");
  }

  private async loadPersistedState(
    workflowId: string,
    idempotencyKey: string
  ): Promise<WorkflowState | undefined> {
    const file = this.getStateFile(workflowId, idempotencyKey);
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as WorkflowState;
      if (
        parsed.workflowId !== workflowId ||
        parsed.idempotencyKey !== idempotencyKey ||
        !Array.isArray(parsed.completedStepIds)
      ) {
        throw new Error(`invalid workflow state file: ${file}`);
      }
      return {
        workflowId: parsed.workflowId,
        idempotencyKey: parsed.idempotencyKey,
        completedStepIds: [...parsed.completedStepIds]
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private getStateFile(workflowId: string, idempotencyKey: string): string {
    return join(this.stateDir, `${workflowId}-${idempotencyKey}.json`);
  }
}
