import type { HeartbeatConfig } from "./types.js";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface GatewayConfig {
  bind: "loopback" | "0.0.0.0";
  /**
   * When set, the gateway listens on this address instead of the host derived from `bind`.
   * Use for Tailscale: set to the host's Tailscale IP (e.g. 100.x.x.x) so only Tailnet traffic is accepted.
   * Allowed: loopback (127.x, ::1), link-local (169.254.x), private (10.x, 172.16–31.x, 192.168.x), Tailscale CGNAT (100.64.0.0/10).
   */
  bindAddress?: string;
  bodyLimitBytes: number;
  auth: {
    mode: "token" | "password" | "none";
    token?: string;
    password?: string;
    trustedIdentityHeader?: string;
  };
  trustedProxyIps: string[];
  protocolVersion: string;
}

export interface SessionConfig {
  dmScope: "per-channel-peer" | "per-user";
  queueSoftLimit: number;
  queueHardLimit: number;
  queueDropStrategy: "drop-oldest" | "defer-new";
  /** Queue backend: "memory" (default) or "file" for durable queue across restarts. */
  queueBackend?: "memory" | "file";
  /** When queueBackend is "file", path to the queue file or directory. Default tmp/queue. */
  queueFilePath?: string;
  turnTimeoutMs: number;
  snapshotEveryEvents: number;
  maxMessagesPerTurn: number;
  maxMessageChars: number;
}

export interface CompactionConfig {
  memoryFlush: boolean;
}

export interface ModelProviderConfig {
  provider: "cursor-agent-cli" | "fallback-model" | "ollama" | "openai-compatible";
  command?: string;
  args?: string[];
  /** If true, pass last user message as final CLI arg (e.g. Cursor CLI -p --output-format stream-json). */
  promptAsArg?: boolean;
  timeoutMs: number;
  authProfiles: string[];
  fallbackModels: string[];
  enabled: boolean;
  /** Reference into credential store for API key (never plaintext in config). Used by OpenAI-compatible etc. */
  apiKeyRef?: string;
  /** Provider-specific: Ollama model name (e.g. llama3.2, granite3.2). */
  ollamaModelName?: string;
  /** Provider-specific: Ollama API options (temperature, num_ctx). Improves tool use and stability on local models (e.g. Granite 3.2). */
  ollamaOptions?: { temperature?: number; num_ctx?: number };
  /** When "minimal", only the latest user message is sent for tool turns. Use for Ollama/Granite 3.2: the model often does not call tools when given full conversation history (see docs/Ollama-tool-call-support.md). */
  toolTurnContext?: "full" | "minimal";
  /** Provider-specific: base URL for OpenAI-compatible or Ollama (e.g. http://localhost:11434). */
  baseURL?: string;
  /** Provider-specific: OpenAI-compatible model id (e.g. gpt-4o-mini, gpt-4o). */
  openaiModelId?: string;
  /** Optional per-model context token cap. When set, runtime trims messages so estimated tokens ≤ cap. Best-effort char-based estimate (~4 chars/token). */
  maxContextTokens?: number;
  /** Optional drop order when trimming for maxContextTokens. Roles listed first are dropped first (e.g. ['assistant','user','system']). Omit for oldest-first (TU.2). */
  truncationPriority?: ("system" | "user" | "assistant")[];
  /** When true and over maxContextTokens, replace oldest messages with one rule-based summary before trimming (TU.4). Off by default. */
  summarizeOldTurns?: boolean;
  /** Max tokens for the summary of earlier turns when summarizeOldTurns is true. Default 200. */
  summarizeOldTurnsMaxTokens?: number;
  /** When true, this model uses a paid API; validation probe will skip unless providerModelResilience.runValidationAgainstPaidApis is true (PMR Phase 2). */
  paidApi?: boolean;
}

export interface ToolsGhConfig {
  enabled: boolean;
  /** When set (e.g. "owner/repo"), every gh call uses --repo so the agent cannot target other repositories. */
  repoScope?: string | null;
  /** When true, register gh_pr_write (comment on PR, create PR). Requires tools.gh.enabled. Default false. */
  allowWrite?: boolean;
  /** Optional (GH.2 soft limit). Max gh_pr_write calls per calendar minute (sliding window). When set, over-limit calls throw before running. */
  maxWritesPerMinute?: number;
  /** Optional (GH.2 soft limit). Max gh_pr_write calls per process run. When set, over-limit calls throw before running. */
  maxWritesPerRun?: number;
  /** Optional (GH.2 backoff). When true and a write fails with 403 rate limit, retry once after the suggested delay (or 60s). Default false. */
  respectRetryAfter?: boolean;
}

export interface ToolsConfig {
  exec: {
    host: "sandbox" | "host";
    security: "deny" | "allowlist";
    ask: "always" | "on-miss" | "never";
    profile: "strict" | "developer";
    allowBins: string[];
    /** Reserved for future use: run exec as this OS user. Not enforced today. */
    runAsUser?: string;
    /** Max stdout/stderr buffer per exec (bytes). Default 64 KiB. */
    maxBufferBytes?: number;
    /** Max concurrent exec invocations system-wide. Default 100. No OS-level CPU/memory cap. */
    maxChildProcessesPerTurn?: number;
  };
  /** Optional GitHub CLI integration: gh_pr_read (list/view PRs) and optionally gh_pr_write (comment, create PR). */
  gh?: ToolsGhConfig;
}

export interface MemoryConfig {
  includeSecretsInPrompt: boolean;
  integrityScanEveryMs: number;
}

export interface PrivacyConfig {
  scanBeforeEgress: boolean;
  failClosedOnScannerError: boolean;
  detectors: string[];
}

export interface McpConfig {
  enabled: boolean;
  allowServers: string[];
}

export interface ReliabilityConfig {
  failureEscalationThreshold: number;
  reasoningResetIterations: number;
  lowConfidenceThreshold: number;
  checkpoint: {
    enabled: boolean;
    reliabilityCommands: string[];
    commandTimeoutMs: number;
  };
}

export interface WorkspaceRootConfig {
  id?: string;
  path: string;
  priority?: number;
  enabled?: boolean;
}

export interface WorkspacesConfig {
  roots: WorkspaceRootConfig[];
}

export interface ContextCompressionConfig {
  semanticRetrievalEnabled: boolean;
  topK: number;
  refreshEveryMs: number;
  summaryCacheMaxEntries: number;
  embeddingMaxChunks: number;
  maxFilesPerRoot: number;
  maxFileBytes: number;
  includeExtensions: string[];
}

export interface NetworkTraceConfig {
  enabled: boolean;
  allowHosts: string[];
}

export interface ReflectionConfig {
  enabled: boolean;
  idleAfterMs: number;
  tickMs: number;
  maxJobMs: number;
  flakyRuns: number;
  flakyTestCommand: string;
}

export interface MetricsConfig {
  /** "none" = no export; "log" = periodic JSON line to stdout (operational monitoring only). */
  export: "none" | "log";
  /** When export is "log", interval in seconds between log lines. Default 60. */
  intervalSeconds?: number;
}

/** Optional per-agent profile: isolated root for substrate, memory, heartbeat, cron, etc. */
export interface AgentProfileConfig {
  id: string;
  root: string;
  /** Optional model id for this profile; must exist in config.models. When absent, config.defaultModel is used. */
  modelId?: string;
}

/** Optional substrate file paths (workspace-relative). Defaults: AGENTS.md, IDENTITY.md, SOUL.md, BIRTH.md, CAPABILITIES.md, USER.md, TOOLS.md in workspace root. */
export interface SubstrateConfig {
  agentsPath?: string;
  identityPath?: string;
  soulPath?: string;
  birthPath?: string;
  capabilitiesPath?: string;
  userPath?: string;
  toolsPath?: string;
  /** Path to planning file (milestones, roadmap). Default ROADMAP.md. */
  roadmapPath?: string;
  /** When true, include a short capabilities summary in the system prompt (default false). */
  includeCapabilitiesInPrompt?: boolean;
  /** When true, allow the agent to propose SOUL.md/IDENTITY.md updates via propose_soul_identity_update (proposal-only; no direct write). Default false. */
  allowSoulIdentityEvolution?: boolean;
}

/** Optional. Provider/model resilience: validation store path and policies (use only validated fallbacks, run validation against paid APIs). */
export interface ProviderModelResilienceConfig {
  /** Path to JSON file storing per-model validation results. No secrets stored. Default run/provider-model-validation.json. */
  validationStorePath?: string;
  /** When true, fallback chain only includes models that have passed the minimum-capability check. Default false. */
  useOnlyValidatedFallbacks?: boolean;
  /** When true, allow validation probe to run against paid APIs (e.g. OpenAI). Default false. */
  runValidationAgainstPaidApis?: boolean;
  /** When true and useOnlyValidatedFallbacks is true, if no validated model exists allow one attempt with the unfiltered chain and log a warning; if that fails, throw as usual. Default false. */
  allowOneUnvalidatedAttempt?: boolean;
}

export interface ContinuityConfig {
  /** When true (default), run BOOT.md once at process startup when the file exists at profile root. */
  bootEnabled?: boolean;
  /** When true (default), inject MEMORY.md + memory/today+yesterday into main-session system prompt at turn start. */
  sessionMemoryEnabled?: boolean;
  /** Max characters for session memory injection (default 32000). Only used when sessionMemoryEnabled is true. */
  sessionMemoryCap?: number;
  /** When true, enable optional memory-embedding index and recall_memory tool for main session (default false). */
  memoryEmbeddingsEnabled?: boolean;
  /** Max memory records to keep in the embedding index (default 3000). Only used when memoryEmbeddingsEnabled is true. */
  memoryEmbeddingsMaxRecords?: number;
  /** When true, inject a short "Recent topics (with this user)" block into main-session system prompt (default false). */
  includeRecentTopics?: boolean;
  /** When set, heartbeat checklist warns when memory (MEMORY.md + daily) is at or above this many chars (default: 90% of sessionMemoryCap). Enables dumb-zone awareness. */
  memorySizeWarnChars?: number;
  /** When set, heartbeat checklist warns when total substrate file size is at or above this many chars (default 60000). */
  substrateSizeWarnChars?: number;
  /** Optional rolling window: max records to keep in MEMORY.md. When set, oldest records are trimmed after append (and optionally archived). Default off. */
  memoryMaxRecords?: number;
  /** Optional rolling window: max characters for MEMORY.md. When set, oldest records are trimmed after append (and optionally archived). Default off. */
  memoryMaxChars?: number;
  /** When rolling window is enabled, trimmed lines can be appended here (e.g. "memory/MEMORY-archive.md"). Omit to drop without archiving. */
  memoryArchivePath?: string;
  /** Number of recent decision journal entries to replay into the system prompt (default 5, clamped 1–100). Used when decisionJournalReplayMode is "count". */
  decisionJournalReplayCount?: number;
  /**
   * How to select which decision journal entries to replay: "count" (default) = last N entries;
   * "sinceLastSession" = entries since process start; "sinceHours" = entries within the last N hours (use decisionJournalReplaySinceHours).
   */
  decisionJournalReplayMode?: "count" | "sinceLastSession" | "sinceHours";
  /** When decisionJournalReplayMode is "sinceHours", replay entries from the last N hours (default 24). Capped at 168 (1 week). */
  decisionJournalReplaySinceHours?: number;
}

export interface CursorClawConfig {
  gateway: GatewayConfig;
  session: SessionConfig;
  heartbeat: HeartbeatConfig;
  compaction: CompactionConfig;
  memory: MemoryConfig;
  privacy: PrivacyConfig;
  mcp: McpConfig;
  workspaces: WorkspacesConfig;
  contextCompression: ContextCompressionConfig;
  networkTrace: NetworkTraceConfig;
  reflection: ReflectionConfig;
  metrics: MetricsConfig;
  reliability: ReliabilityConfig;
  tools: ToolsConfig;
  models: Record<string, ModelProviderConfig>;
  defaultModel: string;
  autonomyBudget: {
    maxPerHourPerChannel: number;
    maxPerDayPerChannel: number;
    quietHours?: { startHour: number; endHour: number };
  };
  /** Optional. When present, substrate files (Identity, Soul, Birth, etc.) are loaded from workspace and injected into the prompt. */
  substrate?: SubstrateConfig;
  /** Optional. Continuity behavior (BOOT.md at startup). */
  continuity?: ContinuityConfig;
  /** Optional. When set, each agent has an isolated profile directory. When absent, workspaceDir is the single profile root. */
  profiles?: AgentProfileConfig[];
  /** Optional. Provider/model resilience: validation store and use-only-validated-fallbacks policy. See docs/PMR-provider-model-resilience.md. */
  providerModelResilience?: ProviderModelResilienceConfig;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export const DEFAULT_CONFIG: CursorClawConfig = {
  gateway: {
    bind: "loopback",
    bodyLimitBytes: 2 * 1024 * 1024, // 2 MiB – RPC can include long thread; client trims when over budget to avoid 413
    auth: { mode: "token", token: "changeme" },
    trustedProxyIps: [],
    protocolVersion: "2.0"
  },
  session: {
    dmScope: "per-channel-peer",
    queueSoftLimit: 16,
    queueHardLimit: 64,
    queueDropStrategy: "drop-oldest",
    queueBackend: "memory",
    turnTimeoutMs: 60_000,
    snapshotEveryEvents: 12,
    /** Max messages accepted per request; runtime compacts to a smaller window. Users are never blocked. */
    maxMessagesPerTurn: 10_000,
    maxMessageChars: 8_000
  },
  heartbeat: {
    enabled: true,
    everyMs: 30 * 60_000,
    minMs: 5 * 60_000,
    maxMs: 60 * 60_000,
    visibility: "silent"
  },
  compaction: {
    memoryFlush: true
  },
  memory: {
    includeSecretsInPrompt: false,
    integrityScanEveryMs: 60 * 60_000
  },
  privacy: {
    scanBeforeEgress: true,
    failClosedOnScannerError: true,
    detectors: [
      "generic-assignment",
      "github-token",
      "aws-access-key-id",
      "jwt",
      "private-key-block",
      "high-entropy-token"
    ]
  },
  mcp: {
    enabled: true,
    allowServers: []
  },
  workspaces: {
    roots: []
  },
  contextCompression: {
    semanticRetrievalEnabled: true,
    topK: 8,
    refreshEveryMs: 20_000,
    summaryCacheMaxEntries: 15_000,
    embeddingMaxChunks: 100_000,
    maxFilesPerRoot: 4_000,
    maxFileBytes: 128 * 1024,
    includeExtensions: [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".py",
      ".go",
      ".rs",
      ".java",
      ".json",
      ".md"
    ]
  },
  networkTrace: {
    enabled: false,
    allowHosts: []
  },
  reflection: {
    enabled: false,
    idleAfterMs: 2 * 60_000,
    tickMs: 30_000,
    maxJobMs: 30_000,
    flakyRuns: 3,
    flakyTestCommand: "npm test"
  },
  metrics: {
    export: "none",
    intervalSeconds: 60
  },
  reliability: {
    failureEscalationThreshold: 2,
    reasoningResetIterations: 3,
    lowConfidenceThreshold: 60,
    checkpoint: {
      enabled: true,
      reliabilityCommands: [],
      commandTimeoutMs: 5 * 60_000
    }
  },
  tools: {
    exec: {
      host: "sandbox",
      security: "allowlist",
      ask: "on-miss",
      profile: "strict",
      allowBins: ["echo", "pwd", "ls", "cat", "node"],
      maxBufferBytes: 64 * 1024,
      maxChildProcessesPerTurn: 100
    }
  },
  models: {
    "cursor-auto": {
      provider: "cursor-agent-cli",
      command: "cursor-agent",
      args: ["auto", "--stream-json"],
      timeoutMs: 600_000,
      authProfiles: ["default"],
      fallbackModels: ["fallback-default"],
      enabled: true
    },
    "fallback-default": {
      provider: "fallback-model",
      timeoutMs: 120_000,
      authProfiles: ["default"],
      fallbackModels: [],
      enabled: true
    }
  },
  defaultModel: "cursor-auto",
  autonomyBudget: {
    maxPerHourPerChannel: 4,
    maxPerDayPerChannel: 20
  },
  continuity: {
    bootEnabled: true,
    sessionMemoryEnabled: true,
    sessionMemoryCap: 32_000,
    memoryEmbeddingsEnabled: false,
    memoryEmbeddingsMaxRecords: 3_000,
    memorySizeWarnChars: 28_800,
    substrateSizeWarnChars: 60_000,
    decisionJournalReplayCount: 5,
    decisionJournalReplayMode: "count",
    decisionJournalReplaySinceHours: 24
  }
};

function merge<T extends object>(base: T, override?: DeepPartial<T>): T {
  if (!override) {
    return base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const current = out[key];
    if (value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object") {
      out[key] = merge(current as object, value as DeepPartial<object>);
      continue;
    }
    out[key] = value;
  }
  return out as T;
}

/** Top-level config keys safe to patch via config.patch (excludes gateway auth; bind/bindAddress handled separately). */
export const PATCHABLE_CONFIG_KEYS: (keyof CursorClawConfig)[] = [
  "heartbeat",
  "autonomyBudget",
  "memory",
  "reflection",
  "session",
  "compaction",
  "workspaces",
  "contextCompression",
  "networkTrace",
  "metrics",
  "reliability",
  "tools",
  "substrate",
  "continuity",
  "profiles",
  "providerModelResilience",
  "models",
  "defaultModel"
];

/** Merges a partial config into current, only for allowed top-level keys. Used by config.patch. */
export function mergeConfigPatch(
  current: CursorClawConfig,
  partial: DeepPartial<CursorClawConfig>,
  allowedKeys: (keyof CursorClawConfig)[]
): CursorClawConfig {
  const filtered: DeepPartial<CursorClawConfig> = {};
  for (const k of allowedKeys) {
    const v = (partial as Record<string, unknown>)[k as string];
    if (v !== undefined) {
      (filtered as Record<string, unknown>)[k as string] = v;
    }
  }
  return merge(current, filtered) as CursorClawConfig;
}

export function loadConfig(raw?: DeepPartial<CursorClawConfig>): CursorClawConfig {
  const config = merge(DEFAULT_CONFIG, raw);
  if (config.gateway.auth.mode !== "none" && !config.gateway.auth.token && !config.gateway.auth.password) {
    throw new Error("secure config requires gateway auth token or password");
  }
  return config;
}

/** Default profile id when no profiles are configured, or the first profile id when they are. */
export function getDefaultProfileId(config: CursorClawConfig): string {
  const list = config.profiles;
  if (!list?.length) return "default";
  const first = list[0];
  return first?.id ?? "default";
}

/**
 * Resolve the model id to use for a given profile.
 * When no profiles are configured, returns config.defaultModel.
 * When the profile has modelId set (and it exists in config.models), returns that; otherwise config.defaultModel.
 */
export function getModelIdForProfile(config: CursorClawConfig, profileId: string): string {
  const list = config.profiles;
  if (!list?.length) return config.defaultModel;
  const profile = list.find((p) => p.id === profileId) ?? list[0];
  const modelId = profile?.modelId ?? config.defaultModel;
  if (config.models[modelId]) return modelId;
  return config.defaultModel;
}

/**
 * Resolve the absolute profile root for the given profile.
 * When no profiles are configured, returns workspaceDir (single-agent mode).
 * Profile root is always resolved under workspaceDir to prevent path traversal.
 */
export function resolveProfileRoot(
  workspaceDir: string,
  config: CursorClawConfig,
  profileId?: string
): string {
  const list = config.profiles;
  if (!list?.length) return resolve(workspaceDir);
  const id = profileId ?? getDefaultProfileId(config);
  const profile = list.find((p) => p.id === id) ?? list[0];
  if (!profile) throw new Error("profiles configured but no profile found");
  const base = resolve(workspaceDir);
  const candidate = resolve(base, profile.root);
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (candidate !== base && !candidate.startsWith(prefix)) {
    throw new Error(`profile root must be under workspace: ${profile.root}`);
  }
  return candidate;
}

export interface LoadConfigFromDiskOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function isLiteralNullishToken(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "undefined" || normalized === "null";
}

export function resolveConfigPath(options: LoadConfigFromDiskOptions = {}): string {
  if (options.configPath !== undefined) {
    return options.configPath;
  }
  const env = options.env ?? process.env;
  if (env.CURSORCLAW_CONFIG_PATH) {
    return env.CURSORCLAW_CONFIG_PATH;
  }
  return join(options.cwd ?? process.cwd(), "openclaw.json");
}

export function loadConfigFromDisk(options: LoadConfigFromDiskOptions = {}): CursorClawConfig {
  const configPath = resolveConfigPath(options);
  if (!existsSync(configPath)) {
    return loadConfig(DEFAULT_CONFIG);
  }
  const rawText = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(rawText) as DeepPartial<CursorClawConfig>;
  return loadConfig(parsed);
}

export interface StartupValidationOptions {
  allowInsecureDefaults: boolean;
}

export function validateStartupConfig(
  config: CursorClawConfig,
  options: StartupValidationOptions
): void {
  if (options.allowInsecureDefaults || config.gateway.auth.mode === "none") {
    return;
  }
  const token = config.gateway.auth.token;
  const password = config.gateway.auth.password;
  if (token?.trim() === "changeme" || password?.trim() === "changeme") {
    throw new Error("refusing startup with placeholder gateway credentials");
  }
  if (isLiteralNullishToken(token) || isLiteralNullishToken(password)) {
    throw new Error('refusing startup with invalid literal gateway credentials ("undefined"/"null")');
  }
}

export function isDevMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.CURSORCLAW_DEV_MODE ?? "");
}

/**
 * Writes config to disk at resolveConfigPath(options).
 * Uses atomic write (temp file then rename). Ensures parent directory exists.
 */
export async function writeConfigToDisk(
  config: CursorClawConfig,
  options: LoadConfigFromDiskOptions = {}
): Promise<string> {
  const configPath = resolveConfigPath(options);
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
  }
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  const json = JSON.stringify(config, null, 2);
  await writeFile(tmpPath, json, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, configPath);
  return configPath;
}
