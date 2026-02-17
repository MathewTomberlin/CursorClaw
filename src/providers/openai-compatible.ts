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

/** Config for OpenAI-compatible or LM Studio provider (same API shape). */
function isOpenAICompatibleConfig(
  c: ModelProviderConfig
): c is ModelProviderConfig & { provider: "openai-compatible" | "lm-studio" } {
  return c.provider === "openai-compatible" || c.provider === "lm-studio";
}

/** True when baseURL is localhost (API key optional for local servers). */
function isLocalBaseURL(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

/** Normalize tool parameters schema (required + properties) for OpenAI-style APIs. */
function normalizeParameters(schema: object | undefined): {
  type: "object";
  required: string[];
  properties: Record<string, { type: string; description?: string }>;
} {
  const s = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  return {
    type: "object",
    required: Array.isArray(s.required) ? (s.required as string[]) : [],
    properties: (typeof s.properties === "object" && s.properties !== null
      ? (s.properties as Record<string, { type?: string; description?: string }>)
      : {}) as Record<string, { type: string; description?: string }>
  };
}

/** Map adapter ToolDefinition to OpenAI API tools format. */
function mapToolsToOpenAI(
  tools: ToolDefinition[]
): Array<{ type: "function"; function: { name: string; description: string; parameters: ReturnType<typeof normalizeParameters> } }> {
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
 * OpenAI-compatible provider: talks to any API that implements OpenAI chat completions (OpenAI, Anthropic via gateway, etc.).
 * Uses apiKeyRef to resolve Bearer token from credential store (e.g. env:OPENAI_API_KEY); key is never logged or sent to the model.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  private readonly turnAbortControllers = new Map<string, AbortController>();

  async *sendTurn(
    _session: ModelSessionHandle,
    modelConfig: ModelProviderConfig,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: SendTurnOptions
  ): AsyncIterable<AdapterEvent> {
    if (!isOpenAICompatibleConfig(modelConfig)) {
      throw new Error(
        `openai-compatible provider requires provider "openai-compatible" or "lm-studio"; got provider=${modelConfig.provider}`
      );
    }
    const defaultBaseURL =
      modelConfig.provider === "lm-studio" ? "http://localhost:1234/v1" : "https://api.openai.com/v1";
    const baseURL = (modelConfig.baseURL ?? defaultBaseURL).replace(/\/$/, "");
    const model = modelConfig.openaiModelId ?? "gpt-4o-mini";
    const timeoutMs = options.timeoutMs ?? modelConfig.timeoutMs ?? 120_000;

    let apiKey =
      options.profileRoot != null
        ? await resolveApiKeyAsync(modelConfig.apiKeyRef, options.profileRoot)
        : resolveApiKey(modelConfig.apiKeyRef);
    if (!apiKey && isLocalBaseURL(baseURL)) {
      apiKey = " ";
    }
    if (!apiKey) {
      throw new Error(
        "openai-compatible provider requires apiKeyRef (e.g. env:OPENAI_API_KEY or profile:openai-compatible) to be set and resolve to a non-empty value"
      );
    }

    const openAIMessages = messages.map((m): Record<string, unknown> => {
      const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : m.role === "tool" ? "tool" : "user";
      const out: Record<string, unknown> = { role, content: m.content ?? "" };
      if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 12)}`,
          type: "function",
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {})
          }
        }));
      }
      if (role === "tool") {
        if (typeof m.tool_call_id === "string") out.tool_call_id = m.tool_call_id;
        else if (typeof m.tool_name === "string") out.tool_call_id = m.tool_name;
      }
      return out;
    });

    const body: {
      model: string;
      messages: typeof openAIMessages;
      stream: boolean;
      tools?: ReturnType<typeof mapToolsToOpenAI>;
      tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
    } = {
      model,
      messages: openAIMessages,
      stream: true
    };
    if (tools.length > 0) {
      body.tools = mapToolsToOpenAI(tools);
      // LM Studio and some servers need explicit tool_choice to return tool calls; "auto" allows model to choose.
      body.tool_choice = "auto";
    }

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
        body: JSON.stringify(body),
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
      /** Accumulate tool_calls by index (OpenAI streams delta.tool_calls with index, id, function.name/arguments). */
      const toolCallsByIndex = new Map<
        number,
        { id: string; name: string; argsRaw: string }
      >();
      const emittedToolCallIndices = new Set<number>();

      for await (const chunk of streamReadSSELines(reader)) {
        const line = chunk.trim();
        if (!line || line === "data: [DONE]") continue;
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6);
        let parsed: {
          choices?: Array<{
            delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
            finish_reason?: string;
          }>;
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
        const deltaToolCalls = choice?.delta?.tool_calls;
        if (Array.isArray(deltaToolCalls)) {
          for (let i = 0; i < deltaToolCalls.length; i++) {
            const dtc = deltaToolCalls[i];
            const idx = typeof dtc?.index === "number" ? dtc.index : i;
            const id = typeof dtc?.id === "string" ? dtc.id : "";
            const name = typeof dtc?.function?.name === "string" ? dtc.function.name : "";
            const argsChunk = typeof dtc?.function?.arguments === "string" ? dtc.function.arguments : "";
            const existing = toolCallsByIndex.get(idx);
            if (existing) {
              const mergedArgs = existing.argsRaw + argsChunk;
              toolCallsByIndex.set(idx, {
                id: id || existing.id,
                name: name || existing.name,
                argsRaw: mergedArgs
              });
            } else {
              toolCallsByIndex.set(idx, { id, name, argsRaw: argsChunk });
            }
          }
        }
        if (choice?.finish_reason != null) {
          for (const [idx, acc] of toolCallsByIndex) {
            if (emittedToolCallIndices.has(idx) || !acc.name) continue;
            emittedToolCallIndices.add(idx);
            let args: unknown = acc.argsRaw;
            const trimmed = (acc.argsRaw || "").trim();
            if (trimmed.length > 0) {
              try {
                args = JSON.parse(trimmed) as object;
              } catch {
                args = trimmed.length > 0 ? { raw: acc.argsRaw } : {};
              }
            } else {
              args = {};
            }
            yield { type: "tool_call", data: { name: acc.name, args, id: acc.id || undefined } };
          }
          break;
        }
        for (const [idx, acc] of toolCallsByIndex) {
          if (emittedToolCallIndices.has(idx) || !acc.name) continue;
          const trimmed = (acc.argsRaw || "").trim();
          if (trimmed.length > 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
            try {
              const parsedArgs = JSON.parse(trimmed) as object;
              if (typeof parsedArgs === "object" && parsedArgs !== null && Object.keys(parsedArgs).length > 0) {
                emittedToolCallIndices.add(idx);
                // Use already-parsed object; re-parsing acc.argsRaw can fail when stream has leading/trailing whitespace.
                yield { type: "tool_call", data: { name: acc.name, args: parsedArgs, id: acc.id || undefined } };
              }
            } catch {
              // incomplete JSON; keep accumulating
            }
          }
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
