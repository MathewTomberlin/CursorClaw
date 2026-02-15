import type { ModelProvider } from "./types.js";
import type { ModelProviderConfig } from "../config.js";
import type {
  AdapterEvent,
  ModelSessionHandle,
  SendTurnOptions,
  ToolDefinition
} from "../types.js";

/** Config for Ollama provider: base URL and model name. */
function isOllamaConfig(
  c: ModelProviderConfig
): c is ModelProviderConfig & { provider: "ollama"; ollamaModelName: string } {
  return c.provider === "ollama" && typeof c.ollamaModelName === "string" && c.ollamaModelName.length > 0;
}

/**
 * Ollama provider: talks to a local (or remote) Ollama server via HTTP /api/chat.
 * Streams assistant content; tool_call support depends on model capabilities (documented in implementation guide).
 */
export class OllamaProvider implements ModelProvider {
  private readonly turnAbortControllers = new Map<string, AbortController>();

  async *sendTurn(
    _session: ModelSessionHandle,
    modelConfig: ModelProviderConfig,
    messages: Array<{ role: string; content: string }>,
    _tools: ToolDefinition[],
    options: SendTurnOptions
  ): AsyncIterable<AdapterEvent> {
    if (!isOllamaConfig(modelConfig)) {
      throw new Error(
        `ollama provider requires provider "ollama" and ollamaModelName; got provider=${modelConfig.provider}`
      );
    }
    const baseURL = (modelConfig.baseURL ?? "http://localhost:11434").replace(/\/$/, "");
    const model = modelConfig.ollamaModelName;
    const timeoutMs = options.timeoutMs ?? modelConfig.timeoutMs ?? 120_000;

    const ollamaMessages = messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: m.content
    }));

    const controller = new AbortController();
    this.turnAbortControllers.set(options.turnId, controller);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${baseURL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: ollamaMessages, stream: true }),
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`ollama /api/chat failed: ${res.status} ${res.statusText}${text ? ` ${text.slice(0, 200)}` : ""}`);
      }

      const reader = res.body;
      if (!reader) {
        throw new Error("ollama response has no body");
      }

      let promptTokens = 0;
      let completionTokens = 0;

      for await (const chunk of streamReadLines(reader)) {
        const line = chunk.trim();
        if (!line) continue;
        let parsed: { message?: { content?: string }; done?: boolean; eval_count?: number };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.message?.content) {
          completionTokens += (parsed.message.content as string).length;
          yield { type: "assistant_delta", data: { content: parsed.message.content } };
        }
        if (parsed.done === true) {
          if (typeof parsed.eval_count === "number") {
            completionTokens = parsed.eval_count;
          }
          break;
        }
      }

      yield { type: "usage", data: { promptTokens, completionTokens } };
      yield { type: "done", data: {} };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "error", data: { message: "ollama request aborted or timed out" } };
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

/** Consume a ReadableStream and yield lines (buffered by newlines). */
async function* streamReadLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
