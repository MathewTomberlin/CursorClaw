import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendTopic, loadRecentTopicsContext } from "../src/continuity/recent-topics.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("recent-topics", () => {
  it("returns undefined when no topics stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recent-topics-empty-"));
    tempDirs.push(dir);
    const out = await loadRecentTopicsContext(dir);
    expect(out).toBeUndefined();
  });

  it("appends topic and loads formatted context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recent-topics-"));
    tempDirs.push(dir);
    await appendTopic(dir, "session-1", "First conversation starter here");
    const out = await loadRecentTopicsContext(dir);
    expect(out).toBeDefined();
    expect(out).toContain("1. First conversation starter here");
  });

  it("keeps last N entries and caps topic length", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recent-topics-cap-"));
    tempDirs.push(dir);
    for (let i = 0; i < 12; i++) {
      await appendTopic(dir, `session-${i}`, `Topic ${i}`, { maxEntries: 10 });
    }
    const out = await loadRecentTopicsContext(dir, { maxEntries: 10 });
    expect(out).toBeDefined();
    expect(out!.split("\n").length).toBeLessThanOrEqual(10);
  });

  it("updates existing session entry in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recent-topics-update-"));
    tempDirs.push(dir);
    await appendTopic(dir, "session-a", "First topic");
    await appendTopic(dir, "session-a", "Updated topic");
    const out = await loadRecentTopicsContext(dir);
    expect(out).toBeDefined();
    expect(out).toContain("Updated topic");
    expect(out).not.toContain("First topic");
    expect(out!.split("\n").length).toBe(1);
  });
});
