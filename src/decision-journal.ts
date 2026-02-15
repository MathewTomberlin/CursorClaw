import { mkdir, rename, stat, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DecisionJournalEntry {
  type: string;
  summary: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface DecisionJournalOptions {
  path: string;
  maxBytes: number;
}

export class DecisionJournal {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: DecisionJournalOptions) {}

  async append(entry: DecisionJournalEntry): Promise<void> {
    const serialized = formatEntry(entry);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.path), { recursive: true });
      await this.rotateIfNeeded();
      await writeFile(this.options.path, `${serialized}\n`, {
        encoding: "utf8",
        flag: "a"
      });
    });
    await this.writeChain;
  }

  async readRecent(limit = 30): Promise<string[]> {
    try {
      const content = await readFile(this.options.path, "utf8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);
      return lines.slice(-Math.max(1, Math.min(1_000, limit)));
    } catch {
      return [];
    }
  }

  /**
   * Returns entries for replay according to mode. Always capped at maxEntries (default 1000).
   * - count: last N entries (same as readRecent).
   * - sinceLastSession: entries with `at` >= sessionStartMs.
   * - sinceHours: entries with `at` within the last N hours.
   */
  async readEntriesForReplay(options: {
    limit: number;
    mode: "count" | "sinceLastSession" | "sinceHours";
    sinceHours?: number;
    sessionStartMs?: number;
    maxEntries?: number;
  }): Promise<string[]> {
    const maxEntries = Math.min(1_000, options.maxEntries ?? 1_000);
    try {
      const content = await readFile(this.options.path, "utf8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length === 0) return [];

      if (options.mode === "count") {
        return lines.slice(-Math.max(1, Math.min(maxEntries, options.limit)));
      }

      const now = Date.now();
      const cutoffMs =
        options.mode === "sinceLastSession" && options.sessionStartMs != null
          ? options.sessionStartMs
          : options.mode === "sinceHours"
            ? now - (Math.min(168, options.sinceHours ?? 24) * 60 * 60 * 1000)
            : 0;

      const out: string[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < maxEntries; i--) {
        const line = lines[i];
        if (line === undefined) continue;
        let at: string | undefined;
        try {
          const parsed = JSON.parse(line) as { at?: string };
          at = parsed?.at;
        } catch {
          continue;
        }
        if (at === undefined) continue;
        const ts = new Date(at).getTime();
        if (Number.isNaN(ts) || ts < cutoffMs) continue;
        out.unshift(line);
      }
      return out;
    } catch {
      return [];
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.options.path);
      if (info.size < this.options.maxBytes) {
        return;
      }
      await rename(this.options.path, `${this.options.path}.1`);
    } catch {
      // File may not exist yet; no rotation needed.
    }
  }
}

function formatEntry(entry: DecisionJournalEntry): string {
  const payload = {
    at: new Date().toISOString(),
    type: entry.type,
    summary: entry.summary,
    detail: entry.detail,
    metadata: entry.metadata
  };
  return JSON.stringify(payload);
}
