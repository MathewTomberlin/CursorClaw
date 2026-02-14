import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { QueueBackend } from "./types.js";

interface StoredItem {
  id: string;
  payload: unknown;
}

/** File-based queue backend. Payloads must be JSON-serializable. At-least-once delivery; duplicate possible after crash. */
export class FileQueueBackend implements QueueBackend {
  private readonly basePath: string;
  private idCounter = 0;

  constructor(options: { basePath: string }) {
    this.basePath = options.basePath;
  }

  private sessionPath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9-_]/g, "_");
    return join(this.basePath, `${safe}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
  }

  private async load(sessionId: string): Promise<StoredItem[]> {
    await this.ensureDir();
    const path = this.sessionPath(sessionId);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as StoredItem[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async save(sessionId: string, items: StoredItem[]): Promise<void> {
    await this.ensureDir();
    const path = this.sessionPath(sessionId);
    await writeFile(path, JSON.stringify(items), "utf8");
  }

  async enqueue(sessionId: string, payload: unknown): Promise<string> {
    const id = `q-${++this.idCounter}-${Date.now()}`;
    const list = await this.load(sessionId);
    list.push({ id, payload });
    await this.save(sessionId, list);
    return id;
  }

  async dequeue(sessionId: string): Promise<unknown | null> {
    const list = await this.load(sessionId);
    if (list.length === 0) return null;
    const item = list.shift()!;
    await this.save(sessionId, list);
    return item.payload;
  }

  async listPending(sessionId: string): Promise<string[]> {
    const list = await this.load(sessionId);
    return list.map((i) => i.id);
  }

  async remove(id: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    await mkdir(this.basePath, { recursive: true });
    const entries = await readdir(this.basePath).catch(() => []);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.basePath, name);
      const raw = await readFile(path, "utf8").catch(() => "[]");
      const list = JSON.parse(raw) as StoredItem[];
      const idx = list.findIndex((i) => i.id === id);
      if (idx >= 0) {
        list.splice(idx, 1);
        await writeFile(path, JSON.stringify(list), "utf8");
        return;
      }
    }
  }

  async close(): Promise<void> {
    // No-op; file state persists
  }
}
