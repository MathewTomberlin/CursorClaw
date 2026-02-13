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
      const hour = now.getHours();
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
}

export class HeartbeatRunner {
  private currentIntervalMs: number;

  constructor(private readonly config: HeartbeatConfig) {
    this.currentIntervalMs = config.everyMs;
  }

  nextInterval(input: HeartbeatTickInput): number {
    const now = input.now ?? new Date();
    if (this.config.activeHours) {
      const { startHour, endHour } = this.config.activeHours;
      const hour = now.getHours();
      const inActiveWindow =
        startHour <= endHour
          ? hour >= startHour && hour < endHour
          : hour >= startHour || hour < endHour;
      if (!inActiveWindow) {
        this.currentIntervalMs = this.config.maxMs;
        return this.currentIntervalMs;
      }
    }

    if (input.unreadEvents > 20) {
      this.currentIntervalMs = Math.max(this.config.minMs, Math.floor(this.currentIntervalMs * 0.5));
    } else if (input.unreadEvents > 8) {
      this.currentIntervalMs = Math.max(this.config.minMs, Math.floor(this.currentIntervalMs * 0.75));
    } else if (input.unreadEvents === 0) {
      this.currentIntervalMs = Math.min(this.config.maxMs, Math.floor(this.currentIntervalMs * 1.2));
    }
    return this.currentIntervalMs;
  }

  async runOnce(args: {
    channelId: string;
    budget: AutonomyBudget;
    turn: () => Promise<string>;
  }): Promise<"HEARTBEAT_OK" | "SENT"> {
    if (!this.config.enabled) {
      return "HEARTBEAT_OK";
    }
    if (!args.budget.allow(args.channelId)) {
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
  const amount = Number.parseInt(m[1], 10);
  const unit = m[2];
  const multiplier: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000
  };
  return amount * multiplier[unit];
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
      id,
      nextRunAt: this.computeNextRun({ ...def, id }, Date.now())
    };
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
        record.lastError = undefined;
        record.def.nextRunAt = this.computeNextRun(record.def, now);
      } catch (error) {
        record.retries += 1;
        record.lastError = String(error);
        if (record.retries > record.def.maxRetries) {
          record.def.nextRunAt = this.computeNextRun(record.def, now);
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

  private isDue(job: CronJobDefinition, now: number): boolean {
    if (!job.nextRunAt) {
      job.nextRunAt = this.computeNextRun(job, now - 1);
    }
    return now >= (job.nextRunAt ?? now);
  }

  private computeNextRun(job: CronJobDefinition, fromMs: number): number {
    if (job.type === "at") {
      return Number.parseInt(job.expression, 10);
    }
    if (job.type === "every") {
      return fromMs + parseDurationToMs(job.expression);
    }
    const interval = cronParser.CronExpressionParser.parse(job.expression, {
      currentDate: new Date(fromMs)
    });
    return interval.next().getTime();
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
    const existing = this.state.get(key);
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
    const file = join(this.stateDir, `${state.workflowId}-${state.idempotencyKey}.json`);
    await writeFile(file, JSON.stringify(state, null, 2), "utf8");
  }
}
