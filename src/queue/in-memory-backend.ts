import type { QueueBackend } from "./types.js";

interface QueueItem {
  id: string;
  payload: unknown;
}

export class InMemoryQueueBackend implements QueueBackend {
  private readonly sessions = new Map<string, QueueItem[]>();
  private idCounter = 0;

  async enqueue(sessionId: string, payload: unknown): Promise<string> {
    const id = `q-${++this.idCounter}-${Date.now()}`;
    const list = this.sessions.get(sessionId) ?? [];
    list.push({ id, payload });
    this.sessions.set(sessionId, list);
    return id;
  }

  async dequeue(sessionId: string): Promise<unknown | null> {
    const list = this.sessions.get(sessionId);
    if (!list || list.length === 0) {
      return null;
    }
    const item = list.shift()!;
    if (list.length === 0) {
      this.sessions.delete(sessionId);
    }
    return item.payload;
  }

  async listPending(sessionId: string): Promise<string[]> {
    const list = this.sessions.get(sessionId) ?? [];
    return list.map((item) => item.id);
  }

  async remove(id: string): Promise<void> {
    for (const [sessionId, list] of this.sessions.entries()) {
      const idx = list.findIndex((item) => item.id === id);
      if (idx >= 0) {
        list.splice(idx, 1);
        if (list.length === 0) {
          this.sessions.delete(sessionId);
        }
        return;
      }
    }
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }
}
