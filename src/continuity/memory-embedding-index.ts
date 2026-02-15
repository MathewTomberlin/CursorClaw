import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { safeReadUtf8 } from "../fs-utils.js";
import type { MemoryRecord } from "../types.js";

export interface MemoryChunk {
  id: string;
  recordId: string;
  text: string;
  category: string;
  sessionId: string;
  updatedAt: string;
  vector: number[];
}

export interface MemoryEmbeddingIndexOptions {
  stateFile: string;
  maxRecords: number;
  dimensions?: number;
}

export interface MemoryRecallResult {
  recordId: string;
  text: string;
  category: string;
  score: number;
}

interface PersistedMemoryIndex {
  version: number;
  chunks: MemoryChunk[];
}

const INDEX_VERSION = 1;
const DEFAULT_DIMENSIONS = 128;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((token) => token.length >= 2)
    .slice(0, 2_000);
}

function tokenHash(token: string, dimensions: number): number {
  const digest = createHash("sha1").update(token).digest();
  return digest.readUInt32BE(0) % dimensions;
}

function computeVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const index = tokenHash(token, dimensions);
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0));
  if (norm <= 0) return vector;
  return vector.map((value) => value / norm);
}

function cosineSimilarity(lhs: number[], rhs: number[]): number {
  let dot = 0;
  const size = Math.min(lhs.length, rhs.length);
  for (let index = 0; index < size; index += 1) {
    dot += (lhs[index] ?? 0) * (rhs[index] ?? 0);
  }
  return dot;
}

/** Optional embedding index over memory records for semantic recall. Profile-scoped; same hash-based vector approach as code index. */
export class MemoryEmbeddingIndex {
  private readonly chunks = new Map<string, MemoryChunk>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly dimensions: number;

  constructor(private readonly options: MemoryEmbeddingIndexOptions) {
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await safeReadUtf8(this.options.stateFile, { maxChars: 5_000_000 });
      if (raw == null) return;
      const parsed = JSON.parse(raw) as PersistedMemoryIndex;
      if (!Array.isArray(parsed.chunks)) return;
      for (const chunk of parsed.chunks) {
        if (!chunk?.recordId || typeof chunk.text !== "string") continue;
        if (!Array.isArray(chunk.vector)) continue;
        this.chunks.set(chunk.recordId, {
          ...chunk,
          vector: chunk.vector.slice(0, this.dimensions)
        });
      }
    } catch {
      // no persisted file yet
    }
  }

  /** Replace index with current memory records. Call after readAll() to sync. */
  async upsertFromRecords(records: MemoryRecord[], allowSecret = false): Promise<void> {
    await this.ensureLoaded();
    const updatedAt = new Date().toISOString();
    const byId = new Map<string, MemoryChunk>();
    for (const record of records) {
      if (record.provenance?.sensitivity === "secret" && !allowSecret) continue;
      const text = record.text?.trim() || "";
      if (text.length === 0) continue;
      const vector = computeVector(text, this.dimensions);
      byId.set(record.id, {
        id: record.id,
        recordId: record.id,
        text,
        category: record.category ?? "",
        sessionId: record.sessionId ?? "",
        updatedAt,
        vector
      });
    }
    this.chunks.clear();
    for (const [id, chunk] of byId) {
      this.chunks.set(id, chunk);
    }
    this.trimToCapacity();
    await this.persist();
  }

  async query(args: { query: string; topK: number }): Promise<MemoryRecallResult[]> {
    await this.ensureLoaded();
    const queryVector = computeVector(args.query, this.dimensions);
    const topK = Math.max(1, Math.min(50, args.topK));
    const matches: MemoryRecallResult[] = [];
    for (const chunk of this.chunks.values()) {
      const score = cosineSimilarity(queryVector, chunk.vector);
      if (score <= 0) continue;
      matches.push({
        recordId: chunk.recordId,
        text: chunk.text,
        category: chunk.category,
        score
      });
    }
    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private trimToCapacity(): void {
    if (this.chunks.size <= this.options.maxRecords) return;
    const stale = [...this.chunks.entries()]
      .sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
      .slice(0, this.chunks.size - this.options.maxRecords);
    for (const [key] of stale) this.chunks.delete(key);
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.stateFile), { recursive: true });
      const payload: PersistedMemoryIndex = {
        version: INDEX_VERSION,
        chunks: [...this.chunks.values()].map((c) => ({ ...c, vector: [...c.vector] }))
      };
      await writeFile(this.options.stateFile, JSON.stringify(payload, null, 2), "utf8");
    });
    await this.writeChain;
  }
}
