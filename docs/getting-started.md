# Getting Started with CursorClaw

This guide gets you from a fresh clone to a running, authenticated CursorClaw instance.

## 1) Prerequisites

- Node.js `>=22.0.0` (required by `package.json`)
- npm
- Linux/macOS shell (examples use `bash`)

## 2) Install and verify

From repository root:

```bash
npm install
npm test
npm run build
```

## 3) Create secure runtime config

CursorClaw loads config from:

1. `CURSORCLAW_CONFIG_PATH` (if set), otherwise
2. `./openclaw.json` in current working directory.

Create `openclaw.json` in repo root:

```json
{
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "replace-with-strong-token"
    },
    "protocolVersion": "2.0",
    "bind": "loopback",
    "trustedProxyIps": []
  },
  "defaultModel": "fallback-default",
  "models": {
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

Notes:

- In non-dev mode, startup is rejected if token/password is `"changeme"`, `"undefined"`, or `"null"`.
- If you want alternate location, set:
  - `export CURSORCLAW_CONFIG_PATH=/abs/path/to/openclaw.json`
- For all available config sections and defaults, see [Configuration Reference](./configuration-reference.md).

## 4) Start the runtime

```bash
npm start
```

Default listen target:

- host: `127.0.0.1` (when `gateway.bind = "loopback"`)
- port: `8787` (or `PORT` env override)

## 5) Sanity check endpoints

### Health

```bash
curl -s http://127.0.0.1:8787/health | jq
```

Expected shape:

```json
{
  "ok": true,
  "time": "2026-..."
}
```

### Status

```bash
curl -s http://127.0.0.1:8787/status | jq
```

Includes runtime metrics, queue warnings, scheduler backlog, approval stats, and incident flags.

## 6) Make your first authenticated RPC call

Set token:

```bash
export TOKEN="replace-with-strong-token"
```

### 6.1 Send chat message (`chat.send`)

```bash
curl -s http://127.0.0.1:8787/rpc \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "id": "1",
    "version": "2.0",
    "method": "chat.send",
    "params": {
      "channelId": "dm:user-1",
      "text": "Hello from RPC"
    }
  }' | jq
```

### 6.2 Run a turn (`agent.run` + `agent.wait`)

Create run:

```bash
RUN_ID=$(curl -s http://127.0.0.1:8787/rpc \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "version": "2.0",
    "method": "agent.run",
    "params": {
      "session": {
        "sessionId": "demo-session",
        "channelId": "dm:demo-session",
        "channelKind": "dm"
      },
      "messages": [
        { "role": "user", "content": "Summarize current runtime state." }
      ]
    }
  }' | jq -r '.result.runId')
```

Wait for completion:

```bash
curl -s http://127.0.0.1:8787/rpc \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"version\": \"2.0\",
    \"method\": \"agent.wait\",
    \"params\": { \"runId\": \"$RUN_ID\" }
  }" | jq
```

## 7) Files CursorClaw creates at runtime

In working directory, CursorClaw writes:

- `MEMORY.md` and `memory/YYYY-MM-DD.md` (durable memory records)
- `CLAW_HISTORY.log` (decision journal)
- `tmp/snapshots/*.json` (turn event snapshots)
- `tmp/run-store.json` (pending/completed run state)
- `tmp/cron-state.json`, `tmp/workflow-state/*` (scheduler state)
- `tmp/observations.json` (runtime observation store)
- `tmp/context-summary.json`, `tmp/context-embeddings.json`, `tmp/context-index-state.json` (semantic index state)
- `tmp/autonomy-state.json` (autonomy budget + proactive intents)

## 8) Recommended operator commands

```bash
# full tests
npm test

# security-focused tests
npm run test:security
npm run test:redteam

# dependency audit
npm run security:audit
```

## 9) Enabling optional capabilities

### MCP tooling

Enable in config:

```json
{
  "mcp": {
    "enabled": true,
    "allowServers": []
  }
}
```

This enables tool registration for:

- `mcp_list_resources`
- `mcp_read_resource`
- `mcp_call_tool`

### Semantic context compression

```json
{
  "contextCompression": {
    "semanticRetrievalEnabled": true,
    "topK": 8
  }
}
```

### Exec tool and security

- **Strict profile (default):** Only a fixed set of binaries (`echo`, `pwd`, `ls`, `cat`, `node`) are allowed. Safe for production.
- **Developer profile:** All bins in `tools.exec.allowBins` are allowed; they run with the same privileges as the CursorClaw process. Use only on loopback or in dev mode. See [Configuration Reference — Security: Exec allowlist](./configuration-reference.md#security-exec-allowlist).

### Reflection background jobs

```json
{
  "reflection": {
    "enabled": true,
    "idleAfterMs": 120000,
    "tickMs": 30000,
    "flakyRuns": 3,
    "flakyTestCommand": "npm test"
  }
}
```

## 10) Common startup/runtime issues

- **401 AUTH_MISSING / AUTH_INVALID**
  - Missing/incorrect `Authorization: Bearer ...` or revoked token.
- **400 PROTO_VERSION_UNSUPPORTED**
  - RPC `version` must match configured `gateway.protocolVersion` (default `2.0`).
- **403 AUTH_ROLE_MISMATCH**
  - Method not allowed for resolved role (`local` / `remote` / `admin`).
- **413 Payload Too Large**
  - Exceeded Fastify `bodyLimitBytes` (default 64 KiB).
- **400 message too long**
  - Per-message length exceeded `session.maxMessageChars`.
- **tool execution blocked**
  - Approval/capability policy denied tool call, or incident mode enabled tool isolation.
