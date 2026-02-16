import { randomUUID } from "node:crypto";

import {
  readValidationStore,
  resolveValidationStorePath,
  type ProviderModelValidationStore
} from "./provider-model-resilience/validation-store.js";
import { redactSecrets } from "./security.js";
import { getProvider } from "./providers/registry.js";
import type { ModelProvider } from "./providers/types.js";
import type {
  AdapterEvent,
  ChatMessage,
  CreateSessionOptions,
  ModelAdapter,
  ModelSessionHandle,
  SendTurnOptions,
  SessionContext,
  ToolDefinition
} from "./types.js";

export interface CursorAgentAdapterModelConfig {
  provider: "cursor-agent-cli" | "fallback-model" | "ollama" | "openai-compatible";
  command?: string;
  args?: string[];
  /**
   * If true, the last user message is passed as the final CLI argument (prompt-as-arg)
   * and no turn JSON is written to stdin. Use for Cursor CLI which expects
   * e.g. agent -p --output-format stream-json "prompt".
   */
  promptAsArg?: boolean;
  timeoutMs: number;
  authProfiles: string[];
  fallbackModels: string[];
  enabled: boolean;
  /** Ollama provider: model name (e.g. llama3.2). */
  ollamaModelName?: string;
  /** Ollama / OpenAI-compatible: base URL (e.g. http://localhost:11434). */
  baseURL?: string;
  /** Reference into credential store for API key (e.g. env:OPENAI_API_KEY). Used by OpenAI-compatible provider. */
  apiKeyRef?: string;
  /** OpenAI-compatible provider: model id (e.g. gpt-4o-mini). */
  openaiModelId?: string;
}

/** Minimal PMR config for adapter; full type in config.ts. */
export interface AdapterProviderModelResilienceConfig {
  useOnlyValidatedFallbacks?: boolean;
  validationStorePath?: string;
  /** When true and validated chain is empty, allow one attempt with unfiltered chain (log warning). */
  allowOneUnvalidatedAttempt?: boolean;
}

export interface CursorAgentAdapterConfig {
  models: Record<string, CursorAgentAdapterModelConfig>;
  defaultModel: string;
  /** Optional. When set, adapter can filter fallback chain to validated-only (PMR Phase 3). */
  providerModelResilience?: AdapterProviderModelResilienceConfig;
  /** Process cwd for resolving validation store path. Used when providerModelResilience.useOnlyValidatedFallbacks is true. */
  cwd?: string;
}

/** TTL for in-memory validation store cache to avoid disk read on every sendTurn (reduces input lag). */
const VALIDATION_STORE_CACHE_TTL_MS = 5_000;

function isRecoverableAdapterError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /(auth|transport|timeout|model)/i.test(error.message);
}

export class CursorAgentModelAdapter implements ModelAdapter {
  private readonly sessions = new Map<string, ModelSessionHandle>();
  /** turnId -> provider for cancel(). */
  private readonly turnIdToProvider = new Map<string, ModelProvider>();
  private readonly adapterEventLogs: string[] = [];
  private readonly maxAdapterLogEntries = 1_000;
  private readonly metrics = {
    fallbackAttemptCount: 0,
    lastFallbackError: null as string | null
  };
  /** Cached validation store to avoid reading disk on every sendTurn when PMR is enabled. */
  private validationStoreCache: {
    path: string;
    store: ProviderModelValidationStore;
    atMs: number;
  } | null = null;

  constructor(private readonly config: CursorAgentAdapterConfig) {}

  getRedactedLogs(): string[] {
    const cli = getProvider("cursor-agent-cli", this.config) as {
      getRedactedLogs?: () => string[];
    };
    const cliLogs = cli?.getRedactedLogs?.() ?? [];
    return [...this.adapterEventLogs, ...cliLogs];
  }

  getMetrics(): {
    timeoutCount: number;
    crashCount: number;
    fallbackAttemptCount: number;
    lastFallbackError: string | null;
  } {
    const cli = getProvider("cursor-agent-cli", this.config) as {
      getMetrics?: () => { timeoutCount: number; crashCount: number };
    };
    const base = cli?.getMetrics?.() ?? { timeoutCount: 0, crashCount: 0 };
    return {
      ...base,
      fallbackAttemptCount: this.metrics.fallbackAttemptCount,
      lastFallbackError: this.metrics.lastFallbackError
    };
  }

  async createSession(_context: SessionContext, options?: CreateSessionOptions): Promise<ModelSessionHandle> {
    const modelId = options?.modelId ?? this.config.defaultModel;
    const modelConfig = this.config.models[modelId];
    const handle: ModelSessionHandle = {
      id: randomUUID(),
      model: modelId,
      authProfile: modelConfig?.authProfiles[0] ?? "default"
    };
    this.sessions.set(handle.id, handle);
    return handle;
  }

  async *sendTurn(
    session: ModelSessionHandle,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: SendTurnOptions
  ): AsyncIterable<AdapterEvent> {
    const tried: string[] = [];
    let modelChain = [session.model, ...(this.config.models[session.model]?.fallbackModels ?? [])];

    if (this.config.providerModelResilience?.useOnlyValidatedFallbacks) {
      const cwd = this.config.cwd ?? process.cwd();
      const storePath = resolveValidationStorePath(
        this.config.providerModelResilience.validationStorePath,
        cwd
      );
      const now = Date.now();
      let store: ProviderModelValidationStore;
      const cached = this.validationStoreCache;
      if (
        cached &&
        cached.path === storePath &&
        now - cached.atMs < VALIDATION_STORE_CACHE_TTL_MS
      ) {
        store = cached.store;
      } else {
        store = await readValidationStore(storePath);
        this.validationStoreCache = { path: storePath, store, atMs: now };
      }
      const validated = modelChain.filter((id) => store.results[id]?.passed === true);
      if (validated.length === 0) {
        if (this.config.providerModelResilience?.allowOneUnvalidatedAttempt === true) {
          this.pushAdapterEventLog(
            "no validated models; allowing one unvalidated attempt per PMR allowOneUnvalidatedAttempt"
          );
          // Leave modelChain as original [session.model, ...fallbackModels]
        } else {
          throw new Error(
            "no validated model available; run 'npm run validate-model' for candidate models or set providerModelResilience.useOnlyValidatedFallbacks to false"
          );
        }
      } else {
        modelChain = validated;
      }
    }

    let lastError: unknown;
    for (const modelName of modelChain) {
      const modelConfig = this.config.models[modelName];
      if (!modelConfig?.enabled) {
        continue;
      }
      for (const profile of modelConfig.authProfiles) {
        tried.push(`${modelName}:${profile}`);
        const provider = getProvider(modelConfig.provider, this.config);
        session.model = modelName;
        session.authProfile = profile;
        this.turnIdToProvider.set(options.turnId, provider);
        try {
          for await (const event of provider.sendTurn(
            session,
            modelConfig,
            messages,
            tools,
            options
          )) {
            yield event;
          }
          return;
        } catch (error) {
          lastError = error;
          this.metrics.fallbackAttemptCount += 1;
          const errMsg = redactSecrets(String(error));
          this.metrics.lastFallbackError = errMsg;
          this.pushAdapterEventLog(
            redactSecrets(`adapter-fail model=${modelName} profile=${profile} err=${String(error)}`)
          );
          if (!isRecoverableAdapterError(error)) {
            throw error;
          }
        } finally {
          this.turnIdToProvider.delete(options.turnId);
        }
      }
    }
    throw new Error(`all model attempts failed: ${tried.join(", ")}; last=${String(lastError)}`);
  }

  async cancel(turnId: string): Promise<void> {
    const provider = this.turnIdToProvider.get(turnId);
    if (provider) {
      await provider.cancel(turnId);
      this.turnIdToProvider.delete(turnId);
    }
  }

  private pushAdapterEventLog(entry: string): void {
    if (this.adapterEventLogs.length >= this.maxAdapterLogEntries) {
      this.adapterEventLogs.shift();
    }
    this.adapterEventLogs.push(entry);
  }

  async close(session: ModelSessionHandle): Promise<void> {
    this.sessions.delete(session.id);
  }

}
