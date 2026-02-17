import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { toLine } from "../src/memory.js";
import { runMemoryCompaction, shouldRunCompaction } from "../src/continuity/memory-compaction.js";
import type { MemoryRecord } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function makeRecord(text: string, daysAgo: number): MemoryRecord {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return {
    id: `id-${daysAgo}`,
    sessionId: "s1",
    category: "turn-summary",
    text,
    provenance: {
      sourceChannel: "user",
      confidence: 1,
      timestamp: d.toISOString(),
      sensitivity: "public"
    }
  };
}

const MEMORY_HEADER = `# MEMORY.md — Long-term memory

---

`;

describe("memory compaction", () => {
  it("shouldRunCompaction returns false when under threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compaction-under-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "MEMORY.md"),
      MEMORY_HEADER + toLine(makeRecord("one", 1)) + "\n",
      "utf8"
    );
    const { shouldRun } = await shouldRunCompaction(dir, { maxRecords: 100, maxChars: 10000 });
    expect(shouldRun).toBe(false);
  });

  it("shouldRunCompaction returns true when over maxRecords", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compaction-over-"));
    tempDirs.push(dir);
    const lines = [MEMORY_HEADER];
    for (let i = 0; i < 15; i++) lines.push(toLine(makeRecord(`r${i}`, 20)) + "\n");
    await writeFile(join(dir, "MEMORY.md"), lines.join(""), "utf8");
    const { shouldRun, recordCount } = await shouldRunCompaction(dir, { maxRecords: 10 });
    expect(recordCount).toBe(15);
    expect(shouldRun).toBe(true);
  });

  it("runMemoryCompaction merges old compactable records and writes LONGMEMORY", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compaction-run-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "memory"), { recursive: true });
    const lines = [MEMORY_HEADER];
    for (let i = 0; i < 12; i++) lines.push(toLine(makeRecord(`old summary ${i}`, 10)) + "\n");
    lines.push(toLine(makeRecord("recent", 0)) + "\n");
    await writeFile(join(dir, "MEMORY.md"), lines.join(""), "utf8");

    const result = await runMemoryCompaction({
      workspaceDir: dir,
      minAgeDays: 7,
      maxRecords: 5,
      longMemoryPath: "LONGMEMORY.md",
      longMemoryMaxChars: 20_000,
      onAfterCompaction: async () => {}
    });

    expect(result.ran).toBe(true);
    expect(result.recordsCompacted).toBe(12);
    expect(result.recordsAfter).toBeLessThanOrEqual(2);
    expect(result.longMemoryAppended).toBe(true);

    const memoryContent = await readFile(join(dir, "MEMORY.md"), "utf8");
    const longContent = await readFile(join(dir, "LONGMEMORY.md"), "utf8");
    expect(memoryContent).toContain("compaction");
    expect(memoryContent).toContain("recent");
    expect(longContent).toContain("Summary");
    expect(longContent).toContain("old summary");
  });

  it("runMemoryCompaction skips when lock is held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compaction-lock-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "tmp"), { recursive: true });
    await writeFile(join(dir, "tmp", "memory-compaction.lock"), "12345", "utf8");
    const lines = [MEMORY_HEADER];
    for (let i = 0; i < 15; i++) lines.push(toLine(makeRecord(`r${i}`, 10)) + "\n");
    await writeFile(join(dir, "MEMORY.md"), lines.join(""), "utf8");

    const result = await runMemoryCompaction({
      workspaceDir: dir,
      minAgeDays: 7,
      maxRecords: 5,
      longMemoryPath: "LONGMEMORY.md",
      longMemoryMaxChars: 20_000
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toBe("lock held");
  });
});
