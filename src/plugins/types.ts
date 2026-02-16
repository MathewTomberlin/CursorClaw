import type { MemoryStore } from "../memory.js";
import type { ObservationEvent } from "../runtime-observation.js";
import type { MemoryRecord } from "../types.js";

export interface PromptMessage {
  role: string;
  content: string;
}

export interface PluginContext {
  runId: string;
  sessionId: string;
  inputMessages: PromptMessage[];
  /** When set, collectors (e.g. memory) use this store for this turn so each agent profile gets its own memory. */
  memoryStore?: MemoryStore;
}

export interface PluginHealth {
  ok: boolean;
  detail?: string;
}

export interface PluginArtifact {
  sourcePlugin: string;
  type: string;
  payload: unknown;
}

export interface PluginInsight {
  sourcePlugin: string;
  type: string;
  payload: unknown;
}

export interface CollectorPlugin {
  id: string;
  timeoutMs?: number;
  collect(context: PluginContext): Promise<PluginArtifact[]>;
  health?(): Promise<PluginHealth>;
}

export interface AnalyzerPlugin {
  id: string;
  timeoutMs?: number;
  analyze(context: PluginContext, artifacts: PluginArtifact[]): Promise<PluginInsight[]>;
  health?(): Promise<PluginHealth>;
}

export interface SynthesizerPlugin {
  id: string;
  timeoutMs?: number;
  synthesize(context: PluginContext, insights: PluginInsight[]): Promise<PromptMessage[]>;
  health?(): Promise<PluginHealth>;
}

export interface MemoryContextPayload {
  records: MemoryRecord[];
}

export interface ObservationContextPayload {
  events: ObservationEvent[];
}
