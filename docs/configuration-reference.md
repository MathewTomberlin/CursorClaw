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
  "autonomyBudget": {},
  "substrate": {},
  "continuity": {}
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
- `bindAddress`: optional. When set, the gateway listens on this address instead of the host implied by `bind`. Use for Tailscale: set to the host’s Tailscale IP (e.g. `100.x.x.x`) so only Tailnet traffic is accepted. Allowed: loopback (127.x, ::1), link-local (169.254.x), private (10.x, 172.16–31.x, 192.168.x), Tailscale CGNAT (100.64.0.0/10). You can set it in the Dashboard (Config → Gateway bind address) or via `config.patch` with `{ gateway: { bindAddress: "100.x.x.x" } }`; restart is required for the change to take effect. From another Tailscale device you can open the Dashboard and use Restart (requests from Tailscale IPs are treated as local). Invalid or unsafe values are rejected at startup or when patching with a clear error.
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
  "queueBackend": "memory",
  "queueFilePath": null,
  "turnTimeoutMs": 60000,
  "snapshotEveryEvents": 12,
  "maxMessagesPerTurn": 10000,
  "maxMessageChars": 8000
}
```

Fields control queueing, turn timeout, snapshot cadence, and message bounds. The runtime compacts long threads (retains a recent window and injects a summary); `maxMessagesPerTurn` is a per-request acceptance limit only—users are not blocked from sending more messages.

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
- `prompt`: custom instruction for the heartbeat turn (appended after HEARTBEAT.md content).
- `skipWhenEmpty`: when `true`, do not issue a heartbeat API call when HEARTBEAT.md is missing, empty, or contains only comment lines (default `false` for backward compatibility).

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

**Warning:** Setting `includeSecretsInPrompt` to `true` can send secret-bearing memory to the model. Use only in controlled environments (e.g. local-only, no logging to external services).

**Memory integrity scan:** The orchestrator runs `memory.integrityScan()` every `integrityScanEveryMs` (default 1 hour). The scan returns findings such as potential contradictions (same session/category, different text) and staleness (records older than 120 days). Findings can be logged or used for future auto-remediation.

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

### 4.10.1 `metrics`

Optional metrics export for operational monitoring.

- **`metrics.export`**: `"none"` (default) or `"log"`. If `"log"`, the process logs a single JSON line periodically to stdout with adapter metrics (no PII or secrets). Format: `{ "ts": "<ISO date>", "adapterMetrics": { ... } }`.
- **`metrics.intervalSeconds`**: When export is `"log"`, interval in seconds between log lines (default `60`).

Default is `export: "none"`. Use `"log"` only for operational dashboards; log output is best-effort and may be delayed under load.

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

#### Security: Exec allowlist

- **Strict profile (default in non-dev):** Only binaries from a fixed internal set are allowed: `echo`, `pwd`, `ls`, `cat`, `node`. Config `allowBins` is ignored except for bins in this set. Use for production or locked-down environments.
- **Developer profile:** All bins listed in `tools.exec.allowBins` are allowed as-is. Commands run with the same privileges as the CursorClaw process. **Warning:** developer profile and cwd-relative or arbitrary bins run with process privileges; use only in trusted environments (e.g. loopback and dev mode).
- **Optional `runAsUser`:** Reserved for future use (e.g. run exec as a specific OS user). Not enforced by the runtime today; documented for extension.
- **`maxBufferBytes` (optional):** Max stdout/stderr buffer per exec in bytes. Default `65536`. There is no OS-level CPU or memory cap; only timeout and buffer are enforced by CursorClaw.
- **`maxChildProcessesPerTurn` (optional):** Max concurrent exec invocations system-wide. Default `100`. Used to limit runaway or DoS from many concurrent child processes.

#### Security — SSRF and DNS pinning

`web_fetch` resolves the hostname once and then connects to the first resolved IP (DNS pinning) with the original hostname sent in the `Host` header, so DNS changes after resolution do not change the destination. Redirects are re-resolved and re-validated (private-IP and allowlist); max redirect hops apply. IPv4 hostnames are normalized (octal, e.g. `0177.0.0.1`; hex, e.g. `0x7f.0.0.0.1`) to dotted-decimal before the private-range check so edge forms cannot bypass it.

#### Security — Destructive commands

Destructive command detection is signature-based (`src/security/destructive-denylist.ts`). Patterns block recursive force-remove, raw device writes, filesystem format, and redirects to devices. The denylist may need updates for new shells or environments; no attestation of custom tool definitions is enforced.

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
- `maxContextTokens?: number` — Optional per-model context token cap. When set, the runtime trims the prompt so the estimated token count does not exceed this value. Estimation is best-effort (~4 characters per token). The last message is always kept. By default, oldest messages are dropped first (TU.2). With `truncationPriority`, drop order is configurable (TU.3).
- `truncationPriority?: ("system"|"user"|"assistant")[]` — Optional. When set with `maxContextTokens`, roles listed first are dropped first when over the cap (e.g. `["assistant","user","system"]` drops assistant messages first, then user, then system). Omit for oldest-first behavior.

## 4.15 `autonomyBudget`

Limits how many proactive/autonomy actions run per channel per hour and per day. **Scheduled heartbeats are not limited** (they always run on their interval). Other proactive flows (e.g. queued intents) respect this budget.

Defaults:

```json
{
  "maxPerHourPerChannel": 4,
  "maxPerDayPerChannel": 20
}
```

Optional **quiet hours** (UTC): when set, the budget denies runs whose hour (UTC) falls inside the window. To **disable quiet hours**, omit `quietHours` from your config (or do not set `autonomyBudget.quietHours`).

Example (22:00–06:00 UTC = no runs during that window):

```json
{
  "quietHours": {
    "startHour": 22,
    "endHour": 6
  }
}
```

If you see "heartbeat skipped: budget limit or quiet hours", it was from an older build; in current code, scheduled heartbeats bypass the budget and are never skipped for limit or quiet hours.

## 4.16 `substrate`

Optional. When present, workspace markdown files (AGENTS, Identity, Soul, Birth, etc.) are loaded at startup and injected into the system prompt for every turn, including heartbeat.

Path defaults (workspace root): `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `BIRTH.md`, `CAPABILITIES.md`, `USER.md`, `TOOLS.md`.

```json
{
  "substrate": {
    "agentsPath": "AGENTS.md",
    "identityPath": "IDENTITY.md",
    "soulPath": "SOUL.md",
    "birthPath": "BIRTH.md",
    "capabilitiesPath": "CAPABILITIES.md",
    "userPath": "USER.md",
    "toolsPath": "TOOLS.md",
    "includeCapabilitiesInPrompt": false
  }
}
```

- **AGENTS.md:** Coordinating workspace rules file (OpenClaw-style). Injected **first** in the system prompt so the agent sees session-start ritual (read SOUL, USER, memory), memory system, safety, and heartbeat behavior before Identity/Soul/User. Using the filename `AGENTS.md` allows clients that treat it as a rules file (e.g. Claude Code, Cursor) to use it the same way when editing the workspace.
- **Identity and Soul:** When the files exist, their content is prepended after AGENTS (Identity, then Soul) for every turn, including heartbeat. This gives the agent consistent identity and tone.
- **USER.md:** Injected only in main session (web channel). Contains information about the human (name, timezone, preferences). Do not put secrets here; treat as private.
- **BIRTH (Bootstrap):** Injected only on the first turn per session (e.g. "wake" behavior). Not repeated on later turns.
- **Capabilities:** When `includeCapabilitiesInPrompt` is `true` and `CAPABILITIES.md` exists, a short summary (up to 500 chars) is appended to the system prompt. Informational only; `CapabilityStore` and approval workflow remain the source of truth for tool execution.
- If `substrate` is absent, no substrate loading occurs (backward compatible). Substrate loading must not block startup; on loader failure, the process continues with empty substrate.

**Guardrail:** Substrate files are included in the agent prompt. Do not put secrets in AGENTS.md, IDENTITY.md, SOUL.md, BIRTH.md, CAPABILITIES.md, USER.md, or TOOLS.md.

### Substrate and heartbeat

- **HEARTBEAT.md** is the per-tick checklist: read from the workspace on each heartbeat turn and prepended to the heartbeat user message (with `heartbeat.prompt` appended). Same as before; not part of the substrate loader.
- **Identity and Soul** are in the system prompt for every turn, including heartbeat, so the agent that interprets the checklist has consistent identity and behavior.
- **BIRTH** is included only on the first turn per session; heartbeat reuses the same session, so BIRTH is not re-injected on every heartbeat.
- When **HEARTBEAT.md** is missing, empty, or comments-only, set `heartbeat.skipWhenEmpty: true` to skip issuing a heartbeat API call for that cycle; see `heartbeat` section.

**BOOT.md (future):** Short startup instructions; when implemented, would run at process/gateway startup (e.g. send welcome, run check). Not injected into the chat system prompt. Optional memory layer (MEMORY.md, memory/YYYY-MM-DD.md) for session-start continuity is documented as future work in the implementation spec.

## 4.17 `continuity`

Optional. Controls BOOT.md at startup, session-start memory injection, and optional memory-embedding index.

Defaults:

```json
{
  "bootEnabled": true,
  "sessionMemoryEnabled": true,
  "sessionMemoryCap": 32000,
  "memoryEmbeddingsEnabled": false,
  "memoryEmbeddingsMaxRecords": 3000,
  "memorySizeWarnChars": 28800,
  "substrateSizeWarnChars": 60000
}
```

- **bootEnabled:** When true (default), run BOOT.md once at process startup when the file exists at profile root.
- **sessionMemoryEnabled:** When true (default), inject MEMORY.md and memory/today+yesterday into the main-session system prompt at turn start. See docs/memory.md.
- **sessionMemoryCap:** Max characters for that injection (default 32000). Only used when sessionMemoryEnabled is true.
- **memoryEmbeddingsEnabled:** When true, maintain a memory-embedding index and enable the recall_memory tool for the main session (default false).
- **memoryEmbeddingsMaxRecords:** Max records in the embedding index (default 3000). Only used when memoryEmbeddingsEnabled is true.
- **memorySizeWarnChars:** When set (default 28800), the heartbeat memory/substrate checklist warns when MEMORY.md + daily size is at or above this (e.g. near cap so the agent considers compaction). Enables dumb-zone awareness.
- **substrateSizeWarnChars:** When set (default 60000), the heartbeat checklist warns when total substrate file size is at or above this; the agent can consider summarizing or trimming.

## Token and context limits

The runtime limits prompt size in several places. There is **no per-model or per-provider context token cap** yet; providers may truncate or fail when the prompt exceeds the model’s context window.

- **session.maxMessagesPerTurn** (default 10_000): Max messages accepted per request; the runtime compacts long threads to a smaller window. Users are not blocked from sending more; compaction retains a recent window and injects a summary.
- **session.maxMessageChars** (default 8_000): Per-message character limit. Used by the runtime to cap individual system messages and to derive the total system prompt budget.
- **continuity.sessionMemoryCap** (default 32_000): Cap on session-start memory injection (MEMORY.md + memory/today+yesterday) in characters. See § 4.17 and docs/memory.md.
- **Runtime system prompt budget:** The runtime applies `applySystemPromptBudget`: each system message is capped at `session.maxMessageChars`, and the combined system messages are capped at about 1.5× that value (total system budget). Excess is truncated (conversation history and optional context are trimmed first; core system blocks are preserved in the current implementation).

So critical system blocks (AGENTS, SOUL, USER, memory summary) are preserved up to the per-message and total budget. Per-model `maxContextTokens` (see models section) can cap total context before sending to small-context models (e.g. 8K local models). Optional `truncationPriority` (TU.3) controls which roles are dropped first when over the cap.

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
      "command": "agent",
      "args": ["-p", "--output-format", "stream-json", "--stream-partial-output"],
      "promptAsArg": true,
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
