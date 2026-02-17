import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSessionMemoryContext } from "../src/continuity/session-memory.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("session-memory", () => {
  it("returns undefined when no memory files exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-memory-empty-"));
    tempDirs.push(dir);
    const out = await loadSessionMemoryContext(dir, { today: "2026-02-15" });
    expect(out).toBeUndefined();
  });

  it("loads MEMORY.md and daily files and combines with labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-memory-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "MEMORY.md"), "Long-term note.\n", "utf8");
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(join(dir, "memory", "2026-02-15.md"), "Today log.\n", "utf8");
    await writeFile(join(dir, "memory", "2026-02-14.md"), "Yesterday log.\n", "utf8");
    const out = await loadSessionMemoryContext(dir, { today: "2026-02-15" });
    expect(out).toBeDefined();
    expect(out).toContain("Long-term memory (MEMORY.md)");
    expect(out).toContain("Long-term note.");
    expect(out).toContain("Daily memory (2026-02-14)");
    expect(out).toContain("Yesterday log.");
    expect(out).toMatch(/Daily memory \(\d{4}-\d{2}-\d{2}\)/);
  });

  it("truncates when over capChars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-memory-cap-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "MEMORY.md"), "x".repeat(500), "utf8");
    const suffix = "\n\n[... truncated for length]";
    const out = await loadSessionMemoryContext(dir, { today: "2026-02-15", capChars: 100 });
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(100 + suffix.length + 5);
    expect(out).toContain("truncated for length");
  });

  it("includes LONGMEMORY.md first when includeLongMemory true and file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-memory-long-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "LONGMEMORY.md"), "# Long-term summary\n\nSummary block.\n", "utf8");
    await writeFile(join(dir, "MEMORY.md"), "Recent memory.\n", "utf8");
    const out = await loadSessionMemoryContext(dir, { today: "2026-02-15", includeLongMemory: true });
    expect(out).toBeDefined();
    expect(out).toContain("Long-term summary (LONGMEMORY)");
    expect(out).toContain("Summary block.");
    expect(out).toContain("Long-term memory (MEMORY.md)");
    expect(out).toContain("Recent memory.");
    expect(out!.indexOf("LONGMEMORY")).toBeLessThan(out!.indexOf("MEMORY.md"));
  });

  it("omits LONGMEMORY when includeLongMemory false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-memory-nolong-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "LONGMEMORY.md"), "Summary.\n", "utf8");
    await writeFile(join(dir, "MEMORY.md"), "Memory.\n", "utf8");
    const out = await loadSessionMemoryContext(dir, { today: "2026-02-15", includeLongMemory: false });
    expect(out).toBeDefined();
    expect(out).not.toContain("LONGMEMORY");
    expect(out).toContain("Memory.");
  });
});
