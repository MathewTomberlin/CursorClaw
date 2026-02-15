/**
 * Minimal capability probe for a single model (PMR Phase 1).
 * Sends one turn with echo tool; passes if we see tool_call and done within timeout.
 * No secrets in logs or store. See docs/PMR-provider-model-resilience.md.
 */

import type { CursorClawConfig } from "../config.js";
import { CursorAgentModelAdapter } from "../model-adapter.js";
import type { ModelAdapter } from "../types.js";
import type { ToolDefinition } from "../types.js";

const PROBE_SYSTEM =
  "You are a test. When asked to call a tool, respond with exactly one tool call.";
const PROBE_USER = "Call the tool named echo with argument hello.";

const ECHO_TOOL: ToolDefinition = {
  name: "echo",
  description: "Echo a message (probe only)",
  schema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false
  },
  riskLevel: "low",
  execute: async (args) => args
};

export interface ProbeResult {
  passed: boolean;
  error: string | null;
  checks: { toolCall: boolean };
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run the minimal capability probe for the given model id.
 * When options.adapter is provided (e.g. for tests), uses it instead of creating one from config.
 * Otherwise uses an adapter config that contains only this model with no fallbacks.
 * Returns pass if we see at least one tool_call and a done event within timeout.
 */
export async function runProbe(
  modelId: string,
  config: CursorClawConfig,
  options: { timeoutMs?: number; adapter?: ModelAdapter } = {}
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let adapter: ModelAdapter;
  if (options.adapter) {
    adapter = options.adapter;
  } else {
    const modelConfig = config.models[modelId];
    if (!modelConfig) {
      return {
        passed: false,
        error: `model not in config: ${modelId}`,
        checks: { toolCall: false }
      };
    }
    if (!modelConfig.enabled) {
      return {
        passed: false,
        error: "model is disabled in config",
        checks: { toolCall: false }
      };
    }
    const adapterConfig = {
      defaultModel: modelId,
      models: {
        [modelId]: {
          ...modelConfig,
          fallbackModels: [] as string[]
        }
      }
    };
    adapter = new CursorAgentModelAdapter(adapterConfig);
  }

  const turnId = `pmr-probe-${Date.now()}`;
  let session;
  try {
    session = await adapter.createSession(
      { sessionId: "probe", channelId: "probe", channelKind: "dm" },
      { modelId }
    );
  } catch (err) {
    return {
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      checks: { toolCall: false }
    };
  }

  const messages = [
    { role: "system", content: PROBE_SYSTEM },
    { role: "user", content: PROBE_USER }
  ];

  let sawToolCall = false;
  let sawDone = false;
  let lastError: string | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("probe timeout")), timeoutMs);
  });

  const runPromise = (async (): Promise<void> => {
    for await (const event of adapter.sendTurn(
      session,
      messages,
      [ECHO_TOOL],
      { turnId, timeoutMs }
    )) {
      if (event.type === "tool_call") {
        sawToolCall = true;
      }
      if (event.type === "done") {
        sawDone = true;
        return;
      }
      if (event.type === "error") {
        const msg = (event.data as { message?: string })?.message ?? String(event.data);
        lastError = msg;
      }
    }
  })();

  try {
    await Promise.race([runPromise, timeoutPromise]);
  } catch (err) {
    await adapter.close(session).catch(() => {});
    return {
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      checks: { toolCall: sawToolCall }
    };
  }

  await adapter.close(session).catch(() => {});

  const passed = sawToolCall && sawDone;
  return {
    passed,
    error: passed ? null : lastError ?? (sawToolCall ? "missing done" : "missing tool_call"),
    checks: { toolCall: sawToolCall }
  };
}
