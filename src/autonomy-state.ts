import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AutonomyBudgetState } from "./scheduler.js";

export type ProactiveIntentStatus = "pending" | "sent" | "cancelled";

export interface ProactiveIntent {
  id: string;
  channelId: string;
  text: string;
  notBeforeMs: number;
  createdAt: string;
  status: ProactiveIntentStatus;
  sentAt?: string;
}

export interface AutonomyStateSnapshot {
  budget: AutonomyBudgetState;
  intents: ProactiveIntent[];
  updatedAt: string;
}

export interface AutonomyStateStoreOptions {
  stateFile: string;
}

function emptySnapshot(now = new Date().toISOString()): AutonomyStateSnapshot {
  return {
    budget: {
      hourly: {},
      daily: {}
    },
    intents: [],
    updatedAt: now
  };
}

function sanitizeSnapshot(raw: Partial<AutonomyStateSnapshot> | undefined): AutonomyStateSnapshot {
  if (!raw) {
    return emptySnapshot();
  }
  const intents = Array.isArray(raw.intents)
    ? raw.intents.filter(
        (intent): intent is ProactiveIntent =>
          typeof intent?.id === "string" &&
          typeof intent?.channelId === "string" &&
          typeof intent?.text === "string" &&
          typeof intent?.notBeforeMs === "number" &&
          typeof intent?.createdAt === "string" &&
          ["pending", "sent", "cancelled"].includes(intent.status)
      )
    : [];
  return {
    budget: {
      hourly: raw.budget?.hourly ?? {},
      daily: raw.budget?.daily ?? {}
    },
    intents,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
  };
}

export class AutonomyStateStore {
  private state = emptySnapshot();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: AutonomyStateStoreOptions) {}

  async load(): Promise<AutonomyStateSnapshot> {
    if (this.loaded) {
      return this.cloneState();
    }
    try {
      const raw = await readFile(this.options.stateFile, "utf8");
      this.state = sanitizeSnapshot(JSON.parse(raw) as Partial<AutonomyStateSnapshot>);
    } catch {
      this.state = emptySnapshot();
    }
    this.loaded = true;
    return this.cloneState();
  }

  async get(): Promise<AutonomyStateSnapshot> {
    if (!this.loaded) {
      await this.load();
    }
    return this.cloneState();
  }

  async replace(next: AutonomyStateSnapshot): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
    this.state = sanitizeSnapshot(next);
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async upsertBudget(budget: AutonomyBudgetState): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
    this.state.budget = {
      hourly: budget.hourly,
      daily: budget.daily
    };
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async queueIntent(args: {
    channelId: string;
    text: string;
    notBeforeMs?: number;
  }): Promise<ProactiveIntent> {
    if (!this.loaded) {
      await this.load();
    }
    const intent: ProactiveIntent = {
      id: randomUUID(),
      channelId: args.channelId,
      text: args.text,
      notBeforeMs: args.notBeforeMs ?? Date.now(),
      createdAt: new Date().toISOString(),
      status: "pending"
    };
    this.state.intents.push(intent);
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
    return intent;
  }

  async listPendingIntents(nowMs = Date.now()): Promise<ProactiveIntent[]> {
    if (!this.loaded) {
      await this.load();
    }
    return this.state.intents
      .filter((intent) => intent.status === "pending" && intent.notBeforeMs <= nowMs)
      .map((intent) => ({ ...intent }));
  }

  async markIntentSent(intentId: string): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
    const intent = this.state.intents.find((entry) => entry.id === intentId);
    if (!intent) {
      return;
    }
    intent.status = "sent";
    intent.sentAt = new Date().toISOString();
    this.state.updatedAt = intent.sentAt;
    await this.persist();
  }

  private cloneState(): AutonomyStateSnapshot {
    return {
      budget: {
        hourly: { ...this.state.budget.hourly },
        daily: { ...this.state.budget.daily }
      },
      intents: this.state.intents.map((intent) => ({ ...intent })),
      updatedAt: this.state.updatedAt
    };
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.stateFile), { recursive: true });
      await writeFile(this.options.stateFile, JSON.stringify(this.state, null, 2), "utf8");
    });
    await this.writeChain;
  }
}
