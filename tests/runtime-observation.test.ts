import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeObservationStore } from "../src/runtime-observation.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("runtime observation store", () => {
  it("persists observations with bounded retention", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-observations-"));
    tempDirs.push(dir);
    const stateFile = join(dir, "observations.json");
    const store = new RuntimeObservationStore({
      maxEvents: 2,
      stateFile
    });
    await store.append({
      sessionId: "s1",
      source: "runtime",
      kind: "error",
      sensitivity: "operational",
      payload: { message: "first" }
    });
    await store.append({
      sessionId: "s1",
      source: "runtime",
      kind: "error",
      sensitivity: "operational",
      payload: { message: "second" }
    });
    await store.append({
      sessionId: "s1",
      source: "runtime",
      kind: "error",
      sensitivity: "operational",
      payload: { message: "third" }
    });

    const reloaded = new RuntimeObservationStore({
      maxEvents: 2,
      stateFile
    });
    await reloaded.load();
    const recent = await reloaded.listRecent({
      sessionId: "s1",
      limit: 10
    });
    expect(recent.length).toBe(2);
    expect(JSON.stringify(recent[0]?.payload)).toContain("second");
    expect(JSON.stringify(recent[1]?.payload)).toContain("third");
  });

  it("truncates oversized observation payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-observations-size-"));
    tempDirs.push(dir);
    const store = new RuntimeObservationStore({
      maxEvents: 10,
      stateFile: join(dir, "observations.json")
    });
    const oversized = "x".repeat(50_000);
    const saved = await store.append({
      sessionId: "s1",
      source: "runtime",
      kind: "oversized",
      sensitivity: "operational",
      payload: oversized
    });
    expect(typeof saved.payload).toBe("string");
    expect(String(saved.payload).length).toBeLessThan(21_000);
  });

  it("sanitizes malformed/unserializable payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-observations-malformed-"));
    tempDirs.push(dir);
    const store = new RuntimeObservationStore({
      maxEvents: 10,
      stateFile: join(dir, "observations.json")
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const saved = await store.append({
      sessionId: "s1",
      source: "runtime",
      kind: "malformed",
      sensitivity: "operational",
      payload: circular
    });
    expect(saved.payload).toBe("[unserializable observation payload]");
  });
});
