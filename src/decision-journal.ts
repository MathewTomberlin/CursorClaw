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
