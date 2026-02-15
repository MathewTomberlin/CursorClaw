import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { getDefaultProfileId, getModelIdForProfile, type CursorClawConfig } from "./config.js";
import type { DecisionJournal } from "./decision-journal.js";
import type { MemoryStore } from "./memory.js";
import type { CursorAgentModelAdapter } from "./model-adapter.js";
import {
  ContextAnalyzerPlugin,
  MemoryCollectorPlugin,
  ObservationCollectorPlugin,
  PromptSynthesizerPlugin
} from "./plugins/builtins.js";
import { PluginHost } from "./plugins/host.js";
import type { PrivacyScrubber } from "./privacy/privacy-scrubber.js";
import type { FailureLoopGuard } from "./reliability/failure-loop.js";
import type { GitCheckpointHandle, GitCheckpointManager } from "./reliability/git-checkpoint.js";
import type { ConfidenceModel } from "./reliability/confidence-model.js";
import type { DeepScanService } from "./reliability/deep-scan.js";
import { type ActionEnvelope, clampConfidence } from "./reliability/action-envelope.js";
import type { ReasoningResetController } from "./reliability/reasoning-reset.js";
import type { RuntimeObservationStore } from "./runtime-observation.js";
import { scoreInboundRisk } from "./security.js";
import type { QueueBackend } from "./queue/types.js";
import { InMemoryQueueBackend } from "./queue/in-memory-backend.js";
import type { LifecycleStream } from "./lifecycle-stream/types.js";
import type { SubstrateContent } from "./substrate/index.js";
import type { PolicyDecisionLog, SendTurnOptions, SessionContext, ToolCall, ToolExecuteContext } from "./types.js";
import { ToolRouter, classifyCommandIntent } from "./tools.js";

type RuntimeMessage = {
  role: string;
  content: string;
};

export interface TurnRequest {
  session: SessionContext;
  messages: RuntimeMessage[];
}

export interface TurnResult {
  runId: string;
  assistantText: string;
  events: RuntimeEvent[];
  confidenceScore?: number;
  confidenceRationale?: string[];
  requiresHumanHint?: boolean;
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
}

export class SessionQueue {
  private readonly sessions = new Map<string, SessionQueueState>();
  private readonly warnings: string[] = [];

  constructor(
    private readonly backend: QueueBackend,
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
    void this.enqueueAsync(key, turn).catch(() => {});
    return resultPromise;
  }

  private async enqueueAsync(key: string, turn: PendingTurn): Promise<void> {
    const state = this.sessions.get(key) ?? { running: false };
    const pendingIds = await this.backend.listPending(key);
    const depth = pendingIds.length + (state.running ? 1 : 0);
    if (depth >= this.options.softLimit) {
      this.warnings.push(`soft queue depth reached for session ${key}: ${depth}`);
    }

    if (depth >= this.options.hardLimit) {
      if (this.options.dropStrategy === "defer-new") {
        turn.reject(new Error(`hard queue cap reached for session ${key}`));
        return;
      }
      const droppedPayload = await this.backend.dequeue(key);
      if (droppedPayload) {
        (droppedPayload as PendingTurn).reject(new Error("dropped due to queue cap"));
      } else if (state.running) {
        turn.reject(new Error(`queue cap reached and no drop candidate for session ${key}`));
        return;
      }
    }

    await this.backend.enqueue(key, turn);
    this.sessions.set(key, state);
    this.drain(key).catch((error) => {
      this.warnings.push(`drain failure for session ${key}: ${String(error)}`);
    });
  }

  private async drain(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.running) {
      return;
    }
    state.running = true;
    for (;;) {
      const payload = await this.backend.dequeue(sessionId);
      if (payload == null) {
        break;
      }
      const item = payload as PendingTurn;
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
  reasoningResetController?: ReasoningResetController;
  deepScanService?: DeepScanService;
  confidenceModel?: ConfidenceModel;
  lowConfidenceThreshold?: number;
  hasRecentTestsPassing?: () => Promise<boolean>;
  gitCheckpointManager?: GitCheckpointManager;
  privacyScrubber?: PrivacyScrubber;
  queueBackend?: QueueBackend;
  lifecycleStream?: LifecycleStream;
  snapshotDir: string;
  onEvent?: (event: RuntimeEvent) => void;
  /** When set, used each turn to get current substrate (Identity, Soul, etc.) for the system prompt. */
  getSubstrate?: () => SubstrateContent;
  /** When set, used to resolve profile root for the current turn (e.g. for profile-scoped provider API keys). */
  getProfileRoot?: (profileId: string) => string | undefined;
  /** When set, used for main session only to load MEMORY.md + memory/today+yesterday and inject into system prompt. */
  getSessionMemoryContext?: (profileRoot: string) => Promise<string | undefined>;
  /** When set, called for main session; if it returns a string, injected once as a system notice (e.g. "Previous run was interrupted by process restart"). */
  getInterruptedRunNotice?: () => Promise<string | undefined>;
}

export class AgentRuntime {
  private readonly queue: SessionQueue;
  private readonly promptPluginHost: PluginHost;
  private readonly decisionLogs: PolicyDecisionLog[] = [];
  private readonly sessionHandles = new Map<string, { id: string; model: string; authProfile?: string }>();
  private readonly metrics = {
    turnsStarted: 0,
    turnsCompleted: 0,
    turnsFailed: 0,
    toolCalls: 0
  };
  private readonly maxDecisionLogs = 5_000;
  private readonly touchedFileHintsBySession = new Map<string, Set<string>>();
  private readonly multiPathResolutionEvents: Array<{ at: number; outcome: "success" | "failure" }> = [];
  private static readonly MULTI_PATH_RESOLUTION_MAX = 100;
  /** Session IDs that have had at least one turn (used to inject BIRTH only on first turn per session). */
  private readonly sessionsWithTurn = new Set<string>();
  /** Current runId per session so heartbeat can be cancelled when user sends a message. */
  private readonly currentRunIdBySession = new Map<string, string>();

  constructor(private readonly options: AgentRuntimeOptions) {
    const queueBackend = options.queueBackend ?? new InMemoryQueueBackend();
    this.queue = new SessionQueue(queueBackend, {
      softLimit: options.config.session.queueSoftLimit,
      hardLimit: options.config.session.queueHardLimit,
      dropStrategy: options.config.session.queueDropStrategy
    });
    this.promptPluginHost =
      options.pluginHost ??
      createDefaultPromptPluginHost({
        memory: options.memory,
        allowSecretMemory: options.config.memory.includeSecretsInPrompt,
        ...(options.observationStore ? { observationStore: options.observationStore } : {})
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

  getMultiPathResolutionsLast24h(): { success: number; failure: number } {
    const floor = Date.now() - 24 * 60 * 60 * 1000;
    const recent = this.multiPathResolutionEvents.filter((e) => e.at >= floor);
    return {
      success: recent.filter((e) => e.outcome === "success").length,
      failure: recent.filter((e) => e.outcome === "failure").length
    };
  }

  /** Adapter metrics if the adapter exposes getMetrics (e.g. CursorAgentModelAdapter). */
  getAdapterMetrics(): unknown {
    const adapter = this.options.adapter as { getMetrics?: () => unknown };
    return adapter.getMetrics?.();
  }

  /**
   * Cancel the in-flight turn for a session (e.g. heartbeat:main) so user turns can run first.
   * No-op if that session has no running turn. Used when agent.run is received for a user session.
   */
  cancelTurnForSession(sessionId: string): void {
    const runId = this.currentRunIdBySession.get(sessionId);
    if (runId) {
      void this.options.adapter.cancel(runId).catch(() => {});
    }
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
        const sessionId = request.session.sessionId;
        this.currentRunIdBySession.set(sessionId, runId);
        const scrubScopeId = `${sessionId}:${runId}`;
        const shouldForceMultiPath =
          this.options.failureLoopGuard?.requiresStepBack(sessionId) ?? false;
        const resetState = this.options.reasoningResetController?.noteIteration(sessionId);
        const shouldInvalidateAssumptions = resetState?.shouldReset ?? false;
        let deepScanSummary: string | null = null;
        let deepScanIncluded = false;
        let preliminaryConfidenceScore: number | undefined;
        let preliminaryConfidenceRationale: string[] | undefined;
        let checkpointHandle: GitCheckpointHandle | null = null;
        let assistantText = "";
        let toolCallCountThisTurn = 0;
        let pluginDiagnosticCount = 0;
        try {
          emit("started");
          this.metrics.turnsStarted += 1;
          if (shouldInvalidateAssumptions && this.options.deepScanService) {
            const deepScan = await this.options.deepScanService.scanRecentlyTouched({
              hours: 24,
              additionalFiles: [...(this.touchedFileHintsBySession.get(sessionId) ?? new Set<string>())]
            });
            deepScanSummary = [
              `Reasoning reset triggered (reset count=${resetState?.resetCount ?? 0}).`,
              `Deep scan touched files (${deepScan.touchedFiles.length}): ${deepScan.touchedFiles.slice(0, 12).join(", ")}`,
              deepScan.configCandidates.length > 0
                ? `Config/build/env candidates: ${deepScan.configCandidates.slice(0, 12).join(", ")}`
                : "Config/build/env candidates: none detected"
            ].join("\n");
            deepScanIncluded = true;
            await this.options.decisionJournal?.append({
              type: "reasoning-reset",
              summary: "Invalidated assumptions and executed 24h deep scan",
              metadata: {
                runId,
                sessionId,
                touchedFiles: deepScan.touchedFiles.slice(0, 30),
                configCandidates: deepScan.configCandidates.slice(0, 30)
              }
            });
          }
          if (shouldForceMultiPath) {
            await this.options.decisionJournal?.append({
              type: "multi-path-escalation",
              summary: "Forced multi-path reasoning after repeated failures",
              metadata: {
                runId,
                sessionId,
                failureCount: this.options.failureLoopGuard?.getFailureCount(sessionId) ?? 0
              }
            });
          }
          const hasRecentTestsPassing = await this.resolveRecentTestSignal();
          if (this.options.confidenceModel) {
            const preConfidence = this.options.confidenceModel.score({
              failureCount: this.options.failureLoopGuard?.getFailureCount(sessionId) ?? 0,
              hasDeepScan: deepScanIncluded,
              pluginDiagnosticCount: 0,
              toolCallCount: 0,
              hasRecentTestsPassing
            });
            preliminaryConfidenceScore = preConfidence.score;
            preliminaryConfidenceRationale = preConfidence.rationale;
            if (preConfidence.score < (this.options.lowConfidenceThreshold ?? 60)) {
              const hintText = this.createHintRequestMessage(preConfidence.score, preConfidence.rationale);
              assistantText = hintText;
              emit("assistant", { content: hintText });
              const envelope = this.buildActionEnvelope({
                runId,
                sessionId,
                actionType: "hint-request",
                confidenceScore: preConfidence.score,
                confidenceRationale: preConfidence.rationale,
                requiresHumanHint: true
              });
              emit("completed", {
                chars: assistantText.length,
                actionEnvelope: envelope
              });
              await this.options.observationStore?.append({
                sessionId,
                source: "runtime",
                kind: "action-envelope",
                sensitivity: "operational",
                payload: envelope
              });
              this.metrics.turnsCompleted += 1;
              await this.snapshot(runId, sessionId, events);
              return {
                runId,
                assistantText,
                events,
                confidenceScore: preConfidence.score,
                confidenceRationale: preConfidence.rationale,
                requiresHumanHint: true
              };
            }
          }
          const modelSession = await this.ensureModelSession(request.session);
          const promptBuild = await this.buildPromptMessages(
            request,
            runId,
            scrubScopeId,
            shouldForceMultiPath,
            deepScanSummary
          );
          pluginDiagnosticCount = promptBuild.pluginDiagnosticCount;
          const promptMessages = promptBuild.messages;
          const lastUserContent =
            request.messages.filter((m) => m.role === "user").pop()?.content ?? "";
          const inboundRisk = scoreInboundRisk({
            senderTrusted: false,
            recentTriggerCount: 0,
            text: lastUserContent
          });
          const turnProvenance = inboundRisk >= 70 ? ("untrusted" as const) : ("operator" as const);

          const profileId = request.session.profileId ?? getDefaultProfileId(this.options.config);
          const profileRoot = this.options.getProfileRoot?.(profileId);

          const sendOptions: SendTurnOptions = {
            turnId: runId,
            timeoutMs: this.options.config.session.turnTimeoutMs,
            ...(profileRoot !== undefined && profileRoot !== "" ? { profileRoot } : {})
          };
          const adapterStream = this.options.adapter.sendTurn(
            modelSession,
            promptMessages,
            this.options.toolRouter.list(),
            sendOptions
          );
          let emittedCount = 2;
          for await (const event of adapterStream) {
            if (event.type === "assistant_delta") {
              const rawContent = String((event.data as { content?: string })?.content ?? "");
              const content = this.scrubText(rawContent, scrubScopeId);
              if (content === assistantText) {
                // Exact duplicate (e.g. CLI sent deltas then full message); skip emit
              } else if (content.length >= assistantText.length && content.startsWith(assistantText)) {
                assistantText = content;
                emit("assistant", { content });
              } else if (content.length >= 15 && assistantText.includes(content)) {
                // Skip duplicate segment (e.g. Cursor CLI re-sending same chunk)
              } else {
                assistantText += content;
                emit("assistant", { content });
              }
              emittedCount += 1;
            } else if (event.type === "tool_call") {
              const call = event.data as ToolCall;
              this.recordTouchedFileHints(sessionId, this.extractTouchedFileHints(call));
              if (!checkpointHandle && this.shouldCreateCheckpoint(call)) {
                checkpointHandle = await this.options.gitCheckpointManager?.createCheckpoint(runId) ?? null;
              }
              const profileRootForTool = this.options.getProfileRoot?.(request.session.profileId ?? getDefaultProfileId(this.options.config));
              const toolContext: ToolExecuteContext = {
                auditId: runId,
                decisionLogs: this.decisionLogs,
                provenance: turnProvenance,
                ...(profileRootForTool !== undefined && profileRootForTool !== "" ? { profileRoot: profileRootForTool } : {}),
                ...(request.session.channelKind !== undefined ? { channelKind: request.session.channelKind } : {}),
                ...(request.session.sessionId !== undefined ? { sessionId: request.session.sessionId } : {})
              };
              const output = await this.options.toolRouter.execute(call, toolContext);
              const safeCall = this.scrubUnknown(call, scrubScopeId) as ToolCall;
              const safeOutput = this.scrubUnknown(output, scrubScopeId);
              this.metrics.toolCalls += 1;
              toolCallCountThisTurn += 1;
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

          this.metrics.turnsCompleted += 1;
          this.options.failureLoopGuard?.recordSuccess(sessionId);
          if (shouldForceMultiPath) {
            this.multiPathResolutionEvents.push({ at: Date.now(), outcome: "success" });
            if (this.multiPathResolutionEvents.length > AgentRuntime.MULTI_PATH_RESOLUTION_MAX) {
              this.multiPathResolutionEvents.shift();
            }
          }
          this.options.reasoningResetController?.noteTaskResolved(sessionId);
          const hasRecentTestsPassingAfterTurn = await this.resolveRecentTestSignal();
          const postConfidence = this.options.confidenceModel?.score({
            failureCount: this.options.failureLoopGuard?.getFailureCount(sessionId) ?? 0,
            hasDeepScan: deepScanIncluded,
            pluginDiagnosticCount,
            toolCallCount: toolCallCountThisTurn,
            hasRecentTestsPassing: hasRecentTestsPassingAfterTurn
          });
          const confidenceScore = clampConfidence(
            postConfidence?.score ?? preliminaryConfidenceScore ?? 80
          );
          const confidenceRationale = postConfidence?.rationale ?? preliminaryConfidenceRationale ?? [];
          const actionEnvelope = this.buildActionEnvelope({
            runId,
            sessionId,
            actionType: "turn-complete",
            confidenceScore,
            confidenceRationale,
            requiresHumanHint: false
          });
          emit("completed", {
            chars: assistantText.length,
            actionEnvelope
          });
          await this.options.observationStore?.append({
            sessionId,
            source: "runtime",
            kind: "action-envelope",
            sensitivity: "operational",
            payload: actionEnvelope
          });
          await this.snapshot(runId, sessionId, events);
          return {
            runId,
            assistantText,
            events,
            confidenceScore,
            confidenceRationale,
            requiresHumanHint: false
          };
        } catch (error) {
          const safeError = this.scrubText(String(error), scrubScopeId);
          const hasRecentTestsPassing = await this.resolveRecentTestSignal();
          const failureConfidence = this.options.confidenceModel?.score({
            failureCount: (this.options.failureLoopGuard?.getFailureCount(sessionId) ?? 0) + 1,
            hasDeepScan: deepScanIncluded,
            pluginDiagnosticCount,
            toolCallCount: toolCallCountThisTurn,
            hasRecentTestsPassing
          });
          const failureEnvelope = this.buildActionEnvelope({
            runId,
            sessionId,
            actionType: "turn-failed",
            confidenceScore: failureConfidence?.score ?? 35,
            confidenceRationale: failureConfidence?.rationale ?? ["runtime-error"],
            requiresHumanHint: (failureConfidence?.score ?? 35) < (this.options.lowConfidenceThreshold ?? 60)
          });
          emit("failed", {
            error: safeError,
            actionEnvelope: failureEnvelope
          });
          this.metrics.turnsFailed += 1;
          this.options.failureLoopGuard?.recordFailure(sessionId, error);
          if (shouldForceMultiPath) {
            this.multiPathResolutionEvents.push({ at: Date.now(), outcome: "failure" });
            if (this.multiPathResolutionEvents.length > AgentRuntime.MULTI_PATH_RESOLUTION_MAX) {
              this.multiPathResolutionEvents.shift();
            }
          }
          await this.options.observationStore?.append({
            sessionId,
            source: "runtime",
            kind: "turn-failure",
            sensitivity: "operational",
            payload: {
              runId,
              error: safeError,
              actionEnvelope: failureEnvelope
            }
          });
          await this.options.decisionJournal?.append({
            type: "turn-failure",
            summary: "Turn failed",
            detail: safeError,
            metadata: {
              runId,
              sessionId
            }
          });
          if (checkpointHandle && this.options.gitCheckpointManager) {
            await this.options.gitCheckpointManager.rollback(checkpointHandle);
            await this.options.gitCheckpointManager.cleanup(checkpointHandle);
            checkpointHandle = null;
          }
          await this.snapshot(runId, sessionId, events);
          throw error;
        } finally {
          this.currentRunIdBySession.delete(sessionId);
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
      this.options.lifecycleStream?.push(event);
    };
    emit("queued");

    return this.queue.enqueue(pending);
  }

  private async ensureModelSession(context: SessionContext) {
    const stored = this.sessionHandles.get(context.sessionId);
    if (stored) return stored;
    const profileId = context.profileId ?? getDefaultProfileId(this.options.config);
    const modelId = getModelIdForProfile(this.options.config, profileId);
    const handle = await this.options.adapter.createSession(context, { modelId });
    this.sessionHandles.set(context.sessionId, {
      id: handle.id,
      model: handle.model,
      ...(handle.authProfile !== undefined ? { authProfile: handle.authProfile } : {})
    });
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
    forceMultiPathReasoning: boolean,
    deepScanSummary?: string | null
  ): Promise<{
    messages: Array<{ role: string; content: string }>;
    pluginDiagnosticCount: number;
  }> {
    const freshness = this.applyUserMessageFreshness(request.messages);
    const userMessages = freshness.messages.map((message) => ({
      role: message.role,
      content: this.scrubText(message.content, scopeId)
    }));
    const systemMessages: Array<{ role: string; content: string }> = [];

    const substrate = this.options.getSubstrate?.() ?? {};
    // AGENTS.md is the coordinating rules file (session start, memory, safety). Inject first so the agent
    // sees workspace rules before Identity/Soul/User; matches OpenClaw/Claude Code use of AGENTS.md as rules.
    if (substrate.agents?.trim()) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(`Workspace rules (AGENTS):\n\n${substrate.agents.trim()}`, scopeId)
      });
    }
    if (substrate.identity?.trim()) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(`Identity:\n\n${substrate.identity.trim()}`, scopeId)
      });
    }
    if (substrate.soul?.trim()) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(`Soul:\n\n${substrate.soul.trim()}`, scopeId)
      });
    }
    const isMainSession = request.session.channelKind === "web";
    if (isMainSession) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          "The user is chatting with you in the CursorClaw web UI (Chat tab in the browser at this server's URL). This is not Cursor IDE. Do not refer to Cursor IDE or cursor-auto; address the user in the web Chat context. Write clearly and avoid typos.",
          scopeId
        )
      });
    }
    if (substrate.user?.trim() && isMainSession) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(`User:\n\n${substrate.user.trim()}`, scopeId)
      });
    }

    if (isMainSession && this.options.getSessionMemoryContext && this.options.getProfileRoot) {
      const profileId = request.session.profileId ?? getDefaultProfileId(this.options.config);
      const profileRoot = this.options.getProfileRoot(profileId);
      if (profileRoot) {
        const memoryContext = await this.options.getSessionMemoryContext(profileRoot);
        if (memoryContext?.trim()) {
          systemMessages.push({
            role: "system",
            content: this.scrubText(`Session memory (for continuity):\n\n${memoryContext.trim()}`, scopeId)
          });
        }
      }
    }
    if (isMainSession && this.options.getInterruptedRunNotice) {
      const notice = await this.options.getInterruptedRunNotice();
      if (notice?.trim()) {
        systemMessages.push({
          role: "system",
          content: this.scrubText(notice.trim(), scopeId)
        });
      }
    }

    const isFirstTurnThisSession = !this.sessionsWithTurn.has(request.session.sessionId);
    if (isFirstTurnThisSession) {
      this.sessionsWithTurn.add(request.session.sessionId);
    }
    if (substrate.birth?.trim() && isFirstTurnThisSession) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(`Bootstrap (BIRTH):\n\n${substrate.birth.trim()}`, scopeId)
      });
    }

    const includeCapabilitiesInPrompt =
      this.options.config.substrate?.includeCapabilitiesInPrompt === true;
    if (includeCapabilitiesInPrompt && substrate.capabilities?.trim()) {
      const capText = substrate.capabilities.trim();
      const summary =
        capText.length <= 500 ? capText : `${capText.slice(0, 497)}...`;
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          `Capabilities (summary, subject to approval):\n\n${summary}`,
          scopeId
        )
      });
    }
    if (substrate.tools?.trim()) {
      const toolsText = substrate.tools.trim();
      const summary =
        toolsText.length <= 400 ? toolsText : `${toolsText.slice(0, 397)}...`;
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          `Tools (local notes, not enforcement):\n\n${summary}`,
          scopeId
        )
      });
    }

    if (freshness.summaryLine) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(freshness.summaryLine, scopeId)
      });
    }
    if (freshness.contradictions.length > 0) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          `Potential stale-instruction contradictions detected:\n${freshness.contradictions.join("\n")}`,
          scopeId
        )
      });
    }

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
    if (deepScanSummary) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          [
            "Assumption invalidation deep scan (last 24h) results:",
            deepScanSummary
          ].join("\n"),
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
            [
              "Recent decision journal context:",
              ...recentDecisions,
              "Maintain rationale continuity unless new runtime evidence contradicts prior decisions."
            ].join("\n"),
            scopeId
          )
        });
      }
    }

    const pluginResult = await this.promptPluginHost.run({
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
    await this.options.observationStore?.append({
      sessionId: request.session.sessionId,
      source: "runtime",
      kind: "context-freshness",
      sensitivity: "operational",
      payload: {
        runId,
        freshnessScore: freshness.score,
        contradictionCount: freshness.contradictions.length,
        originalMessageCount: request.messages.length,
        retainedMessageCount: freshness.messages.length
      }
    });

    const boundedSystemMessages = this.applySystemPromptBudget(systemMessages);
    return {
      messages: [...boundedSystemMessages, ...userMessages],
      pluginDiagnosticCount: pluginResult.diagnostics.length
    };
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

  private async resolveRecentTestSignal(): Promise<boolean> {
    if (!this.options.hasRecentTestsPassing) {
      return false;
    }
    try {
      return await this.options.hasRecentTestsPassing();
    } catch {
      return false;
    }
  }

  private createHintRequestMessage(score: number, rationale: string[]): string {
    const details = rationale.length > 0 ? ` (${rationale.join(", ")})` : "";
    return `Confidence score ${score} is below threshold. I need a human hint before proceeding${details}.`;
  }

  private buildActionEnvelope(args: {
    runId: string;
    sessionId: string;
    actionType: string;
    confidenceScore: number;
    confidenceRationale: string[];
    requiresHumanHint: boolean;
  }): ActionEnvelope {
    return {
      actionId: randomUUID(),
      at: new Date().toISOString(),
      runId: args.runId,
      sessionId: args.sessionId,
      actionType: args.actionType,
      confidenceScore: clampConfidence(args.confidenceScore),
      confidenceRationale: [...args.confidenceRationale],
      requiresHumanHint: args.requiresHumanHint
    };
  }

  private recordTouchedFileHints(sessionId: string, hints: string[]): void {
    if (hints.length === 0) {
      return;
    }
    const set = this.touchedFileHintsBySession.get(sessionId) ?? new Set<string>();
    for (const hint of hints) {
      set.add(hint);
    }
    if (set.size > 300) {
      const trimmed = [...set].slice(set.size - 300);
      this.touchedFileHintsBySession.set(sessionId, new Set(trimmed));
      return;
    }
    this.touchedFileHintsBySession.set(sessionId, set);
  }

  private applyUserMessageFreshness(messages: RuntimeMessage[]): {
    messages: RuntimeMessage[];
    score: number;
    summaryLine?: string;
    contradictions: string[];
  } {
    const maxRetained = 8;
    const retained = messages.slice(-maxRetained);
    const droppedCount = Math.max(0, messages.length - retained.length);
    const score = Math.round((retained.length / Math.max(1, messages.length)) * 100);
    const contradictions = detectInstructionContradictions(retained);
    const summaryLine =
      droppedCount > 0
        ? `Context freshness policy retained ${retained.length}/${messages.length} latest messages and deprioritized ${droppedCount} stale entries.`
        : undefined;
    return {
      messages: retained,
      score,
      ...(summaryLine ? { summaryLine } : {}),
      contradictions
    };
  }

  private extractTouchedFileHints(call: ToolCall): string[] {
    if (call.name !== "exec") {
      return [];
    }
    const command = String((call.args as { command?: string })?.command ?? "");
    if (!command) {
      return [];
    }
    const tokens = command.split(/\s+/).filter((token) => token.length > 0);
    return tokens
      .filter((token) =>
        /\.(ts|tsx|js|jsx|json|md|yaml|yml|toml|env|py|go|rs|java|conf|ini)$/.test(token)
      )
      .slice(0, 40);
  }

  private applySystemPromptBudget(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
    const perMessageMax = this.options.config.session.maxMessageChars;
    const totalSystemBudget = Math.max(perMessageMax, Math.floor(perMessageMax * 1.5));
    let remaining = totalSystemBudget;
    const out: Array<{ role: string; content: string }> = [];
    for (const message of messages) {
      if (remaining <= 0) {
        break;
      }
      const bounded = message.content.slice(0, Math.min(perMessageMax, remaining));
      if (bounded.length === 0) {
        continue;
      }
      out.push({
        role: message.role,
        content: bounded
      });
      remaining -= bounded.length;
    }
    return out;
  }
}

function createDefaultPromptPluginHost(args: {
  memory: MemoryStore;
  allowSecretMemory: boolean;
  observationStore?: RuntimeObservationStore;
}): PluginHost {
  const host = new PluginHost({
    defaultTimeoutMs: 2_000
  });
  host.registerCollector(new MemoryCollectorPlugin(args.memory, args.allowSecretMemory));
  if (args.observationStore) {
    host.registerCollector(new ObservationCollectorPlugin(args.observationStore));
  }
  host.registerAnalyzer(new ContextAnalyzerPlugin());
  host.registerSynthesizer(new PromptSynthesizerPlugin());
  return host;
}

function detectInstructionContradictions(messages: RuntimeMessage[]): string[] {
  const contradictions: string[] = [];
  const normalized = messages.map((message) => message.content.toLowerCase());
  const hasRunTests = normalized.some((content) => /\brun\s+tests?\b/.test(content));
  const hasSkipTests = normalized.some((content) => /\b(skip|avoid|do not run)\s+tests?\b/.test(content));
  if (hasRunTests && hasSkipTests) {
    contradictions.push("Conflicting directives found: both 'run tests' and 'skip tests'.");
  }
  const hasRefactor = normalized.some((content) => /\brefactor\b/.test(content));
  const hasNoRefactor = normalized.some((content) => /\bdo not refactor\b/.test(content));
  if (hasRefactor && hasNoRefactor) {
    contradictions.push("Conflicting directives found: both 'refactor' and 'do not refactor'.");
  }
  return contradictions;
}
