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

From the **same directory** that contains your `openclaw.json` (or set `$env:CURSORCLAW_CONFIG_PATH` to its full path before starting):

```powershell
npm start
```

On startup you should see a line like: `[CursorClaw] config: C:\...\openclaw.json | gateway auth token length: 44`. Use that to confirm which config file is loaded and that the token length matches what you'll send in requests.

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

Set your token to the **exact** value in `openclaw.json` under `gateway.auth.token` (not the placeholder):

```powershell
$env:TOKEN = "paste-your-actual-token-from-openclaw-json-here"
```

Verify it’s set (optional; doesn’t print the secret):

```powershell
if (-not $env:TOKEN) { Write-Warning "TOKEN is not set" } else { Write-Host "Token is set ($($env:TOKEN.Length) chars)" }
```

**Send a chat message (`chat.send`):**

```powershell
$headers = @{ Authorization = "Bearer $env:TOKEN" }
$body = @{
  id     = "1"
  version = "2.0"
  method = "chat.send"
  params = @{
    channelId = "dm:user-1"
    text      = "Hello from RPC"
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "http://127.0.0.1:8787/rpc" -Method Post -ContentType "application/json" -Headers $headers -Body $body
```

**Run an agent turn (`agent.run` + `agent.wait`):**

1. Create a run (capture `runId` from the response). Use the same `$headers` from the chat.send step (or set `$headers = @{ Authorization = "Bearer $env:TOKEN" }` again):

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

   $runResp = Invoke-RestMethod -Uri "http://127.0.0.1:8787/rpc" -Method Post -ContentType "application/json" -Headers $headers -Body $runBody
   $runId = $runResp.result.runId
   ```

2. Wait for completion and **read the agent response**:

   ```powershell
   $waitBody = @{ version = "2.0"; method = "agent.wait"; params = @{ runId = $runId } } | ConvertTo-Json
   $waitResp = Invoke-RestMethod -Uri "http://127.0.0.1:8787/rpc" -Method Post -ContentType "application/json" -Headers $headers -Body $waitBody
   ```

   The agent’s reply is in the **`result`** of the wait response:

   - **`$waitResp.result.assistantText`** — the assistant’s reply text (this is what you want to see).
   - `$waitResp.result.events` — turn events (queued, started, tool, assistant, completed, etc.).
   - `$waitResp.result.runId` — same run id.

   To print the agent’s reply in the console:

   ```powershell
   $waitResp.result.assistantText
   ```

   To see the full result (including events) as JSON:

   ```powershell
   $waitResp.result | ConvertTo-Json -Depth 5
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
| **Cursor model** | Add `cursor-auto` model with `cursor-agent-cli` | See below. |

### Using your local Cursor-Agent CLI

To use your local **Cursor-Agent CLI** (real model) instead of the fallback, add a `cursor-auto` model and set it as default.

1. **Ensure the CLI is available.** The adapter spawns a process; the executable must be on your `PATH`, or you must set `command` to the full path (e.g. `C:\path\to\cursor-agent.exe` or `/usr/local/bin/cursor-agent`).

2. **In `openclaw.json`, set `defaultModel` and add the model entry:**

   ```json
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
   ```

   - **`command`** — Executable name if on `PATH` (e.g. `"agent"`), or full path. On Windows you can use `agent.cmd` or `agent.bat`; CursorClaw runs `.cmd`/`.bat` via `cmd.exe /c` so they don’t cause spawn errors.
   - **`args`** — For the official Cursor CLI use `-p`, `--output-format stream-json`, and **`promptAsArg`: true** (prompt as last argument; do not use `--stream-json`).
   - **`fallbackModels`** — If the CLI fails (auth, timeout, crash), CursorClaw will try `fallback-default` automatically.

3. **Restart CursorClaw** after changing config. Then run an `agent.run` / `agent.wait`; the turn will use the CLI and you should see real model output in `result.assistantText`.

With `promptAsArg`: true the adapter passes the user message as the last CLI argument; the CLI must emit NDJSON on stdout. The adapter also appends **`--approve-mcps`** and **`--force`** in headless mode so the Cursor CLI can use MCP tools (e.g. web fetch, web search) without interactive approval. See [Cursor-Agent Adapter Contract](docs/cursor-agent-adapter.md).

### Using a local Ollama agent (for testing)

To run a **local Ollama** model so you can test CursorClaw without the Cursor-Agent CLI or a hosted API:

1. **Install and start Ollama**
   - Install from [ollama.com](https://ollama.com) (or e.g. `winget install Ollama.Ollama` on Windows, `brew install ollama` on macOS).
   - Start Ollama: on most setups the Ollama app runs the server automatically. Default base URL: **`http://localhost:11434`**. To confirm it’s running:
     ```powershell
     Invoke-RestMethod -Uri "http://localhost:11434/api/tags"
     ```
     You should get a JSON list of models (or `{"models":[]}` if none pulled yet).

2. **Pull a model**
   - In a terminal: `ollama pull llama3.2` (or another model, e.g. `llama3.2`, `granite3.2`, `mistral`). Use a model that fits your RAM (e.g. 8GB+ for smaller 7B-class models).

3. **Add an Ollama model to `openclaw.json`**
   - In the `models` section add an entry with `provider: "ollama"` and `ollamaModelName` set to the model you pulled. Optionally set `defaultModel` to this model, or use it in a profile via the Config UI.
   - Example (default on local Ollama, with fallback):
     ```json
     "defaultModel": "ollama-local",
     "models": {
       "ollama-local": {
         "provider": "ollama",
         "ollamaModelName": "llama3.2",
         "baseURL": "http://localhost:11434",
         "timeoutMs": 120000,
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
     ```
   - Omit `baseURL` to use the default `http://localhost:11434`; set it if your Ollama server is on another host/port.

4. **Restart CursorClaw** so it loads the new config.

5. **Test the agent**
   - **From the Web UI:** Open the Chat page, pick the profile that uses the Ollama model (or the default profile if you set `defaultModel`), and send a message.
   - **From RPC:** Use the same `agent.run` / `agent.wait` flow as in Step 6; the reply will come from your local Ollama model.

**Notes:** The Ollama provider supports **tool-call** when the model and Ollama version support it; see [Local Ollama agent setup](docs/local-ollama-agent-setup.md) §8 (tool use) and [Ollama tool-call support](docs/Ollama-tool-call-support.md). For hardware requirements and best-effort behavior, see [Provider and Model Resilience](docs/PMR-provider-model-resilience.md) §8. To discover models from the UI, open Config → select a profile → set provider to **ollama** → click **Refresh from provider** → choose a model and Save.

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
| Agent reply after `agent.wait` | In the response: `$waitResp.result.assistantText` |
| Web UI | After `npm run build`, open `http://127.0.0.1:8787/` in a browser; log in with the token from `openclaw.json`. |

---

## Web UI

After building with `npm run build`, the server serves the UI from `ui/dist` at the same origin as the API. Open `http://127.0.0.1:8787/` (or your gateway URL), enter the gateway URL and the token from `openclaw.json` under `gateway.auth.token`, and click Connect. The UI provides Dashboard, Chat (agent run/wait, chat.send), Approvals, Cron, Workspace (status, semantic search, advisor), Incidents, Config (read-only), and Trace ingest.

---

## Troubleshooting

- **401 AUTH_MISSING** — No token was sent. Set `$env:TOKEN` and use `-Headers @{ Authorization = "Bearer $env:TOKEN" }` (or the `$headers` variable from Step 6).
- **401 AUTH_INVALID** — The token in the request does not match the server. Do this:
  1. **Same config for server and client:** The server loads `openclaw.json` from the directory where you ran `npm start` (or from `CURSORCLAW_CONFIG_PATH` if set). When you start the server, check the first log line: `[CursorClaw] config: <path> | gateway auth token length: N`. The path must be the same file you edit, and N must match your token length (e.g. 44). If you use a different folder (e.g. `CursorClaw_Dev` vs `CursorClaw`), start the server from the folder that has the `openclaw.json` you edited, or set `$env:CURSORCLAW_CONFIG_PATH = "C:\full\path\to\openclaw.json"` **before** running `npm start`.
  2. Open that same `openclaw.json` and copy the value of `gateway.auth.token` (the whole string, no extra spaces or newlines).
  3. In the **same** PowerShell session where you run `Invoke-RestMethod`, run: `$env:TOKEN = "paste-that-value-here"`.
  4. Run the RPC command again. Do not use the placeholder `"your-strong-token-here"`; use the real token from the file.
- **Startup rejects config** — Ensure token is not `changeme`, `undefined`, or `null`.
- **400 PROTO_VERSION_UNSUPPORTED** — Send `"version": "2.0"` in RPC JSON.
- **Tool execution blocked** — Check approval/capability policy or incident mode; see [Configuration Reference](docs/configuration-reference.md) and [RPC API Reference](docs/rpc-api-reference.md).
- **Getting fallback response instead of cursor-auto** — The Cursor-Agent CLI failed for the last turn, so the runtime used the fallback model. In the UI Dashboard, check the **Cursor-Agent CLI fallback** box (it shows the last error). Common causes:
  1. **Command not found** — The `command` in `openclaw.json` (e.g. `agent` or `agent.cmd`) must be on your `PATH`, or set `command` to the full path to the executable (e.g. `C:\path\to\agent.cmd` on Windows).
  2. **CLI stream not accepted** — The CLI must emit NDJSON events on stdout. The adapter accepts a final `done` event, or a `result` event (treated as end-of-turn), or exit code 0 after at least one forwardable event. With `promptAsArg: true` the adapter does not write turn JSON to stdin; it passes the user message as the last argument. See [Cursor-Agent Adapter Contract](docs/cursor-agent-adapter.md).
  3. **Timeout** — Increase `timeoutMs` for the `cursor-auto` model in config if the CLI is slow.
  4. **Wrong args** — For the official Cursor CLI use `-p`, `--output-format stream-json`, and `promptAsArg: true` (see Step 7). Do not use `--stream-json`; use `--output-format stream-json`. Ensure `args` in config match what your CLI expects.

For more detail: [Getting Started](docs/getting-started.md), [Configuration Reference](docs/configuration-reference.md), [RPC API Reference](docs/rpc-api-reference.md), [Cursor-Agent Adapter Contract](docs/cursor-agent-adapter.md).
