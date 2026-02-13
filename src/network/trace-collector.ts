import { URL } from "node:url";

import type { RuntimeObservationStore } from "../runtime-observation.js";
import { redactSecrets } from "../security.js";
import { TraceLinker } from "./trace-linker.js";

export interface NetworkTraceCollectorOptions {
  enabled: boolean;
  allowHosts: string[];
  observationStore: RuntimeObservationStore;
  getIndexedModulePaths: () => Promise<string[]>;
}

export interface NetworkTraceInput {
  sessionId?: string;
  method: string;
  url: string;
  status: number;
  latencyMs: number;
  requestBody?: unknown;
  responseBody?: unknown;
  headers?: Record<string, string>;
}

export class NetworkTraceCollector {
  private readonly linker = new TraceLinker();

  constructor(private readonly options: NetworkTraceCollectorOptions) {}

  async ingest(input: NetworkTraceInput): Promise<{
    accepted: boolean;
    reason?: string;
    linkedModules: string[];
  }> {
    if (!this.options.enabled) {
      return {
        accepted: false,
        reason: "network trace collector disabled",
        linkedModules: []
      };
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.url);
    } catch {
      return {
        accepted: false,
        reason: "invalid trace URL",
        linkedModules: []
      };
    }
    if (!this.isHostAllowed(parsedUrl.hostname)) {
      return {
        accepted: false,
        reason: `host not allowed for trace capture: ${parsedUrl.hostname}`,
        linkedModules: []
      };
    }
    const indexedModules = await this.options.getIndexedModulePaths();
    const route = parsedUrl.pathname || "/";
    const links = this.linker.linkRouteToModules({
      route,
      indexedModulePaths: indexedModules
    });
    const sanitizedPayload = sanitizePayload({
      method: input.method,
      url: parsedUrl.toString(),
      status: input.status,
      latencyMs: input.latencyMs,
      headers: input.headers ?? {},
      requestBody: input.requestBody,
      responseBody: input.responseBody,
      route,
      linkCandidates: links.candidates
    });
    await this.options.observationStore.append({
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      source: "net-trace",
      kind: "http-exchange",
      sensitivity: "operational",
      payload: sanitizedPayload
    });
    return {
      accepted: true,
      linkedModules: links.candidates.map((candidate) => candidate.modulePath)
    };
  }

  private isHostAllowed(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
      return true;
    }
    if (this.options.allowHosts.length === 0) {
      return false;
    }
    return this.options.allowHosts.includes(normalized);
  }
}

function sanitizePayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) {
    return payload;
  }
  if (typeof payload === "string") {
    return redactSecrets(payload).slice(0, 20_000);
  }
  if (Array.isArray(payload)) {
    return payload.slice(0, 100).map((entry) => sanitizePayload(entry));
  }
  if (typeof payload === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload).slice(0, 200)) {
      out[key] = sanitizePayload(value);
    }
    return out;
  }
  return payload;
}
