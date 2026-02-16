import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../src/memory.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function makeRecord(text: string, sessionId = "s1") {
  return {
    sessionId,
    category: "note" as const,
    text,
    provenance: {
      sourceChannel: "user" as const,
      confidence: 1,
      timestamp: new Date().toISOString(),
      sensitivity: "public" as const
    }
  };
}

describe("memory rolling window", () => {
  it("does not trim when rolling window is not configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-rw-none-"));
    tempDirs.push(dir);
    const memory = new MemoryStore({ workspaceDir: dir });
    await memory.init();
    for (let i = 0; i < 5; i++) {
      await memory.append(makeRecord(`record ${i}`));
    }
    const all = await memory.readAll();
    expect(all).toHaveLength(5);
  });

  it("trims oldest records when over memoryMaxRecords", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-rw-maxrec-"));
    tempDirs.push(dir);
    const memory = new MemoryStore({
      workspaceDir: dir,
      rollingWindow: { maxRecords: 3 }
    });
    await memory.init();
    for (let i = 0; i < 5; i++) {
      await memory.append(makeRecord(`record ${i}`));
    }
    const all = await memory.readAll();
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.text)).toEqual(["record 2", "record 3", "record 4"]);
  });

  it("trims oldest records when over memoryMaxChars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-rw-maxchars-"));
    tempDirs.push(dir);
    const memory = new MemoryStore({
      workspaceDir: dir,
      rollingWindow: { maxChars: 600 }
    });
    await memory.init();
    await memory.append(makeRecord("short"));
    await memory.append(makeRecord("x".repeat(100)));
    await memory.append(makeRecord("y".repeat(100)));
    const all = await memory.readAll();
    expect(all.length).toBeLessThanOrEqual(2);
    const content = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(content.length).toBeLessThanOrEqual(650);
  });

  it("appends trimmed lines to archive when memoryArchivePath is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-rw-archive-"));
    tempDirs.push(dir);
    const archivePath = "memory/MEMORY-archive.md";
    const memory = new MemoryStore({
      workspaceDir: dir,
      rollingWindow: { maxRecords: 2, archivePath }
    });
    await memory.init();
    await memory.append(makeRecord("first"));
    await memory.append(makeRecord("second"));
    await memory.append(makeRecord("third"));
    const all = await memory.readAll();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.text)).toEqual(["second", "third"]);
    const archive = await readFile(join(dir, archivePath), "utf8");
    expect(archive).toContain("first");
    expect(archive).not.toContain("third");
  });

  it("calls onTrim after trim when provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-rw-ontrim-"));
    tempDirs.push(dir);
    let trimCalled = false;
    const memory = new MemoryStore({
      workspaceDir: dir,
      rollingWindow: {
        maxRecords: 2,
        onTrim: async () => {
          trimCalled = true;
        }
      }
    });
    await memory.init();
    await memory.append(makeRecord("a"));
    expect(trimCalled).toBe(false);
    await memory.append(makeRecord("b"));
    expect(trimCalled).toBe(false);
    await memory.append(makeRecord("c"));
    expect(trimCalled).toBe(true);
  });

  it("calls getSyncAfterTrim at trim time (resolved when trim runs)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-rw-getSync-"));
    tempDirs.push(dir);
    let syncCalled = false;
    const memory = new MemoryStore({
      workspaceDir: dir,
      rollingWindow: {
        maxRecords: 2,
        getSyncAfterTrim: () => () => {
          syncCalled = true;
          return Promise.resolve();
        }
      }
    });
    await memory.init();
    await memory.append(makeRecord("a"));
    expect(syncCalled).toBe(false);
    await memory.append(makeRecord("b"));
    expect(syncCalled).toBe(false);
    await memory.append(makeRecord("c"));
    expect(syncCalled).toBe(true);
  });

  it("preserves MEMORY.md header when trimming", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-rw-header-"));
    tempDirs.push(dir);
    const memory = new MemoryStore({
      workspaceDir: dir,
      rollingWindow: { maxRecords: 1 }
    });
    await memory.init();
    await memory.append(makeRecord("one"));
    await memory.append(makeRecord("two"));
    const content = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(content).toMatch(/^# MEMORY.md — Long-term memory/);
    const all = await memory.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.text).toBe("two");
  });
});
