import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  getDefaultProfileId,
  getModelIdForProfile,
  type CursorClawConfig,
  type ModelProviderConfig
} from "./config.js";
import {
  applyMaxContextTokens,
  estimateTokens,
  summarizePrefix
} from "./max-context-tokens.js";
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
import type { ChatMessage, PolicyDecisionLog, SendTurnOptions, SessionContext, ToolCall, ToolExecuteContext } from "./types.js";
import { ToolRouter, classifyCommandIntent } from "./tools.js";

const NO_THINK_SUFFIX = " /no_think";

/** Returns a copy of messages with /no_think appended to the last user message content (for provider only; not stored in history). */
function applyNoThinkToMessages(messages: ChatMessage[]): ChatMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages;
  return messages.map((m, i) =>
    i === lastUserIdx
      ? { ...m, content: m.content + NO_THINK_SUFFIX }
      : { ...m }
  );
}

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
  | "streaming"
  | "thinking"
  | "tool"
  | "assistant"
  | "compaction"
  | "final_message_start"
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

/** Remove duplicate consecutive lines so repeated blocks in adapter/model output don't appear twice. */
function collapseDuplicateConsecutiveLines(text: string): string {
  if (!text || text.length < 2) return text;
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let prev = "";
  for (const line of lines) {
    if (line !== prev) {
      out.push(line);
      prev = line;
    }
  }
  return out.join("\n");
}

/**
 * If the text ends with a segment that was already present immediately before (e.g. adapter sent
 * full message then streamed again, or model echoed), remove the duplicated trailing copy.
 * Iterates longest suffix first so we remove the full duplicate (e.g. "Hello world. Hello world." → "Hello world.").
 * Exported for use when deduping heartbeat continuation proactive messages.
 */
export function removeDuplicatedTrailingSuffix(text: string): string {
  if (!text || text.length < 2) return text;
  for (let len = text.length - 1; len >= 1; len--) {
    const suffix = text.slice(-len);
    const before = text.slice(0, -len);
    if (before.endsWith(suffix)) return before;
  }
  return text;
}

/**
 * Remove a duplicated trailing paragraph: if the text ends with "\n\n" + a block that equals
 * the previous block (trimmed), drop the trailing copy (e.g. "A\n\nA" → "A"). Re-run until no change.
 * Also removes last paragraph if it duplicates any earlier paragraph (e.g. duplicated summary on heartbeat continuation).
 * Exported for use when deduping heartbeat continuation proactive messages.
 */
export function removeDuplicatedTrailingParagraph(text: string): string {
  if (!text || text.length < 2) return text;
  const parts = text.split(/\n\n+/);
  if (parts.length < 2) return text;
  let out = text;
  for (;;) {
    const segments = out.split(/\n\n+/);
    if (segments.length < 2) break;
    const last = segments[segments.length - 1]?.trim() ?? "";
    if (last === "") break;
    // Remove last paragraph if it duplicates the immediately previous one
    const prev = segments[segments.length - 2]?.trim() ?? "";
    if (last === prev) {
      out = segments.slice(0, -1).join("\n\n");
      if (out === text) break;
      text = out;
      continue;
    }
    // Remove last paragraph if it duplicates any earlier paragraph (e.g. duplicated "summary" block)
    const rest = segments.slice(0, -1);
    const duplicateIndex = rest.findIndex((s) => s.trim() === last);
    if (duplicateIndex >= 0) {
      out = rest.join("\n\n");
      if (out === text) break;
      text = out;
    } else {
      break;
    }
  }
  return out;
}

/** Remove model thinking/reasoning tags from text so they are not shown in the UI or stored in history. Handles <think>...</think> and <thinking>...</thinking>. */
export function stripThinkingTags(text: string): string {
  if (!text || text.length < 2) return text;
  let out = text;
  // <think>...</think> (case-insensitive for tag names)
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // <thinking>...</thinking>
  out = out.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  return out;
}

/** Remove tool_call and code-block content that should not be shown to the user. Strips <tool_call>...</tool_call> and fenced blocks that contain "tool_call". */
export function stripToolCallAndCodeBlocks(text: string): string {
  if (!text || text.length < 2) return text;
  let out = text;
  out = out.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  // Fenced code blocks (```...```) that contain tool_call
  out = out.replace(/```[\s\S]*?```/g, (block) =>
    /tool_call/i.test(block) ? "" : block
  );
  return out.replace(/\n\n+/g, "\n\n").trim();
}

/** Strip all non-user-visible content: thinking tags and tool/code blocks. Use for reply text shown in stream and final message. */
function stripReplyForUser(text: string): string {
  return stripToolCallAndCodeBlocks(stripThinkingTags(text));
}

/** Prefixes that indicate a paragraph is a summary/wrap-up (for deduping duplicated summaries on heartbeat continuation). */
const SUMMARY_LIKE_PREFIXES = /^(Summary|In summary|In short|TL;DR|Wrap-up|Bottom line|Overall|To summarize|In brief|That's it for|No further (updates?|progress)|Nothing else to report|All set for this (tick|cycle)|Done for now)\s*[:.]?\s*/i;

/**
 * Returns true if the trimmed paragraph looks like a summary or wrap-up block.
 */
function isSummaryLikeParagraph(paragraph: string): boolean {
  const t = paragraph.trim();
  if (t.length < 10) return false;
  return SUMMARY_LIKE_PREFIXES.test(t) || /\b(summary|wrap-up|bottom line)\s*[:.]/i.test(t.slice(0, 80));
}

/**
 * On heartbeat continuation the model sometimes appends a second summary paragraph that rephrases
 * the first; exact-paragraph dedup misses it. Remove the last paragraph if it is summary-like and
 * an earlier paragraph is also summary-like (root-cause fix for duplicated heartbeat output).
 * Re-runs until no change so multiple trailing summary duplicates are removed.
 * Exported for use when deduping heartbeat continuation proactive messages in index.
 */
export function removeDuplicateSummaryParagraph(text: string): string {
  if (!text || text.length < 2) return text;
  let out = text;
  for (;;) {
    const segments = out.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
    if (segments.length < 2) break;
    const last = segments[segments.length - 1] ?? "";
    if (!isSummaryLikeParagraph(last)) break;
    const rest = segments.slice(0, -1);
    const hasEarlierSummary = rest.some((s) => isSummaryLikeParagraph(s));
    if (!hasEarlierSummary) break;
    const next = rest.join("\n\n").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * On heartbeat continuation the model may append a rephrased summary in the middle or at the end,
 * so the middle paragraph looks different but is still a duplicate. Remove all summary-like
 * paragraphs except the first one (keeps one summary, drops any later "rephrased" summaries).
 * Exported for use when deduping heartbeat continuation proactive messages in index.
 */
export function removeAllButFirstSummaryParagraph(text: string): string {
  if (!text || text.length < 2) return text;
  const segments = text.split(/\n\n+/);
  if (segments.length < 2) return text;
  let seenSummary = false;
  const kept = segments.filter((seg) => {
    const t = seg.trim();
    if (t === "") return true;
    const isSummary = isSummaryLikeParagraph(t);
    if (isSummary && seenSummary) return false;
    if (isSummary) seenSummary = true;
    return true;
  });
  return kept.join("\n\n").replace(/\n\n+/g, "\n\n").trim();
}

/**
 * Decides whether to use minimal/tool-focused vs richer context for this turn when ollamaContextMode is "auto".
 * Exported for unit tests. See docs/context-aware-system-behavior.md.
 */
export function shouldUseMinimalToolContext(
  toolCount: number,
  lastUserContent: string,
  _modelConfig: ModelProviderConfig | undefined
): boolean {
  if (toolCount === 0) return false;
  const lower = lastUserContent.toLowerCase().trim();
  // Richer/conversational: prefer full context for explanations, chat, greetings, short replies
  const richer =
    /\b(explain|summarize|summarise|describe|what is|how does|why does|why is|tell me about|write a (short )?story|roleplay|chat)\b/i.test(
      lower
    ) || /\b(hi|hello|hey|thanks|thank you|ok|okay|got it|what do you think|sure|yes|no|why\?|really)\b/i.test(lower);
  if (richer) return false;
  // Tool-intent: file/substrate/workspace/edit/run/update
  const toolIntent =
    /\b(edit|update|run|read|write|substrate|ROADMAP|MEMORY|AGENTS\.md|IDENTITY\.md|file|folder|directory|exec|command|sed|cat|type)\b/i.test(
      lower
    ) || /[\w-]+\.(md|ts|js|json|txt)\b/.test(lastUserContent);
  if (toolIntent) return true;
  // Default when uncertain: use full context (conversational) so the model generates text instead of over-preferring tools.
  return false;
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
    const profileId = turn.request.session.profileId ?? "default";
    const key = `${profileId}:${turn.request.session.sessionId}`;
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
  /** Single memory store (used when getMemoryStore is not set, or as fallback). */
  memory?: MemoryStore;
  /** When set, used each turn to get the memory store for the run's profile so each agent gets its own MEMORY.md and daily files. */
  getMemoryStore?: (profileId: string) => MemoryStore;
  pluginHost?: PluginHost;
  observationStore?: RuntimeObservationStore;
  decisionJournal?: DecisionJournal;
  failureLoopGuard?: FailureLoopGuard;
  reasoningResetController?: ReasoningResetController;
  deepScanService?: DeepScanService;
  confidenceModel?: ConfidenceModel;
  lowConfidenceThreshold?: number;
  /** When true, do not block turns with "human hint" based on low confidence. */
  skipLowConfidenceGate?: boolean;
  hasRecentTestsPassing?: () => Promise<boolean>;
  gitCheckpointManager?: GitCheckpointManager;
  privacyScrubber?: PrivacyScrubber;
  queueBackend?: QueueBackend;
  lifecycleStream?: LifecycleStream;
  snapshotDir: string;
  onEvent?: (event: RuntimeEvent) => void;
  /** When set, used each turn to get current substrate (Identity, Soul, etc.) for the system prompt. Receives profileId so each agent gets its own substrate. */
  getSubstrate?: (profileId: string) => SubstrateContent;
  /** When set, used to resolve profile root for the current turn (e.g. for profile-scoped provider API keys). */
  getProfileRoot?: (profileId: string) => string | undefined;
  /** When set, used for main session only to load MEMORY.md + memory/today+yesterday and inject into system prompt. */
  getSessionMemoryContext?: (profileRoot: string) => Promise<string | undefined>;
  /** When set, used for main session only to load recent topics (conversation starters) for prompt injection. */
  getRecentTopicsContext?: (profileRoot: string) => Promise<string | undefined>;
  /** When set, called for main session when the first user message in a session is processed; records topic for recent-topics. */
  recordRecentTopic?: (profileRoot: string, sessionId: string, topic: string) => Promise<void>;
  /** When set, called for main session; if it returns a string, injected once as a system notice (e.g. "Previous run was interrupted by process restart"). */
  getInterruptedRunNotice?: () => Promise<string | undefined>;
  /** Process start time (ms since epoch). Used for decision journal replay mode "sinceLastSession". */
  sessionStartMs?: number;
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
    const defaultMemory =
      options.memory ??
      (options.getMemoryStore ? options.getMemoryStore(getDefaultProfileId(options.config)) : undefined);
    this.promptPluginHost =
      options.pluginHost ??
      createDefaultPromptPluginHost({
        memory: defaultMemory!,
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
          if (this.options.confidenceModel && !this.options.skipLowConfidenceGate) {
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
          let promptMessages = promptBuild.messages;
          const profileId = request.session.profileId ?? getDefaultProfileId(this.options.config);
          const modelId = getModelIdForProfile(this.options.config, profileId);
          const modelConfig = this.options.config.models[modelId];
          if (modelConfig?.maxContextTokens !== undefined && modelConfig.maxContextTokens > 0) {
            const cap = modelConfig.maxContextTokens;
            const totalTokens = promptMessages.reduce(
              (sum, m) => sum + estimateTokens(m.content),
              0
            );
            const summarize =
              modelConfig.summarizeOldTurns === true &&
              totalTokens > cap &&
              promptMessages.length > 1;
            if (summarize) {
              const maxSummaryTokens =
                modelConfig.summarizeOldTurnsMaxTokens ?? 200;
              const { summaryMessage, remainingMessages } = summarizePrefix(
                promptMessages,
                maxSummaryTokens
              );
              promptMessages = applyMaxContextTokens(
                [summaryMessage, ...remainingMessages],
                cap,
                modelConfig.truncationPriority
              );
            } else {
              promptMessages = applyMaxContextTokens(
                promptMessages,
                cap,
                modelConfig.truncationPriority
              );
            }
          }
          const lastUserContent =
            request.messages.filter((m) => m.role === "user").pop()?.content ?? "";
          const inboundRisk = scoreInboundRisk({
            senderTrusted: false,
            recentTriggerCount: 0,
            text: lastUserContent
          });
          const turnProvenance = inboundRisk >= 70 ? ("untrusted" as const) : ("operator" as const);

          const profileRoot = this.options.getProfileRoot?.(profileId);

          const sendOptions: SendTurnOptions = {
            turnId: runId,
            timeoutMs: this.options.config.session.turnTimeoutMs,
            ...(profileRoot !== undefined && profileRoot !== "" ? { profileRoot } : {})
          };
          /** For agent loop (Ollama / openai-compatible): messages to send (initial = promptMessages; then + assistant + tool results). */
          let currentMessages: ChatMessage[] = promptMessages.map((m) => ({ role: m.role, content: m.content }));
          const isOllama = modelConfig?.provider === "ollama";
          const isOpenAICompatible =
            modelConfig?.provider === "openai-compatible" || modelConfig?.provider === "lm-studio";
          const providerSupportsToolFollowUp = isOllama || isOpenAICompatible;
          /** Accumulated thinking across all rounds so we strip it from the final assistant message (CLI may send one full message after tool use). */
          let previousThinkingContent = "";

          while (true) {
            // Only the last round's reply is kept for the turn result; prior rounds (e.g. before tool follow-up) are discarded.
            assistantText = "";
            const messagesToSend =
              modelConfig?.no_think === true
                ? applyNoThinkToMessages(currentMessages)
                : currentMessages;
            const adapterStream = this.options.adapter.sendTurn(
              modelSession,
              messagesToSend,
              this.options.toolRouter.list(),
              sendOptions
            );
            let emittedCount = 2;
            /** This round's assistant text (for building assistant message when following up with tool results). */
            let thisRoundContent = "";
            /** Tool calls this round with outputs (for agent loop: assistant message + tool result messages). */
            const thisRoundToolCalls: Array<{ name: string; args: unknown; output: unknown; id?: string }> = [];
            /** Emit "streaming" once when we start consuming the adapter (so UI shows progress even if CLI buffers events). */
            let streamStartedEmitted = false;
            const maybeEmitStreaming = (): void => {
              if (!streamStartedEmitted) {
                streamStartedEmitted = true;
                emit("streaming");
              }
            };
            // Emit "streaming" immediately so status updates appear before first adapter event (e.g. Cursor-Agent CLI).
            maybeEmitStreaming();
            /** Emit final_message_start once when first assistant content arrives so UI clears thinking and shows append. */
            let finalMessageStartEmitted = false;

            for await (const event of adapterStream) {
              if (event.type === "thinking_delta") {
                maybeEmitStreaming();
                const data = event.data as { content?: string };
                const rawContent = String(data?.content ?? "");
                const content = this.scrubText(rawContent, scrubScopeId);
                if (content.length > 0) {
                  // Emit only the new part (delta) so UI replaces with this chunk only. If adapter sends full buffer each time, slice; if adapter sends deltas, treat content as chunk and accumulate.
                  const isFullBuffer = content.startsWith(previousThinkingContent);
                  const delta = isFullBuffer
                    ? content.slice(previousThinkingContent.length)
                    : content;
                  previousThinkingContent = isFullBuffer ? content : previousThinkingContent + content;
                  if (delta.length > 0) {
                    emit("thinking", { content: delta });
                    emittedCount += 1;
                  }
                }
              } else if (event.type === "assistant_delta") {
                maybeEmitStreaming();
                if (!finalMessageStartEmitted) {
                  finalMessageStartEmitted = true;
                  emit("final_message_start");
                }
                const data = event.data as { content?: string; isFullMessage?: boolean };
                const rawContent = String(data?.content ?? "");
                const content = this.scrubText(rawContent, scrubScopeId);
                // Strip any leading thinking we've already streamed so assistantText and client never see thinking in the reply (final message and stream are reply-only).
                let replyContent =
                  content.startsWith(previousThinkingContent)
                    ? content.slice(previousThinkingContent.length)
                    : content;
                replyContent = stripReplyForUser(replyContent);
                const isFullMessage = Boolean(data?.isFullMessage);
                if (replyContent.length === 0) {
                  emittedCount += 1;
                  continue;
                }
                // Thinking-only assistant_delta: content is exactly or a prefix of what we have as thinking; do not emit as assistant.
                if (
                  content.length <= previousThinkingContent.length &&
                  previousThinkingContent.startsWith(content)
                ) {
                  emittedCount += 1;
                  continue;
                }
                if (isFullMessage) {
                  // Only replace when content is the full message so far (extends or equals assistantText). If adapter sends multiple "full" segments, append so we don't overwrite.
                  if (
                    assistantText.length === 0 ||
                    (replyContent.length >= assistantText.length && replyContent.startsWith(assistantText))
                  ) {
                    assistantText = replyContent;
                    thisRoundContent = replyContent;
                    emit("assistant", { content: replyContent, replace: true });
                  } else {
                    assistantText += replyContent;
                    thisRoundContent += replyContent;
                    emit("assistant", { content: assistantText });
                  }
                } else if (replyContent === assistantText) {
                  // Exact duplicate (e.g. CLI sent deltas then full message); skip emit and accumulation
                } else if (replyContent.length >= assistantText.length && replyContent.startsWith(assistantText)) {
                  // Full-message replacement (e.g. CLI sent deltas then full message); replyContent is reply-only.
                  assistantText = replyContent;
                  thisRoundContent = replyContent;
                  emit("assistant", { content: replyContent, replace: true });
                } else if (
                  replyContent.length >= assistantText.length &&
                  assistantText.length >= 10 &&
                  (() => {
                    let overlap = 0;
                    const maxOverlap = Math.min(assistantText.length, replyContent.length);
                    for (let i = 0; i < maxOverlap && assistantText[i] === replyContent[i]; i++) overlap += 1;
                    return overlap >= assistantText.length * 0.8;
                  })()
                ) {
                  // Fuzzy replacement: placeholder was replaced (e.g. stream had HIGH_ENTROPY_TOKEN, final has real text); replyContent is reply-only.
                  assistantText = replyContent;
                  thisRoundContent = replyContent;
                  emit("assistant", { content: replyContent, replace: true });
                } else if (
                  assistantText.startsWith(replyContent) ||
                  (replyContent.length >= 15 && assistantText.includes(replyContent)) ||
                  (assistantText.endsWith(replyContent) && replyContent.length >= 1)
                ) {
                  // Skip: content is a prefix (e.g. CLI sent full message first then streamed same text); or duplicate segment; or duplicate trailing suffix (avoids duplicated final message). Do not add to thisRoundContent.
                } else {
                  assistantText += replyContent;
                  thisRoundContent += replyContent;
                  emit("assistant", { content: assistantText });
                }
                emittedCount += 1;
              } else if (event.type === "tool_call") {
                maybeEmitStreaming();
                const call = event.data as ToolCall;
                this.recordTouchedFileHints(sessionId, this.extractTouchedFileHints(call));
                if (!checkpointHandle && this.shouldCreateCheckpoint(call)) {
                  checkpointHandle = await this.options.gitCheckpointManager?.createCheckpoint(runId) ?? null;
                }
                const profileIdForTool = request.session.profileId ?? getDefaultProfileId(this.options.config);
                const profileRootForTool = this.options.getProfileRoot?.(profileIdForTool);
                const toolContext: ToolExecuteContext = {
                  auditId: runId,
                  decisionLogs: this.decisionLogs,
                  provenance: turnProvenance,
                  ...(profileIdForTool !== undefined ? { profileId: profileIdForTool } : {}),
                  ...(profileRootForTool !== undefined && profileRootForTool !== "" ? { profileRoot: profileRootForTool } : {}),
                  ...(request.session.channelKind !== undefined ? { channelKind: request.session.channelKind } : {}),
                  ...(request.session.sessionId !== undefined ? { sessionId: request.session.sessionId } : {})
                };
                const output = await this.options.toolRouter.execute(call, toolContext);
                thisRoundToolCalls.push({ name: call.name, args: call.args, output, ...(call.id !== undefined ? { id: call.id } : {}) });
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

            if (thisRoundToolCalls.length === 0 || !providerSupportsToolFollowUp) {
              break;
            }
            // Agent loop: send assistant message with tool_calls + tool result messages, then get final response (Ollama / openai-compatible).
            const toolCallIds = thisRoundToolCalls.map((tc) => tc.id ?? (isOpenAICompatible ? `call_${Math.random().toString(36).slice(2, 12)}` : undefined));
            const assistantMsg: ChatMessage = {
              role: "assistant",
              content: thisRoundContent,
              tool_calls: thisRoundToolCalls.map((tc, i) => ({
                type: "function" as const,
                ...(isOpenAICompatible && toolCallIds[i] ? { id: toolCallIds[i] } : {}),
                function: {
                  ...(isOllama ? { index: i } : {}),
                  name: tc.name,
                  arguments: (typeof tc.args === "object" && tc.args !== null ? tc.args : {}) as object
                }
              }))
            };
            const toolMsgs: ChatMessage[] = thisRoundToolCalls.map((tc, i) => {
              const base = {
                role: "tool" as const,
                content: typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output)
              };
              if (isOpenAICompatible && toolCallIds[i]) return { ...base, tool_call_id: toolCallIds[i] };
              return { ...base, tool_name: tc.name };
            });
            currentMessages = [...currentMessages, assistantMsg, ...toolMsgs];
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

          const memoryStore =
            this.options.getMemoryStore?.(request.session.profileId ?? getDefaultProfileId(this.options.config)) ??
            this.options.memory;
          if (assistantText.length > 3_000) {
            if (this.options.config.compaction.memoryFlush && memoryStore) {
              await memoryStore.flushPreCompaction(request.session.sessionId);
            }
            emit("compaction", { reason: "assistant text exceeded 3000 chars" });
          }

          assistantText = stripReplyForUser(assistantText);
          assistantText = removeDuplicatedTrailingSuffix(assistantText);
          assistantText = removeDuplicatedTrailingParagraph(assistantText);
          assistantText = collapseDuplicateConsecutiveLines(assistantText);
          // Heartbeat turns often get a second summary appended on continuation; dedup so we don't deliver duplicated content.
          if (request.session.sessionId.startsWith("heartbeat")) {
            assistantText = removeDuplicateSummaryParagraph(assistantText);
          }

          if (memoryStore) {
            await memoryStore.append({
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
          }

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
          // Final message = last round's assistantText only (reset at start of each round). Extension point: if a model/CLI later provides an explicit "final user message" (e.g. field or lifecycle event), prefer that over assistantText when building the turn result.
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

  /** Cache key so switching profile (e.g. Ollama → Cursor CLI) gets a new session with the correct model. */
  private sessionHandleKey(context: SessionContext): string {
    const profileId = context.profileId ?? getDefaultProfileId(this.options.config);
    return `${profileId}:${context.sessionId}`;
  }

  private async ensureModelSession(context: SessionContext) {
    const key = this.sessionHandleKey(context);
    const stored = this.sessionHandles.get(key);
    if (stored) return stored;
    const profileId = context.profileId ?? getDefaultProfileId(this.options.config);
    const modelId = getModelIdForProfile(this.options.config, profileId);
    const handle = await this.options.adapter.createSession(context, { modelId });
    this.sessionHandles.set(key, {
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
    let userMessages = freshness.messages.map((message) => ({
      role: message.role,
      content: this.scrubText(message.content, scopeId)
    }));
    const profileIdForSubstrate = request.session.profileId ?? getDefaultProfileId(this.options.config);
    const modelIdForTurn = getModelIdForProfile(this.options.config, profileIdForSubstrate);
    const modelConfigForTurn = this.options.config.models[modelIdForTurn];
    const toolList = this.options.toolRouter.list();
    const lastUser = [...freshness.messages].reverse().find((m) => m.role === "user");
    const lastUserContent = lastUser?.content ?? "";
    const hasLastUser = userMessages.length > 0 && lastUser !== undefined;

    let useMinimalContext: boolean;
    let useOllamaMinimalSystem: boolean;
    if (modelConfigForTurn?.provider === "ollama") {
      const mode = modelConfigForTurn.ollamaContextMode;
      if (mode === "full") {
        useMinimalContext = false;
        useOllamaMinimalSystem = false;
      } else if (mode === "minimal") {
        useMinimalContext = toolList.length > 0 && hasLastUser;
        useOllamaMinimalSystem = toolList.length > 0;
      } else if (mode === "auto") {
        const minimal = shouldUseMinimalToolContext(
          toolList.length,
          lastUserContent,
          modelConfigForTurn
        );
        useMinimalContext = minimal && hasLastUser;
        useOllamaMinimalSystem = minimal;
      } else {
        useMinimalContext =
          modelConfigForTurn?.toolTurnContext === "minimal" &&
          toolList.length > 0 &&
          hasLastUser;
        useOllamaMinimalSystem =
          modelConfigForTurn?.ollamaMinimalSystem === true && toolList.length > 0;
      }
    } else {
      // LM Studio and openai-compatible need conversation history; do not use minimal context (single last user message).
      const isLmStudioOrOpenAI =
        modelConfigForTurn?.provider === "lm-studio" ||
        modelConfigForTurn?.provider === "openai-compatible";
      useMinimalContext =
        !isLmStudioOrOpenAI &&
        modelConfigForTurn?.toolTurnContext === "minimal" &&
        toolList.length > 0 &&
        hasLastUser;
      useOllamaMinimalSystem = false;
    }

    if (useMinimalContext && lastUser) {
      userMessages = [
        { role: lastUser.role, content: this.scrubText(lastUser.content, scopeId) }
      ];
    }
    const systemMessages: Array<{ role: string; content: string }> = [];

    const substrate = this.options.getSubstrate?.(profileIdForSubstrate) ?? {};

    // When multiple profiles exist, ensure the agent only uses its own profile (exec cwd and paths are scoped to profile root).
    const profileList = this.options.config.profiles;
    if (Array.isArray(profileList) && profileList.length > 1 && profileIdForSubstrate) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          `You are agent profile "${profileIdForSubstrate}". All file paths and exec cwd are relative to your profile root only. Do not use paths or cwd pointing to other profiles (e.g. profiles/default).`,
          scopeId
        )
      });
    }

    if (useOllamaMinimalSystem) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          "Continuity: this turn is task-oriented; respond with tool calls. Use the provided tools. To read a file call exec with command: cat FILENAME or type FILENAME. To edit a file: read it first, then use sed to change only the part that needs updating (e.g. sed -i 's/old/new/' FILE); do not overwrite the whole file with echo ... > FILE unless the user asked to replace the entire file. Workspace context is in AGENTS.md, IDENTITY.md, ROADMAP.md—read them with exec when needed.",
          scopeId
        )
      });
      // Inject AGENTS.md (and identity/soul) so the Ollama agent has substrate in context; minimal mode otherwise omits it.
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
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          "When to update which file: Use MEMORY.md and memory/YYYY-MM-DD for daily notes and \"remember this\". Use ROADMAP.md for goals and milestones—update when you learn new goals; on heartbeats replace the single Current state line in place or move Open/Completed items only; do not append heartbeat status or tick logs to ROADMAP (use MEMORY or remember_this for per-tick notes). Use IDENTITY.md and SOUL.md for who you are; TOOLS.md for env notes. When you learn something lasting, update the right file via exec (read first, then sed to change only that part).",
          scopeId
        )
      });
      const lastIdx = userMessages.length - 1;
      const u = lastIdx >= 0 ? userMessages[lastIdx] : undefined;
      if (u !== undefined) {
        userMessages[lastIdx] = {
          role: u.role,
          content: this.scrubText(
            "You must respond by calling one or more of the provided tools. Do not answer without calling a tool when the request involves files or workspace.\n\nUser request: " +
              u.content,
            scopeId
          )
        };
      }
    } else {
      // AGENTS.md is the coordinating rules file (session start, memory, safety). Inject first so the agent
      // sees workspace rules before Identity/Soul/User; matches OpenClaw/Claude Code use of AGENTS.md as rules.
      if (substrate.agents?.trim()) {
        systemMessages.push({
          role: "system",
          content: this.scrubText(`Workspace rules (AGENTS):\n\n${substrate.agents.trim()}`, scopeId)
        });
      }
      // Tool instructions: in full context we give continuity (conversational vs task) so local models know when to generate text vs use tools.
      if (toolList.length > 0) {
        const modelIdForOllamaCheck = getModelIdForProfile(this.options.config, profileIdForSubstrate);
        const activeModelConfig = this.options.config.models[modelIdForOllamaCheck];
        const isOllamaFullContext = activeModelConfig?.provider === "ollama" && !useOllamaMinimalSystem;
        if (isOllamaFullContext) {
          systemMessages.push({
            role: "system",
            content: this.scrubText(
              "Continuity: this is a conversational turn. Reply in natural language. Use tools only when the user clearly asks to read or edit files, run commands, or check workspace state.",
              scopeId
            )
          });
          systemMessages.push({
            role: "system",
            content: this.scrubText(
              "You have access to tools. Use them when the user asks to read or edit files, run commands, or when you need to verify workspace state; otherwise reply in natural language. To read: exec (e.g. cat AGENTS.md, type USER.md, head -n 50 ROADMAP.md). To edit: read the file first, then use sed to change only the relevant part; do not overwrite whole files with echo unless the user asked. On heartbeats, use exec to read ROADMAP.md and HEARTBEAT.md and update substrate or memory as needed.",
              scopeId
            )
          });
        } else {
          systemMessages.push({
            role: "system",
            content: this.scrubText(
              "You have access to tools. You must use them: to read or edit substrate files (AGENTS.md, IDENTITY.md, ROADMAP.md, MEMORY.md, memory/YYYY-MM-DD.md) or any file, call the exec tool (e.g. cat, type, head, or sed for edits). When editing an existing file: read it first, then use sed to change only the part that needs updating; do not overwrite the whole file with echo ... > FILE unless the user asked to replace the entire file. When advancing work or on heartbeats, read and update ROADMAP.md or memory files via exec as appropriate—do not skip tool use. To run scripts or tests, use exec. Do not guess file contents—call a tool to read or verify.",
              scopeId
            )
          });
          if (activeModelConfig?.provider === "ollama") {
            systemMessages.push({
              role: "system",
              content: this.scrubText(
                "You are using the Ollama provider. You must use the provided tools—do not answer from memory or guess. To read substrate or any file: call the exec tool (e.g. cat AGENTS.md, type USER.md, head -n 50 ROADMAP.md). To update a file: always read it first, then use sed to change only the specific line or section (e.g. sed -i 's/old text/new text/' FILE); do not write the entire file with echo ... > FILE unless the user explicitly asked to replace the whole file. When the user asks about the workspace, rules, roadmap, or files, your first response must include one or more tool calls to read the relevant files; then answer from the tool results. On heartbeats, use exec to read ROADMAP.md and HEARTBEAT.md and to update substrate or memory as needed.",
                scopeId
              )
            });
          }
        }
        // When to update substrate vs memory: steer durable/long-term info into substrate files.
        systemMessages.push({
          role: "system",
          content: this.scrubText(
            "Substrate vs memory — when to update what: Use MEMORY.md and memory/YYYY-MM-DD.md for daily context, \"remember this\", decisions, and raw logs (or remember_this/recall_memory). Use substrate files for durable, structural information: ROADMAP.md for goals and milestones (create or update when the user or context implies goals; on heartbeats replace the single Current state line in place or move Open/Completed items only—do not append heartbeat status or tick logs to ROADMAP; use MEMORY or remember_this for per-tick notes); IDENTITY.md and SOUL.md for who you are and how you present; TOOLS.md for environment notes (hosts, preferences). When you learn something lasting—e.g. a new goal, a preference for how you behave, a new tool or device—update the right substrate file via exec (read the file first, then sed to change only the relevant part). On heartbeats, consider whether ROADMAP, IDENTITY, or TOOLS should be updated and do so when appropriate.",
            scopeId
          )
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
      // Conversational frame: in the UI the human sees their messages as \"You\" and yours as \"Agent\". In context we refer to the human as User and you as the agent. When the User says \"you\" or \"You\", they mean you (the agent).
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          "In this chat, the other party is the User (the human). You are the agent. When the User says \"you\" or \"You\", they mean you (the agent), not themselves.",
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
    if (isMainSession && this.options.getRecentTopicsContext && this.options.getProfileRoot) {
      const profileId = request.session.profileId ?? getDefaultProfileId(this.options.config);
      const profileRoot = this.options.getProfileRoot(profileId);
      if (profileRoot) {
        const recentTopics = await this.options.getRecentTopicsContext(profileRoot);
        if (recentTopics?.trim()) {
          systemMessages.push({
            role: "system",
            content: this.scrubText(`Recent topics (with this user):\n\n${recentTopics.trim()}`, scopeId)
          });
        }
      }
    }
    if (isMainSession && this.options.recordRecentTopic && this.options.getProfileRoot) {
      const userMessages = request.messages.filter((m) => m.role === "user");
      const firstUser = userMessages[0];
      if (firstUser && userMessages.length === 1) {
        const profileId = request.session.profileId ?? getDefaultProfileId(this.options.config);
        const profileRoot = this.options.getProfileRoot(profileId);
        if (profileRoot) {
          await this.options.recordRecentTopic(
            profileRoot,
            request.session.sessionId,
            firstUser.content
          );
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

    const profileIdForFirstTurn = request.session.profileId ?? getDefaultProfileId(this.options.config);
    const sessionKey = `${profileIdForFirstTurn}:${request.session.sessionId}`;
    const isFirstTurnThisSession = !this.sessionsWithTurn.has(sessionKey);
    if (isFirstTurnThisSession) {
      this.sessionsWithTurn.add(sessionKey);
    }
    if (substrate.birth?.trim() && isFirstTurnThisSession) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(`Bootstrap (BIRTH):\n\n${substrate.birth.trim()}`, scopeId)
      });
    } else if (
      isFirstTurnThisSession &&
      this.options.getSubstrate &&
      !substrate.birth?.trim()
    ) {
      // BIRTH.md is not present — tell the model once per session so it doesn't assume BIRTH exists or try to create it.
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          "BIRTH.md is not present; the BIRTH process is complete. Do not create BIRTH.md or try to run or mention BIRTH.",
          scopeId
        )
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
    if (substrate.roadmap?.trim()) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          `Planning (ROADMAP):\n\n${substrate.roadmap.trim()}`,
          scopeId
        )
      });
    }
    if (substrate.studyGoals?.trim()) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          `Study goals (STUDY_GOALS):\n\n${substrate.studyGoals.trim()}`,
          scopeId
        )
      });
    }
    const allowSoulIdentityEvolution = this.options.config.substrate?.allowSoulIdentityEvolution === true;
    if (allowSoulIdentityEvolution && isMainSession) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          "When you infer a lasting change in how you want to be or how you present in this workspace, you may propose an update to SOUL.md or IDENTITY.md via the propose_soul_identity_update tool. The tool does not write to disk; it returns a diff/draft for the user to review and apply. State what you changed when you propose (e.g. \"Proposed change to IDENTITY.md: …\").",
          scopeId
        )
      });
    }

    // Formal planning and agency: native support for milestones, roadmaps, study goals, and user prioritization.
    // Injected when substrate is used (agents, roadmap, or study goals) so the agent is natively good at planning and automating work.
    const hasPlanningContext =
      (substrate.agents?.trim() ?? "") !== "" ||
      (substrate.roadmap?.trim() ?? "") !== "" ||
      (substrate.studyGoals?.trim() ?? "") !== "";
    if (hasPlanningContext) {
      systemMessages.push({
        role: "system",
        content: this.scrubText(
          "Planning and automation: You have a planning file (e.g. ROADMAP.md) for milestones, roadmaps, and backlogs. Create or update it when the user or context implies goals; break work into concrete steps and priorities. STUDY_GOALS are topics you spend some time each heartbeat researching and searching the internet about (web_search, web_fetch), writing notes until you have enough information to plan a new feature, then when planning is complete implementing that feature. Be proactive: each heartbeat, begin or continue at least one STUDY_GOALS topic (research → notes → plan → implement). During heartbeats, read the planning file, HEARTBEAT.md, and when present STUDY_GOALS; make progress on ROADMAP Open/Completed or on STUDY_GOALS; replace the single Current state line in place only—do not append heartbeat status or tick logs to ROADMAP (use MEMORY or remember_this for per-tick notes). User messages always take priority: the system will interrupt any in-flight heartbeat work when the user sends a message, let you respond to the user fully, then the next heartbeat tick continues from the planning file, HEARTBEAT checklist, and STUDY_GOALS when present. Plan in ROADMAP, advance it on heartbeats; do STUDY_GOALS proactively each heartbeat; stay responsive to the user.",
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
    }

    if (!useOllamaMinimalSystem && this.options.decisionJournal) {
      const limit = Math.min(
        100,
        Math.max(1, this.options.config.continuity?.decisionJournalReplayCount ?? 5)
      );
      const mode = this.options.config.continuity?.decisionJournalReplayMode ?? "count";
      const recentDecisions = await this.options.decisionJournal.readEntriesForReplay({
        limit,
        mode,
        sinceHours: this.options.config.continuity?.decisionJournalReplaySinceHours ?? 24,
        maxEntries: 100,
        ...(this.options.sessionStartMs !== undefined && { sessionStartMs: this.options.sessionStartMs })
      });
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

    const profileIdForMemory = request.session.profileId ?? getDefaultProfileId(this.options.config);
    const memoryStoreForTurn =
      this.options.getMemoryStore?.(profileIdForMemory) ?? this.options.memory;
    const pluginResult = await this.promptPluginHost.run({
      runId,
      sessionId: request.session.sessionId,
      inputMessages: userMessages,
      ...(memoryStoreForTurn !== undefined ? { memoryStore: memoryStoreForTurn } : {})
    });
    if (!useOllamaMinimalSystem) {
      for (const message of pluginResult.messages) {
        systemMessages.push({
          role: message.role,
          content: this.scrubText(message.content, scopeId)
        });
      }
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
