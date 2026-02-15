import type { HeartbeatConfig } from "./types.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GatewayConfig {
  bind: "loopback" | "0.0.0.0";
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
  provider: "cursor-agent-cli" | "fallback-model";
  command?: string;
  args?: string[];
  /** If true, pass last user message as final CLI arg (e.g. Cursor CLI -p --output-format stream-json). */
  promptAsArg?: boolean;
  timeoutMs: number;
  authProfiles: string[];
  fallbackModels: string[];
  enabled: boolean;
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
    bodyLimitBytes: 64 * 1024,
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
    maxMessagesPerTurn: 64,
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

export function loadConfig(raw?: DeepPartial<CursorClawConfig>): CursorClawConfig {
  const config = merge(DEFAULT_CONFIG, raw);
  if (config.gateway.auth.mode !== "none" && !config.gateway.auth.token && !config.gateway.auth.password) {
    throw new Error("secure config requires gateway auth token or password");
  }
  return config;
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
