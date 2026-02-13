import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { MemoryRecord, SensitivityLabel } from "./types.js";

export interface MemoryStoreOptions {
  workspaceDir: string;
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

  constructor(private readonly options: MemoryStoreOptions) {
    this.memoryDir = join(options.workspaceDir, "memory");
    this.primaryFile = join(options.workspaceDir, "MEMORY.md");
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
    return materialized;
  }

  async readAll(): Promise<MemoryRecord[]> {
    await this.init();
    const content = await readFile(this.primaryFile, "utf8");
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
