import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactSecrets } from "../security.js";

export interface SemanticSummaryRecord {
  id: string;
  workspace: string;
  repo: string;
  modulePath: string;
  summary: string;
  symbols: string[];
  contentHash: string;
  updatedAt: string;
  version: number;
}

export interface SemanticSummaryCacheOptions {
  stateFile: string;
  maxEntries: number;
}

interface PersistedSummaryState {
  version: number;
  records: SemanticSummaryRecord[];
}

const SUMMARY_STATE_VERSION = 1;

export class SemanticSummaryCache {
  private readonly records = new Map<string, SemanticSummaryRecord>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: SemanticSummaryCacheOptions) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await readFile(this.options.stateFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedSummaryState;
      if (!Array.isArray(parsed.records)) {
        return;
      }
      for (const record of parsed.records) {
        if (!record?.modulePath || !record.workspace || !record.repo) {
          continue;
        }
        this.records.set(this.keyFor(record.workspace, record.repo, record.modulePath), {
          ...record,
          symbols: Array.isArray(record.symbols) ? [...record.symbols] : []
        });
      }
    } catch {
      // no-op, cache file may not exist yet
    }
  }

  async upsertFromSource(args: {
    workspace: string;
    repo: string;
    modulePath: string;
    sourceText: string;
  }): Promise<SemanticSummaryRecord> {
    await this.ensureLoaded();
    const key = this.keyFor(args.workspace, args.repo, args.modulePath);
    const contentHash = hashText(args.sourceText);
    const existing = this.records.get(key);
    if (existing && existing.contentHash === contentHash) {
      return { ...existing };
    }
    const record: SemanticSummaryRecord = {
      id: existing?.id ?? randomUUID(),
      workspace: args.workspace,
      repo: args.repo,
      modulePath: args.modulePath,
      summary: buildModuleSummary(args.sourceText),
      symbols: extractSymbols(args.sourceText),
      contentHash,
      updatedAt: new Date().toISOString(),
      version: SUMMARY_STATE_VERSION
    };
    this.records.set(key, record);
    this.trimToCapacity();
    await this.persist();
    return { ...record };
  }

  async get(args: {
    workspace: string;
    repo: string;
    modulePath: string;
  }): Promise<SemanticSummaryRecord | undefined> {
    await this.ensureLoaded();
    const record = this.records.get(this.keyFor(args.workspace, args.repo, args.modulePath));
    if (!record) {
      return undefined;
    }
    return { ...record };
  }

  async list(args?: {
    workspace?: string;
    repo?: string;
    limit?: number;
  }): Promise<SemanticSummaryRecord[]> {
    await this.ensureLoaded();
    const limit = Math.max(1, Math.min(2_000, args?.limit ?? 200));
    const out = [...this.records.values()]
      .filter((record) => {
        if (args?.workspace && record.workspace !== args.workspace) {
          return false;
        }
        if (args?.repo && record.repo !== args.repo) {
          return false;
        }
        return true;
      })
      .sort((lhs, rhs) => rhs.updatedAt.localeCompare(lhs.updatedAt))
      .slice(0, limit)
      .map((record) => ({ ...record }));
    return out;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  private keyFor(workspace: string, repo: string, modulePath: string): string {
    return `${workspace}:${repo}:${modulePath}`;
  }

  private trimToCapacity(): void {
    if (this.records.size <= this.options.maxEntries) {
      return;
    }
    const toDrop = [...this.records.entries()]
      .sort((lhs, rhs) => lhs[1].updatedAt.localeCompare(rhs[1].updatedAt))
      .slice(0, this.records.size - this.options.maxEntries);
    for (const [key] of toDrop) {
      this.records.delete(key);
    }
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.stateFile), { recursive: true });
      const payload: PersistedSummaryState = {
        version: SUMMARY_STATE_VERSION,
        records: [...this.records.values()]
      };
      await writeFile(this.options.stateFile, JSON.stringify(payload, null, 2), "utf8");
    });
    await this.writeChain;
  }
}

function buildModuleSummary(sourceText: string): string {
  const redacted = redactSecrets(sourceText);
  const lines = redacted
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const signalLines = lines
    .filter((line) => /^(export\s+)?(class|function|interface|type|const)\b/.test(line))
    .slice(0, 8);
  const fallback = lines.slice(0, 8);
  const selected = signalLines.length > 0 ? signalLines : fallback;
  const summary = selected.join(" | ");
  return summary.slice(0, 1_200);
}

function extractSymbols(sourceText: string): string[] {
  const symbols = new Set<string>();
  const symbolPattern = /\b(class|function|interface|type|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null = symbolPattern.exec(sourceText);
  while (match !== null) {
    const symbolName = match[2];
    if (symbolName) {
      symbols.add(symbolName);
    }
    match = symbolPattern.exec(sourceText);
  }
  return [...symbols].slice(0, 40);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
