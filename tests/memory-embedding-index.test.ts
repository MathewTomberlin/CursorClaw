import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryEmbeddingIndex } from "../src/continuity/memory-embedding-index.js";
import type { MemoryRecord } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function record(id: string, text: string, category = "note"): MemoryRecord {
  return {
    id,
    sessionId: "test",
    category,
    text,
    provenance: { sourceChannel: "test", confidence: 1, timestamp: new Date().toISOString(), sensitivity: "operational" }
  };
}

describe("MemoryEmbeddingIndex", () => {
  it("returns empty query result when no records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-emb-empty-"));
    tempDirs.push(dir);
    const index = new MemoryEmbeddingIndex({
      stateFile: join(dir, "memory-embeddings.json"),
      maxRecords: 100
    });
    await index.load();
    const results = await index.query({ query: "anything", topK: 5 });
    expect(results).toEqual([]);
  });

  it("upserts records and returns semantically similar results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-emb-"));
    tempDirs.push(dir);
    const index = new MemoryEmbeddingIndex({
      stateFile: join(dir, "memory-embeddings.json"),
      maxRecords: 100
    });
    await index.load();
    await index.upsertFromRecords([
      record("1", "Operator prefers deployment on Fridays"),
      record("2", "The project uses TypeScript and Vitest"),
      record("3", "Pizza is the team lunch preference")
    ]);
    const results = await index.query({ query: "deployment preferences", topK: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.recordId && r.text && typeof r.score === "number")).toBe(true);
    const top = results[0];
    expect(top).toBeDefined(); expect(top!.text).toContain("deployment");
  });

  it("excludes secret records when allowSecret is false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-emb-secret-"));
    tempDirs.push(dir);
    const index = new MemoryEmbeddingIndex({
      stateFile: join(dir, "memory-embeddings.json"),
      maxRecords: 100
    });
    await index.load();
    const secretRecord = record("s1", "API key is secret123");
    secretRecord.provenance.sensitivity = "secret";
    await index.upsertFromRecords([record("1", "Public note"), secretRecord], false);
    const results = await index.query({ query: "API key secret", topK: 5 });
    expect(results.map((r) => r.text)).not.toContain("secret123");
  });

  it("respects topK", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-emb-topk-"));
    tempDirs.push(dir);
    const index = new MemoryEmbeddingIndex({
      stateFile: join(dir, "memory-embeddings.json"),
      maxRecords: 100
    });
    await index.load();
    const records: MemoryRecord[] = Array.from({ length: 10 }, (_, i) =>
      record(`id-${i}`, `document number ${i} with some words`)
    );
    await index.upsertFromRecords(records);
    const results = await index.query({ query: "document", topK: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
