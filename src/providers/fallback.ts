import type { ModelProvider } from "./types.js";
import type { ModelProviderConfig } from "../config.js";
import type {
  AdapterEvent,
  ChatMessage,
  ModelSessionHandle,
  SendTurnOptions,
  ToolDefinition
} from "../types.js";

/**
 * Fallback model provider: returns a short placeholder response.
 * Used when no real model is configured or as a fallback chain member.
 */
export class FallbackModelProvider implements ModelProvider {
  async *sendTurn(
    _session: ModelSessionHandle,
    modelConfig: ModelProviderConfig,
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options: SendTurnOptions
  ): AsyncIterable<AdapterEvent> {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const content =
      `Fallback(${_session.model}) response: ${lastUserMessage?.content ?? "no input"}`.slice(0, 200);
    yield { type: "assistant_delta", data: { content } };
    yield { type: "usage", data: { promptTokens: 0, completionTokens: content.length } };
    yield { type: "done", data: { fallback: true, model: _session.model } };
  }

  async cancel(_turnId: string): Promise<void> {
    // No in-flight process to cancel.
  }
}
