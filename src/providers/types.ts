import type {
  AdapterEvent,
  ChatMessage,
  ModelSessionHandle,
  SendTurnOptions,
  ToolDefinition
} from "../types.js";
import type { ModelProviderConfig } from "../config.js";

/**
 * Minimal interface for a single model provider (e.g. cursor-agent-cli, ollama).
 * The adapter delegates sendTurn and cancel to the provider for the model's provider type.
 */
export interface ModelProvider {
  /**
   * Run one turn: stream events (assistant_delta, tool_call, usage, done, error).
   * The adapter calls this for a specific (session, modelConfig) after resolving the model.
   */
  sendTurn(
    session: ModelSessionHandle,
    modelConfig: ModelProviderConfig,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: SendTurnOptions
  ): AsyncIterable<AdapterEvent>;

  /**
   * Cancel an in-flight turn by turnId. No-op if turnId is not owned by this provider.
   */
  cancel(turnId: string): Promise<void>;
}
