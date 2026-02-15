# Shared Message View and Tailscale Binding — Implementation Guide

**Purpose:** (1) Ensure that when accessing the app via Tailscale (e.g. from a phone), the same messages and stream are visible as on the desktop app. (2) Allow configuring the gateway to listen on a specific address (e.g. Tailscale) instead of all interfaces, for better security.

**Prerequisite:** Existing gateway, UI, and lifecycle stream; no dependency on Agent Profiles for the message-sharing fix (thread storage can be profile-scoped later if desired).

---

## 1) Problem Statement

- **Shared messages:** Today, the Chat UI stores the conversation thread in the browser’s `sessionStorage` (`loadThread` / `saveThread` in `ui/src/contexts/ChatContext.tsx`). Each device/browser has its own storage, so the desktop app and a client connecting via the Tailscale address see different message lists even for the same logical session. The server-side lifecycle stream is keyed by `sessionId` and is shared—clients that use the same `sessionId` receive the same stream events—but the persisted thread is not shared.
- **Binding:** The gateway listens on either `127.0.0.1` (loopback) or `0.0.0.0` (all interfaces) via `config.gateway.bind`. There is no way to bind to a specific address (e.g. the host’s Tailscale IP) so that only Tailscale traffic is accepted on that interface, which would be more secure than listening on all interfaces.

---

## 2) Goals

1. **Shared message view:** Any client (desktop browser or Tailscale client) that connects with the same session (and optionally profile) sees the same conversation thread and continues to receive the same lifecycle stream.
2. **Configurable bind address:** The user can set the gateway listen address (e.g. Tailscale IP or hostname) via config or UI, so the server binds to that address instead of `0.0.0.0` when not using loopback.

---

## 3) Proposed Design

### 3.1 Server-side thread storage

- **Store:** Persist chat thread per (sessionId, profileId?) on the server. Storage under profile root (e.g. `{profileRoot}/tmp/threads/{sessionId}.json` or similar) so it aligns with Agent Profiles and stays off the main workspace.
- **API:** Add RPCs or REST endpoints, e.g.:
  - `thread.get` (sessionId, profileId?) → list of messages for that session.
  - `thread.append` (sessionId, profileId?, messages or delta) → append/update and return current thread.
  - Or a single `thread.sync` that accepts full thread and returns server state (merge or replace by policy).
- **UI:** On load, the Chat UI fetches the thread from the server for the current sessionId (and profileId) instead of (or in addition to) `sessionStorage`. On send or when messages change, the UI pushes updates to the server. Option: keep a short-lived local cache for responsiveness and sync to server on blur or on interval.
- **Backward compatibility:** If server-side thread storage is not yet available or fails, fall back to existing sessionStorage behavior so existing deployments keep working.

### 3.2 Lifecycle stream

- The `/stream` endpoint already subscribes by `sessionId`; no change required for sharing the stream across clients. Ensure the UI always sends the same `sessionId` for the same logical conversation (e.g. default session or user-selected session); then desktop and Tailscale clients will see the same events once they share the same thread via 3.1.

### 3.3 Gateway bind address

- **Config:** Extend `GatewayConfig` with an optional `bindAddress?: string`. Semantics:
  - If `bindAddress` is set, listen on that address (and ignore `bind` for the listen host, or treat `bind` as a fallback when `bindAddress` is empty).
  - If `bindAddress` is not set, keep current behavior: `bind === "loopback"` → `127.0.0.1`, else `0.0.0.0`.
- **Validation:** Only allow binding to addresses that resolve to the machine (e.g. loopback, link-local, or Tailscale); reject obviously unsafe values (e.g. other hosts’ IPs) if detectable.
- **UI:** Optional: settings or status page field to set and persist the Tailscale (or other) address so the user does not have to edit config by hand. Persistence would write to config overlay or profile config.

---

## 4) Implementation Phases

**Phase V.1 – Server-side thread storage**

- [ ] **V.1.1** Define thread storage layout under profile root (e.g. `{profileRoot}/tmp/threads/{sessionId}.json`) and format (array of messages with role, content, id, timestamp, etc.).
- [ ] **V.1.2** Implement server-side read/write for thread (get, append or replace) keyed by (profileId, sessionId). Ensure path safety: sessionId and profileId must not allow path traversal.
- [ ] **V.1.3** Add RPCs: e.g. `thread.get` (params: sessionId, profileId?), `thread.set` (params: sessionId, profileId?, messages). Document in RPC reference.
- [ ] **V.1.4** Gateway and auth: thread RPCs are subject to same auth as chat (local/remote/admin as appropriate); no cross-profile access unless authorized.

**Phase V.2 – UI uses server thread**

- [ ] **V.2.1** Chat UI: on mount or session change, call `thread.get` for current sessionId (and profileId). Use result as initial messages; if RPC fails or is unavailable, fall back to sessionStorage.
- [ ] **V.2.2** On message list change (user send or received), call `thread.set` (or append) so the server has the latest thread. Optionally keep sessionStorage as backup or cache.
- [ ] **V.2.3** Ensure both desktop and Tailscale clients use the same sessionId for the same conversation (e.g. default "main" or user-chosen session); then both will receive the same thread from server and same stream from `/stream`.

**Phase V.3 – Configurable bind address**

- [ ] **V.3.1** Config: add `gateway.bindAddress?: string`. In `index.ts` (or wherever `listen` is called), if `bindAddress` is set and non-empty, use it as the listen host; otherwise keep current logic (loopback vs 0.0.0.0).
- [ ] **V.3.2** Validate `bindAddress`: allow loopback, link-local, and private ranges; document that Tailscale IPs are typically in 100.x.x.x. Reject invalid or unsafe values with a clear startup error.
- [ ] **V.3.3** Optional: UI or status page to set and persist Tailscale address (writes to config or overlay). Document in configuration reference.

---

## 5) Success Criteria

- [ ] When two clients (e.g. desktop and Tailscale) use the same sessionId and profileId, they see the same conversation thread after refresh or initial load.
- [ ] Lifecycle stream events for that sessionId are already shared; no regression.
- [ ] If server-side thread is unavailable, the UI still works with sessionStorage.
- [ ] Gateway can be configured to listen on a specific address (e.g. Tailscale); when so configured, the server does not listen on 0.0.0.0.
- [ ] Path safety: thread files are only under profile root; sessionId/profileId do not allow path traversal.

---

## 6) Guardrails

- **Path safety:** sessionId and profileId must be validated (e.g. alphanumeric, hyphen, underscore only) so that paths stay under the intended directory.
- **Auth:** Thread RPCs must use the same authorization as other chat/run RPCs; no leaking threads across users or profiles without permission.
- **Backward compatibility:** Absence of thread RPCs or server-side storage must not break the existing UI (fallback to sessionStorage).
- **Bind address:** Do not bind to addresses that clearly belong to another machine; validate or document allowed ranges.

---

## 7) Document Metadata

- **Version:** 1.0
- **Status:** Draft implementation guide; not yet implemented.
