import type { ModelProvider } from "./types.js";
import type { ModelProviderConfig } from "../config.js";
import type {
  AdapterEvent,
  ChatMessage,
  ModelSessionHandle,
  SendTurnOptions,
  ToolDefinition
} from "../types.js";
import { resolveApiKey, resolveApiKeyAsync } from "../security/credential-resolver.js";

/** Config for OpenAI-compatible provider: base URL and model id; apiKeyRef for Bearer token. */
function isOpenAICompatibleConfig(
  c: ModelProviderConfig
): c is ModelProviderConfig & { provider: "openai-compatible" } {
  return c.provider === "openai-compatible";
}

/**
 * OpenAI-compatible provider: talks to any API that implements OpenAI chat completions (OpenAI, Anthropic via gateway, etc.).
 * Uses apiKeyRef to resolve Bearer token from credential store (e.g. env:OPENAI_API_KEY); key is never logged or sent to the model.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  private readonly turnAbortControllers = new Map<string, AbortController>();

  async *sendTurn(
    _session: ModelSessionHandle,
    modelConfig: ModelProviderConfig,
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    options: SendTurnOptions
  ): AsyncIterable<AdapterEvent> {
    if (!isOpenAICompatibleConfig(modelConfig)) {
      throw new Error(
        `openai-compatible provider requires provider "openai-compatible"; got provider=${modelConfig.provider}`
      );
    }
    const baseURL = (modelConfig.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const model = modelConfig.openaiModelId ?? "gpt-4o-mini";
    const timeoutMs = options.timeoutMs ?? modelConfig.timeoutMs ?? 120_000;

    const apiKey =
      options.profileRoot != null
        ? await resolveApiKeyAsync(modelConfig.apiKeyRef, options.profileRoot)
        : resolveApiKey(modelConfig.apiKeyRef);
    if (!apiKey) {
      throw new Error(
        "openai-compatible provider requires apiKeyRef (e.g. env:OPENAI_API_KEY or profile:openai-compatible) to be set and resolve to a non-empty value"
      );
    }

    const openAIMessages = messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: m.content
    }));

    const controller = new AbortController();
    this.turnAbortControllers.set(options.turnId, controller);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: openAIMessages,
          stream: true
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `openai-compatible /chat/completions failed: ${res.status} ${res.statusText}${text ? ` ${text.slice(0, 200)}` : ""}`
        );
      }

      const reader = res.body;
      if (!reader) {
        throw new Error("openai-compatible response has no body");
      }

      let promptTokens = 0;
      let completionTokens = 0;

      for await (const chunk of streamReadSSELines(reader)) {
        const line = chunk.trim();
        if (!line || line === "data: [DONE]") continue;
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6);
        let parsed: {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          parsed = JSON.parse(jsonStr) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.usage) {
          if (typeof parsed.usage.prompt_tokens === "number") promptTokens = parsed.usage.prompt_tokens;
          if (typeof parsed.usage.completion_tokens === "number") completionTokens = parsed.usage.completion_tokens;
        }
        const choice = parsed.choices?.[0];
        if (choice?.delta?.content) {
          completionTokens += (choice.delta.content as string).length;
          yield { type: "assistant_delta", data: { content: choice.delta.content } };
        }
        if (choice?.finish_reason != null) {
          break;
        }
      }

      yield { type: "usage", data: { promptTokens, completionTokens } };
      yield { type: "done", data: {} };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "error", data: { message: "openai-compatible request aborted or timed out" } };
      } else {
        yield { type: "error", data: { message: err instanceof Error ? err.message : String(err) } };
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      this.turnAbortControllers.delete(options.turnId);
    }
  }

  async cancel(turnId: string): Promise<void> {
    const controller = this.turnAbortControllers.get(turnId);
    if (controller) {
      controller.abort();
      this.turnAbortControllers.delete(turnId);
    }
  }
}

/** Consume a ReadableStream and yield SSE "data:" lines. */
async function* streamReadSSELines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        yield line;
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
