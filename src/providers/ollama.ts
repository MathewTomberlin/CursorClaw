import type { ModelProvider } from "./types.js";
import type { ModelProviderConfig } from "../config.js";
import type {
  AdapterEvent,
  ChatMessage,
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

/** Build request options for Ollama (temperature, num_ctx). When tools are sent, defaults are tuned for tool use on local models (e.g. Granite 3.2). */
function buildOllamaOptions(
  config: ModelProviderConfig,
  hasTools: boolean
): { temperature?: number; num_ctx?: number } {
  const opts = config.ollamaOptions ?? {};
  const temperature =
    typeof opts.temperature === "number" && opts.temperature >= 0 && opts.temperature <= 2
      ? opts.temperature
      : hasTools
        ? 0.3
        : undefined;
  const num_ctx =
    typeof opts.num_ctx === "number" && opts.num_ctx > 0 ? opts.num_ctx : hasTools ? 8192 : undefined;
  const out: { temperature?: number; num_ctx?: number } = {};
  if (temperature !== undefined) out.temperature = temperature;
  if (num_ctx !== undefined) out.num_ctx = num_ctx;
  return out;
}

/** Ollama tool parameters schema: type, required, properties (per docs). */
function normalizeParameters(schema: object | undefined): { type: "object"; required: string[]; properties: Record<string, { type: string; description?: string }> } {
  const s = schema && typeof schema === "object" ? schema as Record<string, unknown> : {};
  return {
    type: "object",
    required: Array.isArray(s.required) ? (s.required as string[]) : [],
    properties: (typeof s.properties === "object" && s.properties !== null ? s.properties as Record<string, { type?: string; description?: string }> : {}) as Record<string, { type: string; description?: string }>
  };
}

/** Map adapter ToolDefinition to Ollama API tools format (OpenAI-style, with required + properties). */
function mapToolsToOllama(tools: ToolDefinition[]): Array<{ type: "function"; function: { name: string; description: string; parameters: ReturnType<typeof normalizeParameters> } }> {
  if (tools.length === 0) return [];
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: normalizeParameters(t.schema)
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
    messages: ChatMessage[],
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

    const ollamaMessages = messages.map((m): Record<string, unknown> => {
      const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : m.role === "tool" ? "tool" : "user";
      const out: Record<string, unknown> = { role, content: m.content ?? "" };
      if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          type: "function",
          function: { index: tc.function.index, name: tc.function.name, arguments: tc.function.arguments }
        }));
      }
      if (role === "tool" && typeof m.tool_name === "string") {
        out.tool_name = m.tool_name;
      }
      return out;
    });

    const body: {
      model: string;
      messages: typeof ollamaMessages;
      stream: boolean;
      tools?: ReturnType<typeof mapToolsToOllama>;
      options?: { temperature?: number; num_ctx?: number };
    } = {
      model,
      messages: ollamaMessages,
      stream: true
    };
    if (tools.length > 0) {
      body.tools = mapToolsToOllama(tools);
    }
    const ollamaOpts = buildOllamaOptions(modelConfig, tools.length > 0);
    if (Object.keys(ollamaOpts).length > 0) {
      body.options = ollamaOpts;
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
      /** Accumulate tool_calls by index across stream chunks (Ollama may stream name then arguments, e.g. Granite3.2). */
      const toolCallsByIndex = new Map<number, { name: string; argsRaw: string | object }>();
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
            const tc = toolCalls[i];
            const name = typeof tc?.function?.name === "string" ? tc.function.name : "";
            const argsRaw = tc?.function?.arguments;
            const argsVal = argsRaw !== undefined && argsRaw !== null ? argsRaw : {};
            const argsStr = typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal);
            const existing = toolCallsByIndex.get(i);
            if (name) {
              const merged = existing
                ? { name, argsRaw: (typeof existing.argsRaw === "string" ? existing.argsRaw : JSON.stringify(existing.argsRaw)) + argsStr }
                : { name, argsRaw: argsStr };
              toolCallsByIndex.set(i, merged);
            } else if (existing) {
              const prevStr = typeof existing.argsRaw === "string" ? existing.argsRaw : JSON.stringify(existing.argsRaw);
              const nextRaw = argsStr.trim();
              const isCompleteJson = nextRaw.length > 0 && (nextRaw.startsWith("{") || nextRaw.startsWith("["));
              const mergedArgs = isCompleteJson && (() => { try { JSON.parse(nextRaw); return true; } catch { return false; } })()
                ? nextRaw
                : prevStr + argsStr;
              toolCallsByIndex.set(i, { name: existing.name, argsRaw: mergedArgs });
            }
          }
        }
        if (parsed.done === true) {
          if (typeof parsed.eval_count === "number") {
            completionTokens = parsed.eval_count;
          }
          for (const [idx] of toolCallsByIndex) {
            if (emittedToolCallIndices.has(idx)) continue;
            const acc = toolCallsByIndex.get(idx);
            if (acc?.name) {
              emittedToolCallIndices.add(idx);
              let args: unknown = acc.argsRaw;
              if (typeof args === "string") {
                try {
                  args = JSON.parse(args);
                } catch {
                  args = {};
                }
              }
              yield { type: "tool_call", data: { name: acc.name, args } };
            }
          }
          break;
        }
        for (const [idx, acc] of toolCallsByIndex) {
          if (emittedToolCallIndices.has(idx) || !acc.name) continue;
          const asStr = typeof acc.argsRaw === "string" ? acc.argsRaw : JSON.stringify(acc.argsRaw);
          const trimmed = asStr.trim();
          if (trimmed.length > 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
            try {
              const parsedArgs = JSON.parse(trimmed) as object;
              if (typeof parsedArgs === "object" && parsedArgs !== null && Object.keys(parsedArgs).length > 0) {
                emittedToolCallIndices.add(idx);
                let args: unknown = acc.argsRaw;
                if (typeof args === "string") {
                  try {
                    args = JSON.parse(args);
                  } catch {
                    args = {};
                  }
                }
                yield { type: "tool_call", data: { name: acc.name, args } };
              }
            } catch {
              // not yet complete JSON or empty object; keep accumulating
            }
          }
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
