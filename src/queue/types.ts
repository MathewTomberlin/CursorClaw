/**
 * Pluggable queue backend for session turn queue.
 * In-memory implementation is default; file-based backend allows durable queue across restarts.
 */

export interface QueueBackend {
  enqueue(sessionId: string, payload: unknown): Promise<string>;
  dequeue(sessionId: string): Promise<unknown | null>;
  listPending(sessionId: string): Promise<string[]>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}
