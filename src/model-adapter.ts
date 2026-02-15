import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { platform } from "node:os";
import { Ajv, type ValidateFunction } from "ajv";

import { redactSecrets } from "./security.js";
import type {
  AdapterEvent,
  ModelAdapter,
  ModelSessionHandle,
  SendTurnOptions,
  SessionContext,
  ToolDefinition
} from "./types.js";

export interface CursorAgentAdapterModelConfig {
  provider: "cursor-agent-cli" | "fallback-model";
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
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly eventLogs: string[] = [];
  private readonly ajv = new Ajv({ strict: false, allErrors: true });
  private readonly validatorCache = new Map<string, ValidateFunction<unknown>>();
  private readonly maxLogEntries = 5_000;
  private readonly metrics = {
    timeoutCount: 0,
    crashCount: 0,
    fallbackAttemptCount: 0,
    lastFallbackError: null as string | null
  };

  constructor(private readonly config: CursorAgentAdapterConfig) {}

  getRedactedLogs(): string[] {
    return [...this.eventLogs];
  }

  getMetrics(): {
    timeoutCount: number;
    crashCount: number;
    fallbackAttemptCount: number;
    lastFallbackError: string | null;
  } {
    return { ...this.metrics };
  }

  async createSession(_context: SessionContext): Promise<ModelSessionHandle> {
    const handle: ModelSessionHandle = {
      id: randomUUID(),
      model: this.config.defaultModel,
      authProfile: this.config.models[this.config.defaultModel]?.authProfiles[0] ?? "default"
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
        try {
          if (modelConfig.provider === "cursor-agent-cli") {
            session.model = modelName;
            session.authProfile = profile;
            yield* this.streamViaCli(modelName, profile, messages, tools, options);
            return;
          }
          yield* this.streamViaFallbackModel(modelName, messages, options);
          return;
        } catch (error) {
          lastError = error;
          this.metrics.fallbackAttemptCount += 1;
          const errMsg = redactSecrets(String(error));
          this.metrics.lastFallbackError = errMsg;
          this.pushEventLog(redactSecrets(`adapter-fail model=${modelName} profile=${profile} err=${String(error)}`));
          if (!isRecoverableAdapterError(error)) {
            throw error;
          }
        }
      }
    }
    throw new Error(`all model attempts failed: ${tried.join(", ")}; last=${String(lastError)}`);
  }

  async cancel(turnId: string): Promise<void> {
    const child = this.processes.get(turnId);
    if (!child) {
      return;
    }
    try {
      child.stdin.write(JSON.stringify({ type: "cancel", turnId }) + "\n");
    } catch {
      // Ignore; child may have already exited.
    }
    child.kill("SIGTERM");
    setTimeout(() => {
      if (this.isProcessRunning(child)) {
        child.kill("SIGKILL");
      }
    }, 300);
  }

  async close(session: ModelSessionHandle): Promise<void> {
    this.sessions.delete(session.id);
  }

  private async *streamViaFallbackModel(
    modelName: string,
    messages: Array<{ role: string; content: string }>,
    _options: SendTurnOptions
  ): AsyncIterable<AdapterEvent> {
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    const content = `Fallback(${modelName}) response: ${lastUserMessage?.content ?? "no input"}`;
    yield { type: "assistant_delta", data: { content: content.slice(0, 200) } };
    yield { type: "usage", data: { promptTokens: 0, completionTokens: content.length } };
    yield { type: "done", data: { fallback: true, model: modelName } };
  }

  /**
   * On Windows, .cmd/.bat files cannot be spawned directly (EINVAL). Run them via cmd.exe /c.
   */
  private resolveSpawnCommand(command: string, args: string[]): { command: string; args: string[] } {
    const isWindows = platform() === "win32";
    const lower = command.toLowerCase();
    if (isWindows && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
      return { command: "cmd.exe", args: ["/c", command, ...args] };
    }
    return { command, args };
  }

  private async *streamViaCli(
    modelName: string,
    authProfile: string,
    messages: Array<{ role: string; content: string }>,
    tools: ToolDefinition[],
    options: SendTurnOptions
  ): AsyncIterable<AdapterEvent> {
    const modelConfig = this.config.models[modelName];
    if (!modelConfig?.command) {
      throw new Error(`model config missing command: ${modelName}`);
    }
    const timeoutMs = options.timeoutMs ?? modelConfig.timeoutMs;
    const baseArgs = modelConfig.args ?? [];
    const promptAsArg = Boolean(modelConfig.promptAsArg);
    const lastUserContent =
      [...messages].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
    const args = promptAsArg ? [...baseArgs, lastUserContent] : baseArgs;
    const { command, args: resolvedArgs } = this.resolveSpawnCommand(modelConfig.command, args);
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
        tools: tools.map((tool) => ({ name: tool.name, schema: tool.schema }))
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
      if (!trimmed) {
        continue;
      }
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

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

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
    const candidate = parsed as { type?: string; data?: unknown; message?: { content?: Array<{ type?: string; text?: string }> } };
    if (!candidate.type) {
      throw new Error("malformed frame missing type");
    }
    const supportedEventTypes = ["assistant_delta", "tool_call", "usage", "error", "done", "protocol", "system", "user", "thinking", "assistant", "result"];
    if (!supportedEventTypes.includes(candidate.type)) {
      throw new Error(`unknown adapter event type: ${candidate.type}`);
    }
    if (candidate.type === "protocol") {
      const version = (candidate.data as { version?: string })?.version;
      const supportedVersions = ["1.0"];
      if (version && !supportedVersions.includes(version)) {
        throw new Error(`unsupported protocol version: ${version}`);
      }
      return null;
    }
    if (["system", "user", "thinking"].includes(candidate.type)) {
      return null;
    }
    if (candidate.type === "assistant") {
      const content = candidate.message?.content;
      const text =
        Array.isArray(content) ?
          content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("") :
          "";
      if (!text) return null;
      this.pushEventLog(redactSecrets(JSON.stringify(candidate)));
      return { type: "assistant_delta", data: { content: text } };
    }
    if (candidate.type === "result") {
      return { type: "done", data: {} };
    }
    if (candidate.type === "tool_call") {
      this.validateToolCall(candidate.data, tools);
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
    if (cached) {
      return cached;
    }
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
