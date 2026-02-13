import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactSecrets } from "../security.js";
import type { ObservationSensitivity } from "../runtime-observation.js";

export interface SemanticChunk {
  id: string;
  workspace: string;
  repo: string;
  modulePath: string;
  symbol?: string;
  chunkIndex: number;
  text: string;
  sensitivity: ObservationSensitivity;
  updatedAt: string;
  contentHash: string;
  vector: number[];
}

export interface EmbeddingIndexOptions {
  stateFile: string;
  maxChunks: number;
  dimensions?: number;
}

export interface EmbeddingQueryResult {
  chunk: SemanticChunk;
  score: number;
}

interface PersistedEmbeddingIndex {
  version: number;
  chunks: SemanticChunk[];
}

const EMBEDDING_STATE_VERSION = 1;

export class LocalEmbeddingIndex {
  private readonly chunks = new Map<string, SemanticChunk>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly dimensions: number;

  constructor(private readonly options: EmbeddingIndexOptions) {
    this.dimensions = options.dimensions ?? 128;
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await readFile(this.options.stateFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedEmbeddingIndex;
      if (!Array.isArray(parsed.chunks)) {
        return;
      }
      for (const chunk of parsed.chunks) {
        if (!chunk?.workspace || !chunk.repo || !chunk.modulePath || typeof chunk.text !== "string") {
          continue;
        }
        if (!Array.isArray(chunk.vector)) {
          continue;
        }
        this.chunks.set(this.keyFor(chunk.workspace, chunk.repo, chunk.modulePath, chunk.chunkIndex), {
          ...chunk,
          vector: chunk.vector.slice(0, this.dimensions)
        });
      }
    } catch {
      // no persisted file yet
    }
  }

  async upsertModule(args: {
    workspace: string;
    repo: string;
    modulePath: string;
    sourceText: string;
    sensitivity?: ObservationSensitivity;
  }): Promise<void> {
    await this.ensureLoaded();
    const sensitivity = args.sensitivity ?? "operational";
    const chunks = splitIntoChunks(redactSecrets(args.sourceText), 320, 40);
    const modulePrefix = `${args.workspace}:${args.repo}:${args.modulePath}:`;
    for (const key of [...this.chunks.keys()]) {
      if (key.startsWith(modulePrefix)) {
        this.chunks.delete(key);
      }
    }
    const updatedAt = new Date().toISOString();
    for (let index = 0; index < chunks.length; index += 1) {
      const text = chunks[index];
      if (!text) {
        continue;
      }
      const vector = computeVector(text, this.dimensions);
      const chunk: SemanticChunk = {
        id: randomUUID(),
        workspace: args.workspace,
        repo: args.repo,
        modulePath: args.modulePath,
        chunkIndex: index,
        text,
        sensitivity,
        updatedAt,
        contentHash: hashText(text),
        vector
      };
      this.chunks.set(this.keyFor(args.workspace, args.repo, args.modulePath, index), chunk);
    }
    this.trimToCapacity();
    await this.persist();
  }

  async query(args: {
    query: string;
    topK: number;
    workspace?: string;
    repo?: string;
    allowSecret?: boolean;
  }): Promise<EmbeddingQueryResult[]> {
    await this.ensureLoaded();
    const queryVector = computeVector(args.query, this.dimensions);
    const topK = Math.max(1, Math.min(50, args.topK));
    const matches: EmbeddingQueryResult[] = [];
    for (const chunk of this.chunks.values()) {
      if (args.workspace && chunk.workspace !== args.workspace) {
        continue;
      }
      if (args.repo && chunk.repo !== args.repo) {
        continue;
      }
      if (chunk.sensitivity === "secret" && !args.allowSecret) {
        continue;
      }
      const score = cosineSimilarity(queryVector, chunk.vector);
      if (score <= 0) {
        continue;
      }
      matches.push({
        chunk: { ...chunk, vector: [...chunk.vector] },
        score
      });
    }
    return matches.sort((lhs, rhs) => rhs.score - lhs.score).slice(0, topK);
  }

  async listChunks(args?: {
    workspace?: string;
    repo?: string;
    limit?: number;
  }): Promise<SemanticChunk[]> {
    await this.ensureLoaded();
    const limit = Math.max(1, Math.min(2_000, args?.limit ?? 100));
    return [...this.chunks.values()]
      .filter((chunk) => {
        if (args?.workspace && chunk.workspace !== args.workspace) {
          return false;
        }
        if (args?.repo && chunk.repo !== args.repo) {
          return false;
        }
        return true;
      })
      .sort((lhs, rhs) => rhs.updatedAt.localeCompare(lhs.updatedAt))
      .slice(0, limit)
      .map((chunk) => ({ ...chunk, vector: [...chunk.vector] }));
  }

  private keyFor(workspace: string, repo: string, modulePath: string, chunkIndex: number): string {
    return `${workspace}:${repo}:${modulePath}:${chunkIndex}`;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  private trimToCapacity(): void {
    if (this.chunks.size <= this.options.maxChunks) {
      return;
    }
    const stale = [...this.chunks.entries()]
      .sort((lhs, rhs) => lhs[1].updatedAt.localeCompare(rhs[1].updatedAt))
      .slice(0, this.chunks.size - this.options.maxChunks);
    for (const [key] of stale) {
      this.chunks.delete(key);
    }
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.stateFile), { recursive: true });
      const payload: PersistedEmbeddingIndex = {
        version: EMBEDDING_STATE_VERSION,
        chunks: [...this.chunks.values()].map((chunk) => ({ ...chunk, vector: [...chunk.vector] }))
      };
      await writeFile(this.options.stateFile, JSON.stringify(payload, null, 2), "utf8");
    });
    await this.writeChain;
  }
}

function splitIntoChunks(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + maxChars);
    chunks.push(text.slice(cursor, end));
    if (end >= text.length) {
      break;
    }
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return chunks;
}

function computeVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return vector;
  }
  for (const token of tokens) {
    const index = tokenHash(token) % dimensions;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0));
  if (norm <= 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((token) => token.length >= 2)
    .slice(0, 2_000);
}

function tokenHash(token: string): number {
  const digest = createHash("sha1").update(token).digest();
  return digest.readUInt32BE(0);
}

function cosineSimilarity(lhs: number[], rhs: number[]): number {
  let dot = 0;
  const size = Math.min(lhs.length, rhs.length);
  for (let index = 0; index < size; index += 1) {
    dot += (lhs[index] ?? 0) * (rhs[index] ?? 0);
  }
  return dot;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
