# CursorClaw RPC API Reference

This document describes the gateway API implemented in `src/gateway.ts`.

## 1) Base URL and transport

- Default base URL: `http://127.0.0.1:8787`
- Protocol: HTTP/1.1 JSON over `POST /rpc`
- Additional endpoints:
  - `GET /health`
  - `GET /status`

## 2) Authentication and role model

Authentication is handled by `AuthService` (`src/security.ts`), configured via `gateway.auth`.

Supported auth modes:

- `token`: expects `Authorization: Bearer <token>`
- `password`: expects `x-gateway-password: <password>`
- `none`: no credential check

Resolved roles:

- `local` (loopback request in `none` mode)
- `remote` (non-loopback authenticated request)
- `admin` (loopback authenticated request in token/password modes)

Optional trusted identity header enforcement:

- If `gateway.auth.trustedIdentityHeader` is configured, request must come from `gateway.trustedProxyIps` and include that header.

## 3) RPC envelope

### Request

```json
{
  "id": "optional-client-id",
  "version": "2.0",
  "method": "chat.send",
  "params": {}
}
```

**Profile-scoped RPCs:** For multi-agent setups, `params` may include an optional `profileId` string. When present, the request is executed in the context of that agent profile (substrate, memory, approvals, etc.). When omitted, the gateway uses the default profile. Single-agent deployments ignore this and use the single profile. Profile-scoped methods include: `heartbeat.poll`, `heartbeat.getFile`, `heartbeat.update`, `memory.*`, `substrate.*`, `skills.list`, `skills.fetchFromUrl`, `skills.analyze`, `skills.install`, `skills.credentials.set`, `skills.credentials.delete`, `skills.credentials.list`, `approval.*`, `cron.list`/`cron.add`, `workspace.status`/`workspace.semantic_search`, `trace.ingest`, `advisor.file_change`/`advisor.explain_function`, `incident.bundle`, `chat.getThread`, and `thread.set`. `agent.run` accepts `session.profileId` to run the turn in that profile's context.

### Success response

```json
{
  "id": "optional-client-id",
  "auditId": "req_<uuid>",
  "ok": true,
  "result": {}
}
```

### Error response

```json
{
  "id": "optional-client-id",
  "auditId": "req_<uuid>",
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "..."
  }
}
```

## 4) Global request guards

Before method execution, gateway applies:

1. Envelope validation (`method`, `version`)
2. Protocol version match (`version === gateway.protocolVersion`)
3. Authentication + role-scope check
4. Per-method/per-subject rate limiting (`MethodRateLimiter`)
5. Inbound risk scoring (`scoreInboundRisk`)

If risk score is `>= 90`, request is blocked with `RISK_BLOCKED`.

## 5) Endpoint details

## `GET /health`

Returns process liveness:

```json
{
  "ok": true,
  "time": "2026-..."
}
```

## `GET /status`

Returns operational snapshot including:

- `gateway`
- `defaultModel`
- `profiles` — array of `{ id, root, modelId? }`; when no profiles are configured, `[{ id: "default", root: "." }]`
- `defaultProfileId` — id of the default profile
- `queueWarnings`
- `runtimeMetrics`
- `schedulerBacklog`
- `policyDecisions`
- `approvals.pending`
- `approvals.activeCapabilities`
- `incident.proactiveSendsDisabled`
- `incident.toolIsolationEnabled`

## `POST /rpc` methods

Method scope rules (`METHOD_SCOPES`):

- `agent.run`: local, remote, admin
- `agent.wait`: local, remote, admin
- `chat.send`: local, remote, admin
- `chat.getThread`: local, remote, admin
- `thread.set`: local, remote, admin
- `cron.add`: admin, local
- `cron.list`: admin, local
- `incident.bundle`: admin
- `approval.list`: admin, local
- `approval.resolve`: admin, local
- `approval.capabilities`: admin, local
- `advisor.file_change`: local, remote, admin
- `workspace.status`: local, remote, admin
- `workspace.semantic_search`: local, remote, admin
- `trace.ingest`: local, remote, admin
- `advisor.explain_function`: local, remote, admin
- `config.get`: admin, local
- `profile.list`: admin, local
- `profile.create`: admin, local
- `profile.delete`: admin, local
- `substrate.list`: admin, local
- `substrate.get`: admin, local
- `substrate.update`: admin, local
- `substrate.reload`: admin, local
- `heartbeat.poll`: local, remote, admin
- `heartbeat.getFile`: admin, local
- `heartbeat.update`: admin, local
- `skills.fetchFromUrl`: admin, local
- `skills.list`: admin, local
- `skills.analyze`: admin, local
- `skills.install`: admin, local
- `skills.credentials.set`: admin, local
- `skills.credentials.delete`: admin, local
- `skills.credentials.list`: admin, local

---

### 5.1 `agent.run`

Starts an asynchronous runtime turn.

`params`:

- `session` (required):
  - `sessionId: string`
  - `channelId: string`
  - `channelKind: "dm" | "group" | "web" | "mobile"`
  - `userId?: string`
- `messages` (required):
  - array of `{ role: string, content: string }`
  - per-request count bounded by `session.maxMessagesPerTurn` (default 10000); runtime compacts long threads so users are not blocked
  - each `content` bounded by `session.maxMessageChars`

Returns:

```json
{ "runId": "<uuid>" }
```

---

### 5.2 `agent.wait`

Waits for a run started by `agent.run`.

`params`:

- `runId: string` (required)

Returns full `TurnResult` when complete, including:

- `runId`
- `assistantText`
- `events`
- optional confidence fields (`confidenceScore`, `confidenceRationale`, `requiresHumanHint`)

Important behavior:

- Completed/failed run entries are consumed after retrieval.
- A second `agent.wait` on same run usually returns `NOT_FOUND`.

---

### 5.3 `chat.send`

Sends outbound text through configured channel hub (or local fallback result).

`params`:

- `channelId: string`
- `text: string`
- `threadId?: string`
- `proactive?: boolean`
- `urgent?: boolean`
- `isNewThread?: boolean` (used by behavior planning)

Behavior:

- If `proactive=true` and incident mode disabled proactive sends, returns `FORBIDDEN`.
- Behavior policy may pace/block a send and return `{ delivered: false, reason: "paced" }`.
- Greeting policy can prepend `"Hi! "` in eligible new-thread cases.

---

### 5.3.1 `chat.getThread`

Returns the persisted chat thread (message list) for a session so desktop and mobile (e.g. via Tailscale) see the same messages. Profile-scoped; when `profileId` is omitted, the default profile is used.

`params`:

- `sessionId: string` (required)

Returns:

- `messages: Array<{ id: string; role: "user" | "assistant"; content: string; at?: string }>`

When the thread store is not configured or the session has no persisted thread, returns `{ messages: [] }`. The thread is updated on each `agent.run` (request message list is stored), when the run completes (assistant reply is appended), and when the client calls `thread.set`.

---

### 5.3.2 `thread.set`

Persists the full chat thread for a session so that other clients (e.g. desktop and Tailscale) see the same messages. Profile-scoped via optional `params.profileId`. Use after the UI updates the message list (e.g. after a streamed assistant message) so the server state stays in sync.

`params`:

- `sessionId: string` (required)
- `messages: Array<{ role: string; content: string }>` (required)

Returns:

- `ok: true` when the thread store is configured and write succeeded. If the thread store is not configured, the call still returns `{ ok: true }` (no-op).

---

### 5.4 `cron.add`

Registers a cron/every/at job.

`params`:

- `type`: `"at" | "every" | "cron"` (default `"every"`)
- `expression: string` (default `"30m"`)
- `isolated: boolean` (default `true`)

Returns:

```json
{
  "job": {
    "id": "...",
    "type": "every",
    "expression": "30m",
    "isolated": true,
    "maxRetries": 3,
    "backoffMs": 1000,
    "nextRunAt": 1700000000000
  }
}
```

---

### 5.5 `cron.list`

Lists registered cron jobs (admin, local).

No required params.

Returns:

```json
{ "jobs": [ { "id": "...", "type": "every", "expression": "30m", "isolated": true, "maxRetries": 3, "backoffMs": 1000, "nextRunAt": 1700000000000 } ] }
```

---

### 5.6 `incident.bundle`

Triggers incident containment actions.

`params`:

- `tokens?: string[]` (optional list to revoke immediately)

Side effects:

- Revokes provided tokens (hashed)
- Disables proactive sends
- Enables tool isolation mode for high-risk tools

Returns forensic bundle:

- `revokedTokenHashes`
- `proactiveDisabled`
- `isolatedTools`
- `policyLogs`

---

### 5.7 `approval.list`

Lists approval workflow requests.

`params`:

- `status?: "pending" | "approved" | "denied" | "expired"`

Returns:

```json
{ "requests": [ ... ] }
```

---

### 5.8 `approval.resolve`

Resolves a pending approval request.

`params`:

- `requestId: string` (required)
- `decision: "approve" | "deny"` (required)
- `reason?: string`
- `grantTtlMs?: positive integer`
- `grantUses?: positive integer`

Returns:

```json
{ "request": { ...updatedRequest } }
```

---

### 5.9 `approval.capabilities`

Lists active capability grants.

Returns:

```json
{ "grants": [ ... ] }
```

---

### 5.10 `advisor.file_change`

Generates proactive suggestions based on changed file paths.

`params`:

- `channelId: string` (default `"system"`)
- `files: string[]` (required)
- `enqueue?: boolean` (default `true`)

Returns:

```json
{
  "suggestions": ["..."],
  "queued": 0
}
```

---

### 5.11 `workspace.status`

Delegates to workspace status service callback.

No required params.

Typical result includes:

- workspace root health
- indexed file count
- cross-repo edge count
- graph build timestamp

---

### 5.12 `workspace.semantic_search`

Semantic retrieval across indexed workspace modules.

`params`:

- `query: string` (required, non-empty)
- `topK?: positive integer` (default `8`)
- `workspace?: string`
- `repo?: string`

Returns callback-defined structure; default integration returns grouped module hits and cross-repo suspects.

---

### 5.13 `trace.ingest`

Ingests network trace for route-to-module linking and observation logging.

`params`:

- `method: string` (default `"GET"`)
- `url: string` (required)
- `status?: positive integer` (default `200`)
- `latencyMs?: positive integer` (default `0`)
- `sessionId?: string`
- `requestBody?: unknown`
- `responseBody?: unknown`
- `headers?: Record<string, string>`

Returns callback-defined result; default integration returns acceptance status and linked module paths.

---

### 5.14 `advisor.explain_function`

Explains function/symbol behavior in indexed module context.

`params`:

- `modulePath: string` (required)
- `symbol: string` (required)

Returns callback-defined explanation payload; default integration includes summary, side effects, caller hints, history, confidence, and provenance.

---

### 5.15 `config.get`

Returns current runtime config with secrets redacted (admin, local).

No params.

Returns the same shape as [Configuration Reference](configuration-reference.md); `gateway.auth.token` and `gateway.auth.password` are replaced with `{ redacted: true, length?: number }`. Includes `profiles` when present.

---

### 5.15.1 `config.reload`

Reloads config from disk (`openclaw.json` or `CURSORCLAW_CONFIG_PATH`). The in-memory config is replaced immediately; heartbeat interval and other live settings apply on the next tick without restart. Requires `workspaceRoot` to be configured (admin, local).

No params.

Returns `{ ok: true }`.

---

### 5.15.2 `config.patch`

Merges a partial config into the current config and writes to disk. Only top-level keys in the allowlist are merged (e.g. `heartbeat`, `autonomyBudget`, `memory`, `reflection`, `session`, `compaction`, `workspaces`, `contextCompression`, `networkTrace`, `metrics`, `reliability`, `tools`, `substrate`, `profiles`). You can also pass `gateway` with **only** `bindAddress` and/or `bind`: `{ gateway: { bindAddress: "100.64.1.1" } }` (e.g. for Tailscale). Gateway auth, `defaultModel`, and `models` are not patchable. Changes apply in memory immediately; a change to `gateway.bindAddress` or `gateway.bind` takes effect only after restart. Requires `workspaceRoot` (admin, local). Requests from Tailscale IPs (100.x) are treated as local, so you can set the bind address and use Restart from another Tailscale device.

`params`: partial config object, e.g. `{ heartbeat: { everyMs: 60000, enabled: true } }` or `{ gateway: { bindAddress: "100.64.1.1" } }`.

Returns `{ ok: true }`.

---

### 5.16 `profile.list`

Returns the list of agent profiles and the default profile id (admin, local).

No params.

Returns:

```json
{
  "profiles": [ { "id": "default", "root": "." }, { "id": "assistant", "root": "profiles/assistant", "modelId": null } ],
  "defaultProfileId": "default"
}
```

When no profiles are configured, returns `profiles: [{ id: "default", root: "." }]` and `defaultProfileId: "default"`.

---

### 5.17 `profile.create`

Creates a new agent profile and persists config (admin, local). Requires `workspaceRoot` to be configured on the gateway.

`params`:

- `id: string` (required) — unique profile id
- `root: string` (required) — workspace-relative path for the profile root; must resolve under workspace (no path traversal)

Creates the profile root directory (mkdir -p). If no profiles exist yet, adds a default profile plus the new one. Returns `{ profile: { id, root }, configPath }`. Fails with `BAD_REQUEST` if id is empty, duplicate, or root is outside workspace.

---

### 5.18 `profile.delete`

Deletes an agent profile and persists config (admin, local). Requires `workspaceRoot` to be configured.

`params`:

- `id: string` (required) — profile id to remove
- `removeDirectory?: boolean` — if true, deletes the profile root directory (only if under workspace)

Returns `{ ok: true }`. Fails with `BAD_REQUEST` if there are no profiles (single default mode) or if deleting the only profile. Fails with `NOT_FOUND` if the profile id does not exist.

---

### 5.19 `substrate.list`

Returns which substrate files exist and their workspace-relative paths (admin, local). Requires substrate config to be present.

No params.

Returns:

```json
{
  "keys": [
    { "key": "identity", "path": "IDENTITY.md", "present": true },
    { "key": "soul", "path": "SOUL.md", "present": false }
  ]
}
```

---

### 5.20 `substrate.get`

Returns substrate content for the UI. If `key` is omitted, returns full `SubstrateContent`; if `key` is provided, returns `{ [key]: string | undefined }` (admin, local).

`params`:

- `key?`: `"agents" | "identity" | "soul" | "birth" | "capabilities" | "user" | "tools"` (optional)

Edits take effect on the next agent turn without restart (runtime reads from store each turn).

---

### 5.21 `substrate.update`

Writes content for one substrate key to the workspace file and updates the in-memory cache (admin, local). Path is resolved from config; must be under workspace root. Only allowed keys: agents, identity, soul, birth, capabilities, user, tools.

`params`:

- `key: string` (required)
- `content: string` (required)

Returns `{ ok: true }`. On path traversal or invalid key, returns `BAD_REQUEST`. Do not put secrets in substrate files (including AGENTS.md); they are included in the agent prompt.

---

### 5.22 `substrate.reload`

Re-reads all substrate files from disk and replaces the in-memory cache (admin, local). Use when files were edited outside the UI so the next turn uses the new content.

No params. Returns `{ ok: true }`.

---

### 5.23 `skills.install`

Fetches (if URL given) or uses provided definition, runs safety check, then runs the install section in a restricted context (profile `skills/install/<skillId>`). Records the skill in the profile's installed manifest (admin, local). Requires profile root.

`params`:

- **Option A:** `url: string` (required) — fetch skill.md from URL, parse, safety-check, then install.
- **Option B:** `definition: object` (required) and `sourceUrl: string` (required) — use pre-fetched definition; `definition` must have `description`, `install`, `credentials`, `usage` (strings).
- `skillId?: string` — optional id for the skill; default derived from URL path or `"skill"`.

If safety check fails, returns `BAD_REQUEST` with reason. If install script fails, returns `result: { installed: false, skillId, error, stdout, stderr }`. On success returns `result: { installed: true, skillId, credentialNames, stdout, stderr }`. Credential names are parsed from the Credentials section (backticked names); the user can set values via `skills.credentials.set`.

---

### 5.24 `skills.credentials.set`

Stores a credential value for a skill (admin, local). Profile-scoped; requires profile root. Values are never returned to the agent or included in prompts or logs.

`params`: `skillId: string`, `keyName: string`, `value: string`. All required. `skillId` and `keyName` must match `[a-zA-Z0-9_-]+`.

Returns `{ ok: true }`.

---

### 5.25 `skills.credentials.delete`

Removes a credential for a skill (admin, local). Profile-scoped.

`params`: `skillId: string`, `keyName: string`. Both required.

Returns `{ deleted: boolean }` — `true` if the key existed and was removed.

---

### 5.26 `skills.credentials.list`

Lists credential **names** for a skill (no values). Profile-scoped.

`params`: `skillId: string` (required).

Returns `{ names: string[] }`.

## 6) RPC error codes in practice

Common `error.code` values:

- `PROTO_VERSION_UNSUPPORTED`
- `AUTH_MISSING`
- `AUTH_INVALID`
- `AUTH_ROLE_MISMATCH`
- `RATE_LIMITED`
- `RISK_BLOCKED`
- `BAD_REQUEST`
- `NOT_FOUND`
- `RUN_UNAVAILABLE`
- `FORBIDDEN`
- `INTERNAL`

Tool-policy errors are typically surfaced as generic `INTERNAL` at gateway layer if thrown from runtime/tool execution path.

## 7) Minimal cURL templates

Authenticated template:

```bash
curl -s http://127.0.0.1:8787/rpc \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "id": "req-1",
    "version": "2.0",
    "method": "workspace.status",
    "params": {}
  }' | jq
```

## 8) Compatibility notes

- Protocol version is strict. Client and server must agree.
- Gateway body limit is strict (`gateway.bodyLimitBytes`).
- Message count/size limits are strict (`session.maxMessagesPerTurn`, `session.maxMessageChars`).
- `agent.wait` is consumptive for completed/failed runs.
