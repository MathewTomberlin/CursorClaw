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

/** Map adapter ToolDefinition to Ollama API tools format (OpenAI-style). */
function mapToolsToOllama(tools: ToolDefinition[]): Array<{ type: "function"; function: { name: string; description: string; parameters: object } }> {
  if (tools.length === 0) return [];
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.schema ?? { type: "object", properties: {} }
    }
  }));
}

/**
 * Ollama provider: talks to a local (or remote) Ollama server via HTTP /api/chat.
 * Streams assistant content and tool_call events when the model and Ollama support tools (see docs/Ollama-tool-call-support.md).
 */
export class OllamaProvider implements ModelProvider {
  private readonly turnAbortControllers = new Map<string, AbortController>();

  async *sendTurn(
    _session: ModelSessionHandle,
    modelConfig: ModelProviderConfig,
    messages: Array<{ role: string; content: string }>,
    tools: ToolDefinition[],
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

    const body: { model: string; messages: typeof ollamaMessages; stream: boolean; tools?: ReturnType<typeof mapToolsToOllama> } = {
      model,
      messages: ollamaMessages,
      stream: true
    };
    if (tools.length > 0) {
      body.tools = mapToolsToOllama(tools);
    }

    const controller = new AbortController();
    this.turnAbortControllers.set(options.turnId, controller);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${baseURL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      const emittedToolCallIndices = new Set<number>();

      for await (const chunk of streamReadLines(reader)) {
        const line = chunk.trim();
        if (!line) continue;
        let parsed: {
          message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
          done?: boolean;
          eval_count?: number;
        };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.message?.content) {
          completionTokens += (parsed.message.content as string).length;
          yield { type: "assistant_delta", data: { content: parsed.message.content } };
        }
        const toolCalls = parsed.message?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (let i = 0; i < toolCalls.length; i++) {
            if (emittedToolCallIndices.has(i)) continue;
            const tc = toolCalls[i];
            const name = typeof tc?.function?.name === "string" ? tc.function.name : "";
            if (!name) continue;
            emittedToolCallIndices.add(i);
            let args: unknown = tc?.function?.arguments ?? {};
            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                args = {};
              }
            }
            yield { type: "tool_call", data: { name, args } };
          }
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
