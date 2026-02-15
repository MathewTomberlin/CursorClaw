import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { safeReadUtf8 } from "./fs-utils.js";
import type { MemoryRecord, SensitivityLabel } from "./types.js";

/** Optional rolling window: when MEMORY.md exceeds maxRecords or maxChars, oldest records are trimmed (primary file only; daily files unchanged). */
export interface RollingWindowOptions {
  maxRecords?: number;
  maxChars?: number;
  /** If set, trimmed lines are appended here (e.g. "memory/MEMORY-archive.md"). */
  archivePath?: string;
  /** Called after trim so the caller can re-sync e.g. the memory embedding index. */
  onTrim?: () => Promise<void>;
}

export interface MemoryStoreOptions {
  workspaceDir: string;
  /** When set, MEMORY.md is trimmed after append when over limit. Default off. */
  rollingWindow?: RollingWindowOptions;
}

export interface IntegrityFinding {
  recordId: string;
  severity: "warning" | "error";
  issue: string;
}

function todayFileName(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function toLine(record: MemoryRecord): string {
  const payload = {
    id: record.id,
    sessionId: record.sessionId,
    category: record.category,
    text: record.text,
    provenance: record.provenance
  };
  return `- ${JSON.stringify(payload)}`;
}

function parseLine(line: string): MemoryRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- ")) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(2)) as MemoryRecord;
  } catch {
    return null;
  }
}

export class MemoryStore {
  private readonly memoryDir: string;
  private readonly primaryFile: string;
  private readonly rollingWindow: RollingWindowOptions | undefined;

  constructor(private readonly options: MemoryStoreOptions) {
    this.memoryDir = join(options.workspaceDir, "memory");
    this.primaryFile = join(options.workspaceDir, "MEMORY.md");
    this.rollingWindow = options.rollingWindow;
  }

  async init(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    try {
      await stat(this.primaryFile);
    } catch {
      await writeFile(this.primaryFile, "# CursorClaw Memory\n\n", "utf8");
    }
  }

  async append(record: Omit<MemoryRecord, "id">): Promise<MemoryRecord> {
    const materialized: MemoryRecord = { id: randomUUID(), ...record };
    await this.init();
    const dailyFile = join(this.memoryDir, `${todayFileName()}.md`);
    const line = `${toLine(materialized)}\n`;
    await writeFile(this.primaryFile, line, { encoding: "utf8", flag: "a" });
    await writeFile(dailyFile, line, { encoding: "utf8", flag: "a" });
    await this.maybeTrimAfterAppend();
    return materialized;
  }

  /** When rolling window is configured and primary file is over limit, trim oldest from MEMORY.md only; optionally archive; call onTrim. */
  private async maybeTrimAfterAppend(): Promise<void> {
    const rw = this.rollingWindow;
    if (!rw || (rw.maxRecords == null && rw.maxChars == null)) return;

    const content = await safeReadUtf8(this.primaryFile);
    if (content == null) return;

    const lines = content.split("\n");
    let firstRecordIndex = 0;
    while (firstRecordIndex < lines.length && parseLine(lines[firstRecordIndex]!) == null) {
      firstRecordIndex += 1;
    }
    const headerLines = lines.slice(0, firstRecordIndex);
    const recordLines = lines.slice(firstRecordIndex).filter((l) => parseLine(l) != null);
    const header = headerLines.length ? headerLines.join("\n") + "\n" : "";

    let dropCount = 0;
    if (rw.maxRecords != null && recordLines.length > rw.maxRecords) {
      dropCount = Math.max(dropCount, recordLines.length - rw.maxRecords);
    }
    if (rw.maxChars != null) {
      let totalChars = header.length;
      for (const l of recordLines) totalChars += l.length + 1;
      let fromFront = 0;
      while (totalChars > rw.maxChars! && fromFront < recordLines.length) {
        totalChars -= (recordLines[fromFront]!.length + 1);
        fromFront += 1;
      }
      dropCount = Math.max(dropCount, fromFront);
    }
    if (dropCount <= 0) return;

    const toDrop = recordLines.slice(0, dropCount);
    const toKeep = recordLines.slice(dropCount);
    const newContent = header + toKeep.map((l) => l + "\n").join("");

    await writeFile(this.primaryFile, newContent, "utf8");
    if (rw.archivePath) {
      const archiveFull = join(this.options.workspaceDir, rw.archivePath);
      await mkdir(dirname(archiveFull), { recursive: true });
      await writeFile(archiveFull, toDrop.map((l) => l + "\n").join(""), { encoding: "utf8", flag: "a" });
    }
    await rw.onTrim?.();
  }

  async readAll(): Promise<MemoryRecord[]> {
    await this.init();
    const content = await safeReadUtf8(this.primaryFile);
    if (content == null) return [];
    return content
      .split("\n")
      .map(parseLine)
      .filter((item): item is MemoryRecord => Boolean(item));
  }

  async retrieveForSession(args: {
    sessionId: string;
    allowSecret?: boolean;
  }): Promise<MemoryRecord[]> {
    const all = await this.readAll();
    return all.filter((record) => {
      if (record.sessionId !== args.sessionId) {
        return false;
      }
      if (record.provenance.sensitivity === "secret" && !args.allowSecret) {
        return false;
      }
      return true;
    });
  }

  async flushPreCompaction(sessionId: string): Promise<void> {
    await this.append({
      sessionId,
      category: "compaction",
      text: "Pre-compaction memory flush checkpoint",
      provenance: {
        sourceChannel: "system",
        confidence: 1,
        timestamp: new Date().toISOString(),
        sensitivity: "operational"
      }
    });
  }

  async integrityScan(): Promise<IntegrityFinding[]> {
    const all = await this.readAll();
    const findings: IntegrityFinding[] = [];
    const seenFacts = new Map<string, { text: string; id: string }>();
    for (const record of all) {
      const key = `${record.sessionId}:${record.category}`;
      const prior = seenFacts.get(key);
      if (prior && prior.text !== record.text) {
        findings.push({
          recordId: record.id,
          severity: "warning",
          issue: `Potential contradiction with ${prior.id} in category ${record.category}`
        });
      } else {
        seenFacts.set(key, { text: record.text, id: record.id });
      }

      if (Date.now() - Date.parse(record.provenance.timestamp) > 1000 * 60 * 60 * 24 * 120) {
        findings.push({
          recordId: record.id,
          severity: "warning",
          issue: "Stale memory record older than 120 days"
        });
      }
    }
    return findings;
  }
}

export function validateSensitivity(label: string): label is SensitivityLabel {
  return ["public", "private-user", "secret", "operational"].includes(label);
}
