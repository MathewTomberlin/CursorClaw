import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { CursorClawConfig } from "./config.js";
import type { DecisionJournal } from "./decision-journal.js";
import type { MemoryStore } from "./memory.js";
import type { CursorAgentModelAdapter } from "./model-adapter.js";
import type { PluginHost } from "./plugins/host.js";
import type { PrivacyScrubber } from "./privacy/privacy-scrubber.js";
import type { FailureLoopGuard } from "./reliability/failure-loop.js";
import type { GitCheckpointHandle, GitCheckpointManager } from "./reliability/git-checkpoint.js";
import type { RuntimeObservationStore } from "./runtime-observation.js";
import type { PolicyDecisionLog, SessionContext, ToolCall } from "./types.js";
import { ToolRouter, classifyCommandIntent } from "./tools.js";

export interface TurnRequest {
  session: SessionContext;
  messages: Array<{ role: string; content: string }>;
}

export interface TurnResult {
  runId: string;
  assistantText: string;
  events: RuntimeEvent[];
}

export type RuntimeEventType =
  | "queued"
  | "started"
  | "tool"
  | "assistant"
  | "compaction"
  | "completed"
  | "failed";

export interface RuntimeEvent {
  type: RuntimeEventType;
  runId: string;
  sessionId: string;
  payload?: unknown;
  at: string;
}

interface PendingTurn {
  runId: string;
  request: TurnRequest;
  execute: () => Promise<TurnResult>;
  resolve: (result: TurnResult) => void;
  reject: (error: unknown) => void;
}

interface SessionQueueState {
  running: boolean;
  queue: PendingTurn[];
}

export class SessionQueue {
  private readonly sessions = new Map<string, SessionQueueState>();
  private readonly warnings: string[] = [];

  constructor(
    private readonly options: {
      softLimit: number;
      hardLimit: number;
      dropStrategy: "drop-oldest" | "defer-new";
    }
  ) {}

  getWarnings(): string[] {
    return [...this.warnings];
  }

  enqueue(turn: PendingTurn): Promise<TurnResult> {
    const resultPromise = new Promise<TurnResult>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    const key = turn.request.session.sessionId;
    const state = this.sessions.get(key) ?? { running: false, queue: [] };
    const depth = state.queue.length + (state.running ? 1 : 0);
    if (depth >= this.options.softLimit) {
      this.warnings.push(`soft queue depth reached for session ${key}: ${depth}`);
    }

    if (depth >= this.options.hardLimit) {
      if (this.options.dropStrategy === "defer-new") {
        const error = new Error(`hard queue cap reached for session ${key}`);
        turn.reject(error);
        return resultPromise;
      }
      const dropped = state.queue.shift();
      if (dropped) {
        dropped.reject(new Error("dropped due to queue cap"));
      } else if (state.running) {
        const error = new Error(`queue cap reached and no drop candidate for session ${key}`);
        turn.reject(error);
        return resultPromise;
      }
    }

    state.queue.push(turn);
    this.sessions.set(key, state);
    this.drain(key).catch((error) => {
      this.warnings.push(`drain failure for session ${key}: ${String(error)}`);
    });
    return resultPromise;
  }

  private async drain(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.running) {
      return;
    }
    state.running = true;
    while (state.queue.length > 0) {
      const item = state.queue.shift();
      if (!item) {
        continue;
      }
      try {
        const result = await item.execute();
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }
    }
    state.running = false;
  }
}

export interface AgentRuntimeOptions {
  config: CursorClawConfig;
  adapter: CursorAgentModelAdapter;
  toolRouter: ToolRouter;
  memory: MemoryStore;
  pluginHost?: PluginHost;
  observationStore?: RuntimeObservationStore;
  decisionJournal?: DecisionJournal;
  failureLoopGuard?: FailureLoopGuard;
  gitCheckpointManager?: GitCheckpointManager;
  privacyScrubber?: PrivacyScrubber;
  snapshotDir: string;
  onEvent?: (event: RuntimeEvent) => void;
}

export class AgentRuntime {
  private readonly queue: SessionQueue;
  private readonly decisionLogs: PolicyDecisionLog[] = [];
  private readonly sessionHandles = new Map<string, string>();
  private readonly metrics = {
    turnsStarted: 0,
    turnsCompleted: 0,
    turnsFailed: 0,
    toolCalls: 0
  };
  private readonly maxDecisionLogs = 5_000;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.queue = new SessionQueue({
      softLimit: options.config.session.queueSoftLimit,
      hardLimit: options.config.session.queueHardLimit,
      dropStrategy: options.config.session.queueDropStrategy
    });
  }

  getDecisionLogs(): PolicyDecisionLog[] {
    return [...this.decisionLogs];
  }

  getQueueWarnings(): string[] {
    return this.queue.getWarnings();
  }

  getMetrics(): {
    turnsStarted: number;
    turnsCompleted: number;
    turnsFailed: number;
    toolCalls: number;
  } {
    return { ...this.metrics };
  }

  startTurn(request: TurnRequest): { runId: string; promise: Promise<TurnResult> } {
    const runId = randomUUID();
    const promise = this.scheduleTurn(runId, request);
    return { runId, promise };
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const { promise } = this.startTurn(request);
    return promise;
  }

  private scheduleTurn(runId: string, request: TurnRequest): Promise<TurnResult> {
    const pending: PendingTurn = {
      runId,
      request,
      execute: async () => {
        const scrubScopeId = `${request.session.sessionId}:${runId}`;
        const shouldForceMultiPath =
          this.options.failureLoopGuard?.requiresStepBack(request.session.sessionId) ?? false;
        let checkpointHandle: GitCheckpointHandle | null = null;
        let assistantText = "";
        try {
          emit("started");
          this.metrics.turnsStarted += 1;
          if (shouldForceMultiPath) {
            await this.options.decisionJournal?.append({
              type: "multi-path-escalation",
              summary: "Forced multi-path reasoning after repeated failures",
              metadata: {
                runId,
                sessionId: request.session.sessionId,
                failureCount: this.options.failureLoopGuard?.getFailureCount(request.session.sessionId) ?? 0
              }
            });
          }
          const modelSession = await this.ensureModelSession(request.session);
          const promptMessages = await this.buildPromptMessages(
            request,
            runId,
            scrubScopeId,
            shouldForceMultiPath
          );
          const adapterStream = this.options.adapter.sendTurn(
            modelSession,
            promptMessages,
            this.options.toolRouter.list(),
            {
              turnId: runId,
              timeoutMs: this.options.config.session.turnTimeoutMs
            }
          );
          let emittedCount = 2;
          for await (const event of adapterStream) {
            if (event.type === "assistant_delta") {
              const rawContent = String((event.data as { content?: string })?.content ?? "");
              const content = this.scrubText(rawContent, scrubScopeId);
              assistantText += content;
              emit("assistant", { content });
              emittedCount += 1;
            } else if (event.type === "tool_call") {
              const call = event.data as ToolCall;
              if (!checkpointHandle && this.shouldCreateCheckpoint(call)) {
                checkpointHandle = await this.options.gitCheckpointManager?.createCheckpoint(runId) ?? null;
              }
              const output = await this.options.toolRouter.execute(call, {
                auditId: runId,
                decisionLogs: this.decisionLogs
              });
              const safeCall = this.scrubUnknown(call, scrubScopeId) as ToolCall;
              const safeOutput = this.scrubUnknown(output, scrubScopeId);
              this.metrics.toolCalls += 1;
              if (this.decisionLogs.length > this.maxDecisionLogs) {
                this.decisionLogs.splice(0, this.decisionLogs.length - this.maxDecisionLogs);
              }
              emit("tool", { call: safeCall, output: safeOutput });
              emittedCount += 1;
            } else if (event.type === "error") {
              throw new Error(`adapter error: ${JSON.stringify(event.data)}`);
            } else if (event.type === "done") {
              break;
            }
            if (
              emittedCount > 0 &&
              emittedCount % this.options.config.session.snapshotEveryEvents === 0
            ) {
              await this.snapshot(runId, request.session.sessionId, events);
            }
          }

          if (checkpointHandle && this.options.gitCheckpointManager) {
            const check = await this.options.gitCheckpointManager.verifyReliabilityChecks();
            if (!check.ok) {
              await this.options.gitCheckpointManager.rollback(checkpointHandle);
              await this.options.decisionJournal?.append({
                type: "checkpoint-rollback",
                summary: "Reliability checks failed after checkpointed turn",
                ...(check.failedCommand !== undefined ? { detail: check.failedCommand } : {}),
                metadata: {
                  runId,
                  sessionId: request.session.sessionId,
                  checkpointRef: checkpointHandle.refName
                }
              });
              throw new Error(
                `reliability check failed${check.failedCommand ? ` (${check.failedCommand})` : ""}`
              );
            }
            await this.options.gitCheckpointManager.cleanup(checkpointHandle);
            checkpointHandle = null;
          }

          if (assistantText.length > 3_000) {
            if (this.options.config.compaction.memoryFlush) {
              await this.options.memory.flushPreCompaction(request.session.sessionId);
            }
            emit("compaction", { reason: "assistant text exceeded 3000 chars" });
          }

          await this.options.memory.append({
            sessionId: request.session.sessionId,
            category: "turn-summary",
            text: assistantText.slice(0, 500),
            provenance: {
              sourceChannel: request.session.channelId,
              confidence: 0.8,
              timestamp: new Date().toISOString(),
              sensitivity: "operational"
            }
          });

          emit("completed", { chars: assistantText.length });
          this.metrics.turnsCompleted += 1;
          this.options.failureLoopGuard?.recordSuccess(request.session.sessionId);
          await this.snapshot(runId, request.session.sessionId, events);
          return { runId, assistantText, events };
        } catch (error) {
          const safeError = this.scrubText(String(error), scrubScopeId);
          emit("failed", { error: safeError });
          this.metrics.turnsFailed += 1;
          this.options.failureLoopGuard?.recordFailure(request.session.sessionId, error);
          await this.options.observationStore?.append({
            sessionId: request.session.sessionId,
            source: "runtime",
            kind: "turn-failure",
            sensitivity: "operational",
            payload: {
              runId,
              error: safeError
            }
          });
          await this.options.decisionJournal?.append({
            type: "turn-failure",
            summary: "Turn failed",
            detail: safeError,
            metadata: {
              runId,
              sessionId: request.session.sessionId
            }
          });
          if (checkpointHandle && this.options.gitCheckpointManager) {
            await this.options.gitCheckpointManager.rollback(checkpointHandle);
            await this.options.gitCheckpointManager.cleanup(checkpointHandle);
            checkpointHandle = null;
          }
          await this.snapshot(runId, request.session.sessionId, events);
          throw error;
        } finally {
          this.options.privacyScrubber?.clearScope(scrubScopeId);
        }
      },
      resolve: () => undefined,
      reject: () => undefined
    };
    const events: RuntimeEvent[] = [];
    const emit = (type: RuntimeEventType, payload?: unknown): void => {
      const event: RuntimeEvent = {
        type,
        runId,
        sessionId: request.session.sessionId,
        payload,
        at: new Date().toISOString()
      };
      events.push(event);
      this.options.onEvent?.(event);
    };
    emit("queued");

    return this.queue.enqueue(pending);
  }

  private async ensureModelSession(context: SessionContext) {
    const existingId = this.sessionHandles.get(context.sessionId);
    if (existingId) {
      const handle: {
        id: string;
        model: string;
        authProfile?: string;
      } = {
        id: existingId,
        model: this.options.config.defaultModel
      };
      const profile = this.options.config.models[this.options.config.defaultModel]?.authProfiles[0];
      if (profile !== undefined) {
        handle.authProfile = profile;
      }
      return handle;
    }
    const handle = await this.options.adapter.createSession(context);
    this.sessionHandles.set(context.sessionId, handle.id);
    return handle;
  }

  private async snapshot(runId: string, sessionId: string, events: RuntimeEvent[]): Promise<void> {
    await mkdir(this.options.snapshotDir, { recursive: true });
    const path = join(this.options.snapshotDir, `${sessionId}-${runId}.json`);
    await writeFile(
      path,
      JSON.stringify(
        {
          runId,
          sessionId,
          events
        },
        null,
        2
      ),
      "utf8"
    );
  }

  private async buildPromptMessages(
    request: TurnRequest,
    runId: string,
    scopeId: string,
    forceMultiPathReasoning: boolean
  ): Promise<Array<{ role: string; content: string }>> {
    const userMessages = request.messages.map((message) => ({
      role: message.role,
      content: this.scrubText(message.content, scopeId)
    }));
    const systemMessages: Array<{ role: string; content: string }> = [];

    if (forceMultiPathReasoning) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          [
            "Reliability escalation is active.",
            "Before proposing a fix, step back and provide three distinct architectural hypotheses.",
            "Then choose one with explicit verification signals and execute only that selected path."
          ].join(" "),
          scopeId
        )
      });
    }

    if (this.options.decisionJournal) {
      const recentDecisions = await this.options.decisionJournal.readRecent(5);
      if (recentDecisions.length > 0) {
        systemMessages.push({
          role: "system",
          content: this.scrubText(
            `Recent decision journal context:\n${recentDecisions.join("\n")}`,
            scopeId
          )
        });
      }
    }

    if (this.options.pluginHost) {
      const pluginResult = await this.options.pluginHost.run({
        runId,
        sessionId: request.session.sessionId,
        inputMessages: userMessages
      });
      for (const message of pluginResult.messages) {
        systemMessages.push({
          role: message.role,
          content: this.scrubText(message.content, scopeId)
        });
      }
      if (pluginResult.diagnostics.length > 0) {
        await this.options.observationStore?.append({
          sessionId: request.session.sessionId,
          source: "plugin-host",
          kind: "plugin-diagnostics",
          sensitivity: "operational",
          payload: {
            runId,
            diagnostics: pluginResult.diagnostics
          }
        });
      }
    } else {
      const memories = await this.options.memory.retrieveForSession({
        sessionId: request.session.sessionId,
        allowSecret: this.options.config.memory.includeSecretsInPrompt
      });
      const memoryContext = memories
        .slice(-10)
        .map((record) => `[${record.category}] ${record.text}`)
        .join("\n");
      if (memoryContext) {
        systemMessages.push({
          role: "system",
          content: this.scrubText(`Relevant session memory:\n${memoryContext}`, scopeId)
        });
      }
      if (this.options.observationStore) {
        const observations = await this.options.observationStore.listRecent({
          sessionId: request.session.sessionId,
          limit: 8
        });
        if (observations.length > 0) {
          const observationContext = observations
            .map((event) => `[${event.kind}] ${JSON.stringify(event.payload)}`)
            .join("\n");
          systemMessages.push({
            role: "system",
            content: this.scrubText(`Recent runtime observations:\n${observationContext}`, scopeId)
          });
        }
      }
    }

    return [...systemMessages, ...userMessages];
  }

  private scrubText(text: string, scopeId: string): string {
    const scrubber = this.options.privacyScrubber;
    if (!scrubber) {
      return text;
    }
    return scrubber.scrubText({ text, scopeId }).text;
  }

  private scrubUnknown(value: unknown, scopeId: string): unknown {
    const scrubber = this.options.privacyScrubber;
    if (!scrubber) {
      return value;
    }
    return scrubber.scrubUnknown(value, scopeId);
  }

  private shouldCreateCheckpoint(call: ToolCall): boolean {
    if (!this.options.gitCheckpointManager) {
      return false;
    }
    if (call.name !== "exec") {
      return call.name === "mcp_call_tool";
    }
    const parsed = call.args as { command?: string };
    if (!parsed.command) {
      return false;
    }
    const intent = classifyCommandIntent(parsed.command);
    return intent !== "read-only";
  }
}
