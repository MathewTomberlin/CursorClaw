# CursorClaw Configuration Reference

This document describes the runtime configuration contract from `src/config.ts`.

## 1) Resolution and loading

Config is loaded by `loadConfigFromDisk()` with this precedence:

1. explicit `configPath` option
2. `CURSORCLAW_CONFIG_PATH` env var
3. `${cwd}/openclaw.json`

If no config file exists, defaults are used.

## 2) Startup validation rules

On startup (`validateStartupConfig`):

- In secure mode (`allowInsecureDefaults=false`):
  - token/password cannot be `"changeme"`
  - token/password cannot be literal `"undefined"` or `"null"`
- If auth mode is not `"none"`, token or password must be present.

Dev-mode detection:

- `CURSORCLAW_DEV_MODE=1|true|yes` -> dev-mode behavior enabled.

## 3) Top-level schema

```json
{
  "gateway": {},
  "session": {},
  "heartbeat": {},
  "compaction": {},
  "memory": {},
  "privacy": {},
  "mcp": {},
  "workspaces": {},
  "contextCompression": {},
  "networkTrace": {},
  "reflection": {},
  "reliability": {},
  "tools": {},
  "models": {},
  "defaultModel": "cursor-auto",
  "autonomyBudget": {}
}
```

## 4) Section-by-section fields and defaults

## 4.1 `gateway`

Defaults:

```json
{
  "bind": "loopback",
  "bodyLimitBytes": 65536,
  "auth": { "mode": "token", "token": "changeme" },
  "trustedProxyIps": [],
  "protocolVersion": "2.0"
}
```

Fields:

- `bind`: `"loopback"` or `"0.0.0.0"`
- `bodyLimitBytes`: max HTTP body size
- `auth.mode`: `"token" | "password" | "none"`
- `auth.token`, `auth.password`
- `auth.trustedIdentityHeader`: optional trusted identity header name
- `trustedProxyIps`: allowed proxy source IPs when trusted identity header is required
- `protocolVersion`: required RPC envelope version

## 4.2 `session`

Defaults:

```json
{
  "dmScope": "per-channel-peer",
  "queueSoftLimit": 16,
  "queueHardLimit": 64,
  "queueDropStrategy": "drop-oldest",
  "turnTimeoutMs": 60000,
  "snapshotEveryEvents": 12,
  "maxMessagesPerTurn": 64,
  "maxMessageChars": 8000
}
```

Fields control queueing, turn timeout, snapshot cadence, and message bounds.

## 4.3 `heartbeat`

Defaults:

```json
{
  "enabled": true,
  "everyMs": 1800000,
  "minMs": 300000,
  "maxMs": 3600000,
  "visibility": "silent"
}
```

Optional:

- `activeHours: { "startHour": number, "endHour": number }`

## 4.4 `compaction`

Defaults:

```json
{ "memoryFlush": true }
```

When true, runtime writes a pre-compaction memory checkpoint when assistant output is very large.

## 4.5 `memory`

Defaults:

```json
{
  "includeSecretsInPrompt": false,
  "integrityScanEveryMs": 3600000
}
```

## 4.6 `privacy`

Defaults:

```json
{
  "scanBeforeEgress": true,
  "failClosedOnScannerError": true,
  "detectors": [
    "generic-assignment",
    "github-token",
    "aws-access-key-id",
    "jwt",
    "private-key-block",
    "high-entropy-token"
  ]
}
```

## 4.7 `mcp`

Defaults:

```json
{
  "enabled": true,
  "allowServers": []
}
```

`allowServers: []` means no allowlist restriction (all registered adapters allowed).

## 4.8 `workspaces`

Defaults:

```json
{ "roots": [] }
```

Each root entry:

```json
{
  "id": "optional-string",
  "path": "/abs/or/relative/path",
  "priority": 0,
  "enabled": true
}
```

If empty, bootstrap injects current working directory as primary root.

## 4.9 `contextCompression`

Defaults:

```json
{
  "semanticRetrievalEnabled": true,
  "topK": 8,
  "refreshEveryMs": 20000,
  "summaryCacheMaxEntries": 15000,
  "embeddingMaxChunks": 100000,
  "maxFilesPerRoot": 4000,
  "maxFileBytes": 131072,
  "includeExtensions": [
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".rs", ".java", ".json", ".md"
  ]
}
```

## 4.10 `networkTrace`

Defaults:

```json
{
  "enabled": false,
  "allowHosts": []
}
```

When enabled, traces are accepted only for localhost or configured hosts.

## 4.11 `reflection`

Defaults:

```json
{
  "enabled": false,
  "idleAfterMs": 120000,
  "tickMs": 30000,
  "maxJobMs": 30000,
  "flakyRuns": 3,
  "flakyTestCommand": "npm test"
}
```

## 4.12 `reliability`

Defaults:

```json
{
  "failureEscalationThreshold": 2,
  "reasoningResetIterations": 3,
  "lowConfidenceThreshold": 60,
  "checkpoint": {
    "enabled": true,
    "reliabilityCommands": [],
    "commandTimeoutMs": 300000
  }
}
```

## 4.13 `tools.exec`

Defaults:

```json
{
  "host": "sandbox",
  "security": "allowlist",
  "ask": "on-miss",
  "profile": "strict",
  "allowBins": ["echo", "pwd", "ls", "cat", "node"]
}
```

Notes:

- In strict non-dev mode, bootstrap further constrains allowed bins to a strict internal set.
- In dev or profile `developer`, configured bins are used as-is.

## 4.14 `models` and `defaultModel`

Default model map:

- `cursor-auto` (provider `cursor-agent-cli`) with fallback to `fallback-default`
- `fallback-default` (provider `fallback-model`)

Model object fields:

- `provider`: `"cursor-agent-cli" | "fallback-model"`
- `command?: string`
- `args?: string[]`
- `timeoutMs: number`
- `authProfiles: string[]`
- `fallbackModels: string[]`
- `enabled: boolean`

## 4.15 `autonomyBudget`

Defaults:

```json
{
  "maxPerHourPerChannel": 4,
  "maxPerDayPerChannel": 20
}
```

Optional:

```json
{
  "quietHours": {
    "startHour": 22,
    "endHour": 6
  }
}
```

## 5) Environment variables used at runtime

Core:

- `CURSORCLAW_CONFIG_PATH`
- `CURSORCLAW_DEV_MODE`
- `PORT`

Slack adapter:

- `CURSORCLAW_SLACK_ENABLED=1|true|yes`
- `SLACK_BOT_TOKEN`
- `SLACK_DEFAULT_CHANNEL`

## 6) Minimal secure production-ish sample

```json
{
  "gateway": {
    "bind": "loopback",
    "protocolVersion": "2.0",
    "auth": {
      "mode": "token",
      "token": "replace-with-strong-random-token"
    }
  },
  "defaultModel": "cursor-auto",
  "models": {
    "cursor-auto": {
      "provider": "cursor-agent-cli",
      "command": "cursor-agent",
      "args": ["auto", "--stream-json"],
      "timeoutMs": 600000,
      "authProfiles": ["default"],
      "fallbackModels": ["fallback-default"],
      "enabled": true
    },
    "fallback-default": {
      "provider": "fallback-model",
      "timeoutMs": 120000,
      "authProfiles": ["default"],
      "fallbackModels": [],
      "enabled": true
    }
  }
}
```
