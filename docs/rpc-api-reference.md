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
- `cron.add`: admin, local
- `incident.bundle`: admin
- `approval.list`: admin, local
- `approval.resolve`: admin, local
- `approval.capabilities`: admin, local
- `advisor.file_change`: local, remote, admin
- `workspace.status`: local, remote, admin
- `workspace.semantic_search`: local, remote, admin
- `trace.ingest`: local, remote, admin
- `advisor.explain_function`: local, remote, admin

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
  - bounded by `session.maxMessagesPerTurn`
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

### 5.5 `incident.bundle`

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

### 5.6 `approval.list`

Lists approval workflow requests.

`params`:

- `status?: "pending" | "approved" | "denied" | "expired"`

Returns:

```json
{ "requests": [ ... ] }
```

---

### 5.7 `approval.resolve`

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

### 5.8 `approval.capabilities`

Lists active capability grants.

Returns:

```json
{ "grants": [ ... ] }
```

---

### 5.9 `advisor.file_change`

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

### 5.10 `workspace.status`

Delegates to workspace status service callback.

No required params.

Typical result includes:

- workspace root health
- indexed file count
- cross-repo edge count
- graph build timestamp

---

### 5.11 `workspace.semantic_search`

Semantic retrieval across indexed workspace modules.

`params`:

- `query: string` (required, non-empty)
- `topK?: positive integer` (default `8`)
- `workspace?: string`
- `repo?: string`

Returns callback-defined structure; default integration returns grouped module hits and cross-repo suspects.

---

### 5.12 `trace.ingest`

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

### 5.13 `advisor.explain_function`

Explains function/symbol behavior in indexed module context.

`params`:

- `modulePath: string` (required)
- `symbol: string` (required)

Returns callback-defined explanation payload; default integration includes summary, side effects, caller hints, history, confidence, and provenance.

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
