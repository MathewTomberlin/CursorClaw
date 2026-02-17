import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { safeReadUtf8 } from "../fs-utils.js";
import { parseLine, toLine } from "../memory.js";
import type { MemoryRecord } from "../types.js";

const LOCK_FILE = "tmp/memory-compaction.lock";
const COMPACTION_CATEGORY = "compaction";

/** Categories that are compacted when old (merged into a single compaction record). */
const COMPACTABLE_CATEGORIES = new Set(["turn-summary", "note"]);
/** Categories that are never compacted away; always kept as-is. */
const KEEP_ALWAYS_CATEGORIES = new Set(["learned", "user-preference", "compaction"]);

export interface MemoryCompactionOptions {
  workspaceDir: string;
  /** Only compact records older than this many days. */
  minAgeDays: number;
  /** Target max records in MEMORY.md after compaction; run when over this. */
  maxRecords?: number;
  /** Target max chars for MEMORY.md after compaction; run when over this. */
  maxChars?: number;
  /** Path under workspace for long-term summary file (e.g. LONGMEMORY.md). */
  longMemoryPath: string;
  /** Max chars for LONGMEMORY.md; trim oldest blocks when over. */
  longMemoryMaxChars: number;
  /** When set, append trimmed record lines here (under workspaceDir). */
  archivePath?: string;
  /** Call after compaction to re-sync e.g. memory embedding index. */
  onAfterCompaction?: () => Promise<void>;
}

export interface MemoryCompactionResult {
  ran: boolean;
  reason?: string;
  recordsBefore: number;
  recordsAfter: number;
  recordsCompacted: number;
  longMemoryAppended: boolean;
}

/**
 * Run memory compaction: merge old compactable records into one or more compaction records,
 * write LONGMEMORY.md summary, rewrite MEMORY.md. Uses a lock file so only one compaction
 * runs at a time. Does not modify memory/YYYY-MM-DD.md daily files.
 */
export async function runMemoryCompaction(
  options: MemoryCompactionOptions
): Promise<MemoryCompactionResult> {
  const primaryFile = join(options.workspaceDir, "MEMORY.md");
  const lockPath = join(options.workspaceDir, LOCK_FILE);

  const acquireLock = async (): Promise<boolean> => {
    try {
      await stat(lockPath);
      return false;
    } catch {
      // lock file does not exist
    }
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      await writeFile(lockPath, process.pid.toString(), "utf8");
      return true;
    } catch {
      return false;
    }
  };

  const releaseLock = async (): Promise<void> => {
    try {
      await unlink(lockPath);
    } catch {
      // ignore
    }
  };

  const content = await safeReadUtf8(primaryFile);
  if (content == null || content.trim().length === 0) {
    return { ran: false, reason: "no memory file", recordsBefore: 0, recordsAfter: 0, recordsCompacted: 0, longMemoryAppended: false };
  }

  const lines = content.split("\n");
  let firstRecordIndex = 0;
  while (firstRecordIndex < lines.length && parseLine(lines[firstRecordIndex]!) == null) {
    firstRecordIndex += 1;
  }
  const headerLines = lines.slice(0, firstRecordIndex);
  const header = headerLines.length ? headerLines.join("\n") + "\n" : "";
  const recordLines = lines.slice(firstRecordIndex);
  const records: MemoryRecord[] = [];
  for (const line of recordLines) {
    const rec = parseLine(line);
    if (rec) records.push(rec);
  }

  const totalChars = content.length;
  const overMaxRecords = options.maxRecords != null && records.length > options.maxRecords;
  const overMaxChars = options.maxChars != null && totalChars > options.maxChars;
  if (!overMaxRecords && !overMaxChars) {
    return {
      ran: false,
      reason: "under threshold",
      recordsBefore: records.length,
      recordsAfter: records.length,
      recordsCompacted: 0,
      longMemoryAppended: false
    };
  }

  const acquired = await acquireLock();
  if (!acquired) {
    return {
      ran: false,
      reason: "lock held",
      recordsBefore: records.length,
      recordsAfter: records.length,
      recordsCompacted: 0,
      longMemoryAppended: false
    };
  }

  try {
    const now = Date.now();
    const minAgeMs = options.minAgeDays * 24 * 60 * 60 * 1000;

    const toCompact: MemoryRecord[] = [];
    const toKeep: MemoryRecord[] = [];

    for (const rec of records) {
      if (KEEP_ALWAYS_CATEGORIES.has(rec.category)) {
        toKeep.push(rec);
        continue;
      }
      const ts = Date.parse(rec.provenance.timestamp);
      if (Number.isNaN(ts) || now - ts < minAgeMs) {
        toKeep.push(rec);
        continue;
      }
      if (COMPACTABLE_CATEGORIES.has(rec.category)) {
        toCompact.push(rec);
      } else {
        toKeep.push(rec);
      }
    }

    if (toCompact.length === 0) {
      return {
        ran: true,
        reason: "nothing to compact",
        recordsBefore: records.length,
        recordsAfter: records.length,
        recordsCompacted: 0,
        longMemoryAppended: false
      };
    }

    const summaryText = toCompact
      .map((r) => r.text)
      .filter((t) => t.trim().length > 0)
      .join("\n\n");
    const compactionRecord: MemoryRecord = {
      id: randomUUID(),
      sessionId: "system",
      category: COMPACTION_CATEGORY,
      text: summaryText.slice(0, 15000),
      provenance: {
        sourceChannel: "system",
        confidence: 1,
        timestamp: new Date().toISOString(),
        sensitivity: "operational"
      }
    };

    const newRecords = [compactionRecord, ...toKeep];
    const newContent = header + newRecords.map((r) => toLine(r) + "\n").join("");

    const backupPath = `${primaryFile}.compaction-backup`;
    await readFile(primaryFile, "utf8").then((body) => writeFile(backupPath, body, "utf8")).catch(() => {});

    const tmpPath = `${primaryFile}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(primaryFile), { recursive: true });
    await writeFile(tmpPath, newContent, "utf8");
    await rename(tmpPath, primaryFile);

    if (options.archivePath) {
      const archiveFull = join(options.workspaceDir, options.archivePath);
      await mkdir(dirname(archiveFull), { recursive: true });
      const toArchive = toCompact.map((r) => toLine(r) + "\n").join("");
      await writeFile(archiveFull, toArchive, { encoding: "utf8", flag: "a" });
    }

    const longMemoryFull = join(options.workspaceDir, options.longMemoryPath);
    const longMemoryBlock = `\n\n## Summary (${new Date().toISOString().slice(0, 10)})\n\n${summaryText.slice(0, 8000)}\n`;
    let longMemoryContent = await safeReadUtf8(longMemoryFull) ?? "# LONGMEMORY.md — Long-term summaries\n";
    longMemoryContent += longMemoryBlock;
    if (longMemoryContent.length > options.longMemoryMaxChars) {
      const blocks = longMemoryContent.split(/\n## Summary \(/);
      longMemoryContent = blocks[0]!;
      for (let i = blocks.length - 1; i >= 1; i--) {
        const block = "\n## Summary (" + blocks[i]!;
        if (longMemoryContent.length + block.length <= options.longMemoryMaxChars) {
          longMemoryContent += block;
        } else break;
      }
    }
    await mkdir(dirname(longMemoryFull), { recursive: true });
    await writeFile(longMemoryFull, longMemoryContent, "utf8");

    await options.onAfterCompaction?.();

    return {
      ran: true,
      recordsBefore: records.length,
      recordsAfter: newRecords.length,
      recordsCompacted: toCompact.length,
      longMemoryAppended: true
    };
  } finally {
    await releaseLock();
  }
}

/**
 * Check whether compaction should run (over threshold). Does not acquire lock or modify files.
 */
export async function shouldRunCompaction(
  workspaceDir: string,
  options: { maxRecords?: number; maxChars?: number }
): Promise<{ shouldRun: boolean; recordCount: number; charCount: number }> {
  const primaryFile = join(workspaceDir, "MEMORY.md");
  const content = await safeReadUtf8(primaryFile);
  if (content == null) return { shouldRun: false, recordCount: 0, charCount: 0 };
  const lines = content.split("\n");
  let count = 0;
  for (const line of lines) {
    if (parseLine(line)) count += 1;
  }
  const overRecords = options.maxRecords != null && count > options.maxRecords;
  const overChars = options.maxChars != null && content.length > options.maxChars;
  return {
    shouldRun: overRecords || overChars,
    recordCount: count,
    charCount: content.length
  };
}
