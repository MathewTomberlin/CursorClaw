# CursorClaw — Setup & Run Runbook

This runbook walks you through setting up CursorClaw **securely** and running it with full features. Use it for your first test run or for a clean environment.

---

## Prerequisites

- **Node.js ≥ 22** (required by `package.json`)
- **npm**
- A terminal (PowerShell, cmd, or bash)

Check Node:

```powershell
node -v
```

You should see `v22.x.x` or higher.

---

## Step 1 — Install and build

From the repo root:

```powershell
cd c:\Users\admin\Documents\Projects\CursorClaw
npm install
npm run build
```

---

## Step 2 — Create secure config

Config is loaded from `openclaw.json` in the current working directory (or from the path in `CURSORCLAW_CONFIG_PATH`).

**Important:** Never commit `openclaw.json`; it contains your auth token. It is listed in `.gitignore`.

1. Copy the example and edit:

   ```powershell
   copy openclaw.example.json openclaw.json
   ```

2. Open `openclaw.json` and **replace the token** with a strong random value:

   - Do **not** use `changeme`, `undefined`, or `null` — startup will reject them in secure mode.
   - Example (PowerShell) to generate a token and open the file:

   ```powershell
   # Generate a random token (optional)
   [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
   notepad openclaw.json
   ```

   Put that value in `gateway.auth.token` (replace `REPLACE-WITH-STRONG-RANDOM-TOKEN`).

3. Optional: use a config path elsewhere:

   ```powershell
   $env:CURSORCLAW_CONFIG_PATH = "C:\secure\path\to\openclaw.json"
   ```

---

## Step 3 — Run tests and security checks

Before first run, verify the project and dependencies:

```powershell
npm test
npm run test:security
npm run test:redteam
npm run security:audit
```

- **`npm test`** — full test suite  
- **`test:security`** — security-oriented tests  
- **`test:redteam`** — prompt-injection / red-team style tests  
- **`security:audit`** — `npm audit` with high severity; fix any reported issues

---

## Step 4 — Start the runtime

```powershell
npm start
```

Default:

- **Host:** `127.0.0.1` (loopback only; set `gateway.bind` to `"0.0.0.0"` in config to listen on all interfaces)
- **Port:** `8787` (override with `$env:PORT = "9999"` if needed)

Leave this terminal open while testing.

---

## Step 5 — Sanity check (health & status)

In a **new** terminal:

**Health:**

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" | ConvertTo-Json
```

Expected: `"ok": true` and a `"time"` field.

**Status (metrics, queue, incidents):**

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8787/status" | ConvertTo-Json -Depth 5
```

---

## Step 6 — First authenticated RPC call

Set your token (same value as in `openclaw.json`):

```powershell
$env:TOKEN = "your-strong-token-here"
```

**Send a chat message (`chat.send`):**

```powershell
$body = @{
  id     = "1"
  version = "2.0"
  method = "chat.send"
  params = @{
    channelId = "dm:user-1"
    text      = "Hello from RPC"
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "http://127.0.0.1:8787/rpc" -Method Post `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer $env:TOKEN" } `
  -Body $body
```

**Run an agent turn (`agent.run` + `agent.wait`):**

1. Create a run (capture `runId` from the response):

   ```powershell
   $runBody = @{
     version = "2.0"
     method  = "agent.run"
     params  = @{
       session = @{
         sessionId   = "demo-session"
         channelId   = "dm:demo-session"
         channelKind = "dm"
       }
       messages = @(
         @{ role = "user"; content = "Summarize current runtime state." }
       )
     }
   } | ConvertTo-Json -Depth 6

   $runResp = Invoke-RestMethod -Uri "http://127.0.0.1:8787/rpc" -Method Post `
     -ContentType "application/json" `
     -Headers @{ Authorization = "Bearer $env:TOKEN" } `
     -Body $runBody

   $runId = $runResp.result.runId
   ```

2. Wait for completion:

   ```powershell
   $waitBody = @{ version = "2.0"; method = "agent.wait"; params = @{ runId = $runId } } | ConvertTo-Json
   Invoke-RestMethod -Uri "http://127.0.0.1:8787/rpc" -Method Post `
     -ContentType "application/json" `
     -Headers @{ Authorization = "Bearer $env:TOKEN" } `
     -Body $waitBody
   ```

---

## Step 7 — Optional: enable full features

Edit `openclaw.json` as needed. Key sections:

| Feature | Config section | Notes |
|--------|----------------|--------|
| **MCP tools** | `mcp.enabled: true`, `mcp.allowServers` | Already in example; allowlist servers if desired |
| **Semantic context** | `contextCompression.semanticRetrievalEnabled: true`, `topK` | Already in example |
| **Reflection jobs** | `reflection.enabled: true`, `idleAfterMs`, `tickMs`, `flakyTestCommand` | Runs background checks when idle |
| **Exec tool (dev)** | `tools.exec.profile: "developer"`, `tools.exec.allowBins` | Only on loopback/dev; strict profile is safer |
| **Cursor model** | Add `cursor-auto` model with `cursor-agent-cli` | See [Configuration Reference](docs/configuration-reference.md) § 4.14 and § 6 |

For a **production-like** setup:

- Keep `gateway.bind: "loopback"` unless you need remote access (then use a reverse proxy and TLS).
- Keep `gateway.auth.mode: "token"` and a strong token.
- Leave `tools.exec.profile: "strict"` (default).
- Use `privacy.scanBeforeEgress: true` (default).

---

## Step 8 — Files CursorClaw creates at runtime

In the working directory you will see:

- `MEMORY.md`, `memory/YYYY-MM-DD.md` — durable memory
- `CLAW_HISTORY.log` — decision journal
- `tmp/snapshots/*.json` — turn event snapshots
- `tmp/run-store.json` — run state
- `tmp/cron-state.json`, `tmp/workflow-state/*` — scheduler state
- `tmp/context-*.json`, `tmp/autonomy-state.json` — index and autonomy state

These are normal; add `tmp/` and log paths to backup/exclusion rules as needed.

---

## Quick reference

| Task | Command |
|------|--------|
| Install & build | `npm install && npm run build` |
| Tests | `npm test` |
| Security tests | `npm run test:security` and `npm run test:redteam` |
| Dependency audit | `npm run security:audit` |
| Start | `npm start` |
| Health | `GET http://127.0.0.1:8787/health` |
| Status | `GET http://127.0.0.1:8787/status` |
| RPC | `POST http://127.0.0.1:8787/rpc` with `Authorization: Bearer <token>` |

---

## Troubleshooting

- **401 AUTH_MISSING / AUTH_INVALID** — Use `Authorization: Bearer <token>` with the same value as in `openclaw.json`.
- **Startup rejects config** — Ensure token is not `changeme`, `undefined`, or `null`.
- **400 PROTO_VERSION_UNSUPPORTED** — Send `"version": "2.0"` in RPC JSON.
- **Tool execution blocked** — Check approval/capability policy or incident mode; see [Configuration Reference](docs/configuration-reference.md) and [RPC API Reference](docs/rpc-api-reference.md).

For more detail: [Getting Started](docs/getting-started.md), [Configuration Reference](docs/configuration-reference.md), [RPC API Reference](docs/rpc-api-reference.md).
