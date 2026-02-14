import type { LifecycleEvent } from "../types.js";

/**
 * Stream of lifecycle events (queued, started, tool, assistant, completed, failed).
 * Used for optional SSE/WebSocket endpoints and UIs.
 */
export interface LifecycleStream {
  push(event: LifecycleEvent): void;
  subscribe(sessionId?: string): AsyncIterable<LifecycleEvent>;
}
