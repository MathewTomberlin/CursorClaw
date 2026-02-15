import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { TurnResult } from "./runtime.js";

type RunStatus = "pending" | "completed" | "failed" | "interrupted";

export interface PersistedRunRecord {
  runId: string;
  sessionId: string;
  /** When set, used to resolve profile root for thread store (append assistant on completion). */
  profileId?: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  consumedAt?: string;
  result?: TurnResult;
  error?: string;
}

export interface RunStoreOptions {
  stateFile: string;
  maxCompletedRuns?: number;
}

interface PersistedRunStoreFile {
  runs: PersistedRunRecord[];
}

export class RunStore {
  private readonly records = new Map<string, PersistedRunRecord>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: RunStoreOptions) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    try {
      const raw = await readFile(this.options.stateFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedRunStoreFile;
      this.records.clear();
      for (const record of parsed.runs ?? []) {
        this.records.set(record.runId, record);
      }
    } catch {
      // No state yet.
    }
    this.loaded = true;
  }

  async createPending(runId: string, sessionId: string, profileId?: string): Promise<void> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    this.records.set(runId, {
      runId,
      sessionId,
      ...(profileId !== undefined ? { profileId } : {}),
      status: "pending",
      createdAt: now,
      updatedAt: now
    });
    await this.persist();
  }

  async markCompleted(runId: string, result: TurnResult): Promise<void> {
    await this.ensureLoaded();
    const existing = this.records.get(runId);
    const now = new Date().toISOString();
    if (!existing) {
      this.records.set(runId, {
        runId,
        sessionId: result.events[0]?.sessionId ?? "unknown",
        status: "completed",
        createdAt: now,
        updatedAt: now,
        result
      });
    } else {
      existing.status = "completed";
      existing.updatedAt = now;
      existing.result = result;
      delete existing.error;
    }
    this.prune();
    await this.persist();
  }

  async markFailed(runId: string, error: string): Promise<void> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const existing = this.records.get(runId);
    if (!existing) {
      this.records.set(runId, {
        runId,
        sessionId: "unknown",
        status: "failed",
        createdAt: now,
        updatedAt: now,
        error
      });
    } else {
      existing.status = "failed";
      existing.updatedAt = now;
      existing.error = error;
      delete existing.result;
    }
    this.prune();
    await this.persist();
  }

  async markInFlightInterrupted(): Promise<number> {
    await this.ensureLoaded();
    let changed = 0;
    const now = new Date().toISOString();
    for (const record of this.records.values()) {
      if (record.status !== "pending") {
        continue;
      }
      record.status = "interrupted";
      record.updatedAt = now;
      record.error = "run interrupted by process restart";
      changed += 1;
    }
    if (changed > 0) {
      await this.persist();
    }
    return changed;
  }

  /** True if any run is currently marked interrupted (e.g. after process restart). */
  async hasInterruptedRuns(): Promise<boolean> {
    await this.ensureLoaded();
    for (const record of this.records.values()) {
      if (record.status === "interrupted") {
        return true;
      }
    }
    return false;
  }

  async get(runId: string): Promise<PersistedRunRecord | undefined> {
    await this.ensureLoaded();
    const record = this.records.get(runId);
    if (!record || record.consumedAt !== undefined) {
      return undefined;
    }
    return { ...record };
  }

  async consume(runId: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.records.get(runId);
    if (!existing) {
      return;
    }
    existing.consumedAt = new Date().toISOString();
    existing.updatedAt = existing.consumedAt;
    this.prune();
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  private prune(): void {
    const limit = this.options.maxCompletedRuns ?? 2_000;
    const completed = [...this.records.values()]
      .filter((record) => record.consumedAt !== undefined)
      .sort((lhs, rhs) => lhs.updatedAt.localeCompare(rhs.updatedAt));
    const overflow = completed.length - limit;
    if (overflow <= 0) {
      return;
    }
    for (const entry of completed.slice(0, overflow)) {
      this.records.delete(entry.runId);
    }
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.stateFile), { recursive: true });
      const payload: PersistedRunStoreFile = {
        runs: [...this.records.values()]
      };
      await writeFile(this.options.stateFile, JSON.stringify(payload, null, 2), "utf8");
    });
    await this.writeChain;
  }
}
