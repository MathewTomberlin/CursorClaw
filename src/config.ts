import type { HeartbeatConfig } from "./types.js";

export interface GatewayConfig {
  bind: "loopback" | "0.0.0.0";
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
  turnTimeoutMs: number;
  snapshotEveryEvents: number;
}

export interface CompactionConfig {
  memoryFlush: boolean;
}

export interface ModelProviderConfig {
  provider: "cursor-agent-cli" | "fallback-model";
  command?: string;
  args?: string[];
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
    allowBins: string[];
  };
}

export interface CursorClawConfig {
  gateway: GatewayConfig;
  session: SessionConfig;
  heartbeat: HeartbeatConfig;
  compaction: CompactionConfig;
  tools: ToolsConfig;
  models: Record<string, ModelProviderConfig>;
  defaultModel: string;
  autonomyBudget: {
    maxPerHourPerChannel: number;
    maxPerDayPerChannel: number;
    quietHours?: { startHour: number; endHour: number };
  };
}

export const DEFAULT_CONFIG: CursorClawConfig = {
  gateway: {
    bind: "loopback",
    auth: { mode: "token", token: "changeme" },
    trustedProxyIps: [],
    protocolVersion: "2.0"
  },
  session: {
    dmScope: "per-channel-peer",
    queueSoftLimit: 16,
    queueHardLimit: 64,
    queueDropStrategy: "drop-oldest",
    turnTimeoutMs: 60_000,
    snapshotEveryEvents: 12
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
  tools: {
    exec: {
      host: "sandbox",
      security: "allowlist",
      ask: "on-miss",
      allowBins: ["echo", "pwd", "ls", "cat", "node"]
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

function merge<T extends object>(base: T, override?: Partial<T>): T {
  if (!override) {
    return base;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const current = out[key];
    if (value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object") {
      out[key] = merge(current as object, value as object);
      continue;
    }
    out[key] = value;
  }
  return out as T;
}

export function loadConfig(raw?: Partial<CursorClawConfig>): CursorClawConfig {
  const config = merge(DEFAULT_CONFIG, raw);
  if (config.gateway.auth.mode !== "none" && !config.gateway.auth.token && !config.gateway.auth.password) {
    throw new Error("secure config requires gateway auth token or password");
  }
  return config;
}
