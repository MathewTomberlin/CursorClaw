import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { safeReadUtf8 } from "../fs-utils.js";

export interface Experience {
  id: string;
  text: string;
  category: string;
  sessionId: string;
  recordId?: string;
  timestamp: string;
  vector: number[];
}

export interface ExperienceQueryResult {
  id: string;
  text: string;
  category: string;
  sessionId: string;
  score: number;
}

interface PersistedExperienceStore {
  version: number;
  experiences: Experience[];
}

const STORE_VERSION = 1;
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

export interface ExperienceStoreOptions {
  stateFile: string;
  maxExperiences: number;
  dimensions?: number;
  /** Max similarity (0–1) above which an experience is considered duplicate. Default 0.85. */
  uniquenessThreshold?: number;
}

/**
 * Local vector store for experiences (hash-based vectors, same approach as memory-embedding-index).
 * Persisted to JSON under profile. Can be replaced with Chroma when a local Chroma server or
 * embedded bindings are used; interface is kept for that swap.
 */
export class ExperienceStore {
  private readonly experiences = new Map<string, Experience>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly dimensions: number;
  private readonly uniquenessThreshold: number;

  constructor(private readonly options: ExperienceStoreOptions) {
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.uniquenessThreshold = options.uniquenessThreshold ?? 0.85;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await safeReadUtf8(this.options.stateFile, { maxChars: 10_000_000 });
      if (raw == null) return;
      const parsed = JSON.parse(raw) as PersistedExperienceStore;
      if (!Array.isArray(parsed.experiences)) return;
      for (const exp of parsed.experiences) {
        if (!exp?.id || typeof exp.text !== "string" || !Array.isArray(exp.vector)) continue;
        this.experiences.set(exp.id, {
          ...exp,
          vector: exp.vector.slice(0, this.dimensions)
        });
      }
      this.trimToCapacity();
    } catch {
      // no persisted file yet
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private trimToCapacity(): void {
    if (this.experiences.size <= this.options.maxExperiences) return;
    const byTimestamp = [...this.experiences.entries()].sort(
      (a, b) => new Date(a[1].timestamp).getTime() - new Date(b[1].timestamp).getTime()
    );
    const toRemove = byTimestamp.slice(0, this.experiences.size - this.options.maxExperiences);
    for (const [id] of toRemove) this.experiences.delete(id);
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.stateFile), { recursive: true });
      const payload: PersistedExperienceStore = {
        version: STORE_VERSION,
        experiences: [...this.experiences.values()].map((e) => ({ ...e, vector: [...e.vector] }))
      };
      await writeFile(this.options.stateFile, JSON.stringify(payload, null, 2), "utf8");
    });
    await this.writeChain;
  }

  /**
   * Returns true if the text is "relatively unique" (max similarity to any stored experience < threshold).
   */
  async isUnique(text: string): Promise<boolean> {
    await this.ensureLoaded();
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    const queryVector = computeVector(trimmed, this.dimensions);
    for (const exp of this.experiences.values()) {
      const sim = cosineSimilarity(queryVector, exp.vector);
      if (sim >= this.uniquenessThreshold) return false;
    }
    return true;
  }

  /**
   * Add an experience. Caller may check isUnique first to only add relatively unique ones.
   */
  async add(args: {
    id?: string;
    text: string;
    category: string;
    sessionId: string;
    recordId?: string;
  }): Promise<Experience> {
    await this.ensureLoaded();
    const id = args.id ?? `exp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const text = args.text.trim();
    if (text.length === 0) throw new Error("Experience text cannot be empty");
    const vector = computeVector(text, this.dimensions);
    const experience: Experience = {
      id,
      text,
      category: args.category,
      sessionId: args.sessionId,
      ...(args.recordId !== undefined ? { recordId: args.recordId } : {}),
      timestamp: new Date().toISOString(),
      vector
    };
    this.experiences.set(id, experience);
    this.trimToCapacity();
    await this.persist();
    return experience;
  }

  /**
   * Query by semantic similarity. Returns top-k experiences.
   */
  async query(args: { query: string; topK: number }): Promise<ExperienceQueryResult[]> {
    await this.ensureLoaded();
    const queryVector = computeVector(args.query.trim() || " ", this.dimensions);
    const topK = Math.max(1, Math.min(50, args.topK));
    const results: ExperienceQueryResult[] = [];
    for (const exp of this.experiences.values()) {
      const score = cosineSimilarity(queryVector, exp.vector);
      if (score <= 0) continue;
      results.push({
        id: exp.id,
        text: exp.text,
        category: exp.category,
        sessionId: exp.sessionId,
        score
      });
    }
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Count of stored experiences. */
  size(): number {
    return this.experiences.size;
  }
}
