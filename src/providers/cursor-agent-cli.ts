import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { platform } from "node:os";
import { Ajv, type ValidateFunction } from "ajv";

import { redactSecrets } from "../security.js";
import type { ModelProviderConfig } from "../config.js";
import type {
  AdapterEvent,
  ModelSessionHandle,
  SendTurnOptions,
  ToolDefinition
} from "../types.js";
import type { ModelProvider } from "./types.js";

function isCursorAgentConfig(
  c: ModelProviderConfig
): c is ModelProviderConfig & { provider: "cursor-agent-cli"; command: string } {
  return c.provider === "cursor-agent-cli" && Boolean(c.command);
}

export class CursorAgentCliProvider implements ModelProvider {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly eventLogs: string[] = [];
  private readonly ajv = new Ajv({ strict: false, allErrors: true });
  private readonly validatorCache = new Map<string, ValidateFunction<unknown>>();
  private readonly maxLogEntries = 5_000;
  private readonly metrics = {
    timeoutCount: 0,
    crashCount: 0
  };

  getRedactedLogs(): string[] {
    return [...this.eventLogs];
  }

  getMetrics(): { timeoutCount: number; crashCount: number } {
    return { ...this.metrics };
  }

  async *sendTurn(
    session: ModelSessionHandle,
    modelConfig: ModelProviderConfig,
    messages: Array<{ role: string; content: string }>,
    tools: ToolDefinition[],
    options: SendTurnOptions
  ): AsyncIterable<AdapterEvent> {
    if (!isCursorAgentConfig(modelConfig)) {
      throw new Error(`cursor-agent-cli provider requires provider "cursor-agent-cli" and command`);
    }
    const timeoutMs = options.timeoutMs ?? modelConfig.timeoutMs;
    const baseArgs = modelConfig.args ?? [];
    const promptAsArg = Boolean(modelConfig.promptAsArg);
    const lastUserContent =
      [...messages].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
    const args = promptAsArg
      ? [...baseArgs, "--approve-mcps", "--force", lastUserContent]
      : baseArgs;
    const { command, args: resolvedArgs } = this.resolveSpawnCommand(modelConfig.command, args);
    const authProfile = session.authProfile ?? modelConfig.authProfiles[0] ?? "default";
    const child = spawn(command, resolvedArgs, {
      env: {
        ...process.env,
        LANG: process.env.LANG ?? "C.UTF-8",
        CURSOR_AGENT_AUTH_PROFILE: authProfile
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.processes.set(options.turnId, child);

    if (promptAsArg) {
      child.stdin.end();
    } else {
      const payload = {
        type: "turn",
        turnId: options.turnId,
        messages,
        tools: tools.map((t) => ({ name: t.name, schema: t.schema }))
      };
      child.stdin.write(JSON.stringify(payload) + "\n");
      child.stdin.end();
    }

    let timedOut = false;
    let sawDone = false;
    let sawForwardableEvent = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const resetTimeout = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        this.metrics.timeoutCount += 1;
        this.stageTerminate(child, options.turnId);
      }, timeoutMs);
    };
    resetTimeout();

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(redactSecrets(chunk.toString("utf8")));
    });

    const lineReader = createInterface({ input: child.stdout });
    let sentinelBuffer: string | null = null;
    for await (const line of lineReader) {
      resetTimeout();
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "__JSON_START__") {
        sentinelBuffer = "";
        continue;
      }
      if (trimmed === "__JSON_END__") {
        if (sentinelBuffer === null) {
          throw new Error("malformed framed JSON: missing start marker");
        }
        const parsed = this.parseEventFrame(sentinelBuffer, tools);
        if (parsed) {
          if (parsed.type === "done") sawDone = true;
          else sawForwardableEvent = true;
          yield parsed;
        }
        sentinelBuffer = null;
        continue;
      }
      if (sentinelBuffer !== null) {
        sentinelBuffer += trimmed;
        continue;
      }
      const parsed = this.parseEventFrame(trimmed, tools);
      if (parsed) {
        if (parsed.type === "done") sawDone = true;
        else sawForwardableEvent = true;
        yield parsed;
      }
    }

    if (timeoutHandle) clearTimeout(timeoutHandle);
    const code = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    this.processes.delete(options.turnId);

    if (timedOut) {
      throw new Error("adapter timeout");
    }
    const stderrText = stderrChunks.join(" ").trim().replace(/\s+/g, " ") || "(no stderr)";
    const runHint =
      stderrText === "(no stderr)"
        ? " Run the CLI manually and pipe one line of turn JSON to stdin to see what it prints (see docs/cursor-agent-adapter.md for the turn format)."
        : "";
    if (code !== 0 && !sawDone) {
      this.metrics.crashCount += 1;
      throw new Error(
        `Cursor-Agent CLI exited with code ${code} before sending a done event. ` +
          `The CLI must read the turn JSON from stdin, emit NDJSON events on stdout (see docs/cursor-agent-adapter.md), and send a final {"type":"done","data":{}}. ` +
          `Stderr: ${stderrText}.${runHint}`
      );
    }
    if (!sawDone) {
      if (code === 0 && sawForwardableEvent) {
        sawDone = true;
      } else {
        throw new Error(
          `Cursor-Agent CLI stream ended without a done event. ` +
            `The process may have exited (code ${code}) before emitting any events, or it does not send {"type":"done","data":{}} at the end. ` +
            `Stderr: ${stderrText}.${runHint}`
        );
      }
    }
  }

  async cancel(turnId: string): Promise<void> {
    const child = this.processes.get(turnId);
    if (!child) return;
    try {
      child.stdin.write(JSON.stringify({ type: "cancel", turnId }) + "\n");
    } catch {
      // Ignore
    }
    child.kill("SIGTERM");
    setTimeout(() => {
      if (this.isProcessRunning(child)) {
        child.kill("SIGKILL");
      }
    }, 300);
    this.processes.delete(turnId);
  }

  private resolveSpawnCommand(command: string, args: string[]): { command: string; args: string[] } {
    const isWindows = platform() === "win32";
    const lower = command.toLowerCase();
    if (isWindows && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
      return { command: "cmd.exe", args: ["/c", command, ...args] };
    }
    return { command, args };
  }

  private parseEventFrame(raw: string, tools: ToolDefinition[]): AdapterEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("malformed frame");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("malformed frame payload");
    }
    const candidate = parsed as {
      type?: string;
      data?: unknown;
      message?: { content?: Array<{ type?: string; text?: string }> };
      tool_call?: unknown;
    };
    if (!candidate.type) {
      throw new Error("malformed frame missing type");
    }
    const supportedEventTypes = [
      "assistant_delta",
      "tool_call",
      "usage",
      "error",
      "done",
      "protocol",
      "system",
      "user",
      "thinking",
      "assistant",
      "result",
      "interaction_query"
    ];
    if (!supportedEventTypes.includes(candidate.type)) {
      throw new Error(`unknown adapter event type: ${candidate.type}`);
    }
    if (candidate.type === "protocol") {
      const version = (candidate.data as { version?: string })?.version;
      if (version && !["1.0"].includes(version)) {
        throw new Error(`unsupported protocol version: ${version}`);
      }
      return null;
    }
    if (["system", "user", "thinking", "interaction_query"].includes(candidate.type)) {
      return null;
    }
    if (candidate.type === "assistant") {
      const content = candidate.message?.content;
      const text = Array.isArray(content)
        ? content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("")
        : "";
      if (!text) return null;
      if (text.length > 300) return null;
      this.pushEventLog(redactSecrets(JSON.stringify(candidate)));
      return { type: "assistant_delta", data: { content: text } };
    }
    if (candidate.type === "result") {
      return { type: "done", data: {} };
    }
    if (candidate.type === "tool_call") {
      let payload: { name: string; args: unknown } | null = null;
      if (candidate.tool_call != null && typeof candidate.tool_call === "object") {
        const nested = candidate.tool_call as Record<string, unknown>;
        const name = (nested.name ?? nested.toolName) as string | undefined;
        const args = (nested.arguments ?? nested.args ?? {}) as unknown;
        if (typeof name === "string" && name.length > 0 && tools.some((t) => t.name === name)) {
          payload = { name, args };
        }
      }
      if (payload === null) {
        const raw = (candidate.data ?? candidate) as { name?: string; args?: unknown };
        if (raw == null || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name) {
          return null;
        }
        if (!tools.some((t) => t.name === raw.name)) {
          throw new Error(`unknown tool call: ${raw.name}`);
        }
        payload = { name: raw.name, args: raw.args };
      }
      this.validateToolCall(payload, tools);
      this.pushEventLog(redactSecrets(JSON.stringify(candidate)));
      return { type: "tool_call", data: { name: payload.name, args: payload.args } };
    }
    this.pushEventLog(redactSecrets(JSON.stringify(candidate)));
    return {
      type: candidate.type as AdapterEvent["type"],
      data: candidate.data
    };
  }

  private validateToolCall(data: unknown, tools: ToolDefinition[]): void {
    const payload = data as { name?: string; args?: unknown };
    if (!payload?.name) {
      throw new Error("tool call missing name");
    }
    const tool = tools.find((entry) => entry.name === payload.name);
    if (!tool) {
      throw new Error(`unknown tool call: ${payload.name}`);
    }
    const validate = this.getValidator(tool);
    if (!validate(payload.args)) {
      throw new Error(`tool call schema invalid: ${payload.name}`);
    }
  }

  private getValidator(tool: ToolDefinition): ValidateFunction<unknown> {
    const key = `${tool.name}:${JSON.stringify(tool.schema)}`;
    const cached = this.validatorCache.get(key);
    if (cached) return cached;
    const compiled = this.ajv.compile(tool.schema);
    this.validatorCache.set(key, compiled);
    return compiled;
  }

  private pushEventLog(entry: string): void {
    if (this.eventLogs.length >= this.maxLogEntries) {
      this.eventLogs.shift();
    }
    this.eventLogs.push(entry);
  }

  private stageTerminate(child: ChildProcessWithoutNullStreams, turnId: string): void {
    try {
      child.stdin.write(JSON.stringify({ type: "cancel", turnId }) + "\n");
    } catch {
      // no-op
    }
    child.kill("SIGTERM");
    setTimeout(() => {
      if (this.isProcessRunning(child)) {
        child.kill("SIGKILL");
      }
    }, 500);
  }

  private isProcessRunning(child: ChildProcessWithoutNullStreams): boolean {
    return child.exitCode === null && child.signalCode === null;
  }
}
