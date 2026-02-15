import { randomUUID } from "node:crypto";

import { redactSecrets } from "./security.js";
import { getProvider } from "./providers/registry.js";
import type { ModelProvider } from "./providers/types.js";
import type {
  AdapterEvent,
  CreateSessionOptions,
  ModelAdapter,
  ModelSessionHandle,
  SendTurnOptions,
  SessionContext,
  ToolDefinition
} from "./types.js";

export interface CursorAgentAdapterModelConfig {
  provider: "cursor-agent-cli" | "fallback-model" | "ollama";
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
}

export interface CursorAgentAdapterConfig {
  models: Record<string, CursorAgentAdapterModelConfig>;
  defaultModel: string;
}

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
    messages: Array<{ role: string; content: string }>,
    tools: ToolDefinition[],
    options: SendTurnOptions
  ): AsyncIterable<AdapterEvent> {
    const tried: string[] = [];
    const modelChain = [session.model, ...(this.config.models[session.model]?.fallbackModels ?? [])];
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
