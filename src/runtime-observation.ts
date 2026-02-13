import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ObservationSensitivity = "public" | "private-user" | "secret" | "operational";

export interface ObservationEvent {
  id: string;
  at: string;
  sessionId?: string;
  source: string;
  kind: string;
  sensitivity: ObservationSensitivity;
  payload: unknown;
}

export interface RuntimeObservationStoreOptions {
  maxEvents: number;
  stateFile?: string;
}

export class RuntimeObservationStore {
  private events: ObservationEvent[] = [];
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeObservationStoreOptions) {}

  async append(
    event: Omit<ObservationEvent, "id" | "at">
  ): Promise<ObservationEvent> {
    await this.ensureLoaded();
    const materialized: ObservationEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...event,
      payload: sanitizeObservationPayload(event.payload)
    };
    this.events.push(materialized);
    if (this.events.length > this.options.maxEvents) {
      this.events.splice(0, this.events.length - this.options.maxEvents);
    }
    await this.persist();
    return { ...materialized };
  }

  async listRecent(args?: {
    sessionId?: string;
    limit?: number;
  }): Promise<ObservationEvent[]> {
    await this.ensureLoaded();
    const limit = Math.max(1, Math.min(200, args?.limit ?? 20));
    const filtered = this.events.filter((event) => {
      if (!args?.sessionId) {
        return true;
      }
      return event.sessionId === args.sessionId;
    });
    return filtered.slice(-limit).map((event) => ({ ...event }));
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (!this.options.stateFile) {
      return;
    }
    try {
      const raw = await readFile(this.options.stateFile, "utf8");
      const parsed = JSON.parse(raw) as ObservationEvent[];
      if (!Array.isArray(parsed)) {
        return;
      }
      this.events = parsed
        .filter((entry) => typeof entry?.id === "string" && typeof entry?.at === "string")
        .slice(-this.options.maxEvents);
    } catch {
      // No persisted store available yet.
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  private async persist(): Promise<void> {
    if (!this.options.stateFile) {
      return;
    }
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.stateFile as string), { recursive: true });
      await writeFile(this.options.stateFile as string, JSON.stringify(this.events, null, 2), "utf8");
    });
    await this.writeChain;
  }
}

function sanitizeObservationPayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    if (payload.length > 20_000) {
      return `${payload.slice(0, 20_000)}…`;
    }
    return payload;
  }
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) {
      return payload;
    }
    if (serialized.length <= 20_000) {
      return payload;
    }
    return `${serialized.slice(0, 20_000)}…`;
  } catch {
    return "[unserializable observation payload]";
  }
}
