import type { LifecycleEvent } from "../types.js";
import type { LifecycleStream } from "./types.js";

interface Subscriber {
  sessionId: string | undefined;
  queue: LifecycleEvent[];
  resolve: (() => void) | null;
}

export class InMemoryLifecycleStream implements LifecycleStream {
  private readonly subscribers = new Set<Subscriber>();

  push(event: LifecycleEvent): void {
    for (const sub of this.subscribers) {
      if (sub.sessionId !== undefined && sub.sessionId !== event.sessionId) {
        continue;
      }
      sub.queue.push(event);
      if (sub.resolve) {
        sub.resolve();
        sub.resolve = null;
      }
    }
  }

  subscribe(sessionId?: string): AsyncIterable<LifecycleEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const sub: Subscriber = {
          sessionId: sessionId,
          queue: [],
          resolve: null
        };
        self.subscribers.add(sub);
        try {
          while (true) {
            if (sub.queue.length > 0) {
              yield sub.queue.shift()!;
              continue;
            }
            const next = new Promise<void>((r) => {
              sub.resolve = r;
            });
            await next;
          }
        } finally {
          self.subscribers.delete(sub);
        }
      }
    };
  }
}
