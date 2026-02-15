# Tailnet Security Improvements — Implementation Guide

**Purpose:** Define potential security improvements when using Tailscale (Tailnet) to access the app—in particular, configuring the gateway to listen on a specific address (e.g. the host’s Tailscale IP) instead of all interfaces, so only intended traffic (e.g. Tailnet) is accepted.

**Context:** Shared message view is working: with the correct API key, mobile clients via Tailnet see the same messages and stream as desktop. Server-side thread storage (`chat.getThread` / `thread.set`) and UI loading from the server are in place. This guide does not cover message parity; it focuses only on security when exposing the gateway over Tailnet.

---

## 1) Problem Statement

- The gateway listens on either `127.0.0.1` (loopback) or `0.0.0.0` (all interfaces) via `config.gateway.bind`. There is no way to bind to a specific address (e.g. the host’s Tailscale IP). Listening on `0.0.0.0` accepts traffic on every interface, which is less secure when the primary use case is access via Tailnet; binding only to the Tailscale address would restrict the server to that interface.

---

## 2) Goals

1. **Configurable bind address:** The user can set the gateway listen address (e.g. Tailscale IP or hostname) via config or UI, so the server binds to that address instead of `0.0.0.0` when not using loopback.
2. **Validation and safety:** Only allow binding to addresses that are appropriate for the machine (e.g. loopback, link-local, Tailscale range); reject invalid or unsafe values with a clear startup error.

---

## 3) Proposed Design

### 3.1 Gateway bind address

- **Config:** Extend `GatewayConfig` with an optional `bindAddress?: string`. Semantics:
  - If `bindAddress` is set and non-empty, listen on that address (override or take precedence over `bind` for the listen host).
  - If `bindAddress` is not set, keep current behavior: `bind === "loopback"` → `127.0.0.1`, else `0.0.0.0`.
- **Validation:** Only allow binding to addresses that resolve to the machine (e.g. loopback, link-local, or Tailscale); reject obviously unsafe values (e.g. other hosts’ IPs) if detectable. Tailscale IPs are typically in the 100.x.x.x range (CGNAT); document allowed ranges.
- **UI:** Optional: settings or status page field to set and persist the Tailscale (or other) address so the user does not have to edit config by hand. Persistence would write to config overlay or profile config.

---

## 4) Implementation Phases

**Phase V.3 – Configurable bind address (Tailnet security)**

- [x] **V.3.1** Config: add `gateway.bindAddress?: string`. In the place where `listen` is called (e.g. `index.ts`), if `bindAddress` is set and non-empty, use it as the listen host; otherwise keep current logic (loopback vs 0.0.0.0).
- [x] **V.3.2** Validate `bindAddress`: allow loopback, link-local, and private ranges; document that Tailscale IPs are typically in 100.x.x.x. Reject invalid or unsafe values with a clear startup error.
- [x] **V.3.3** Optional: UI or status page to set and persist Tailscale address (writes to config or overlay). Document in configuration reference.

---

## 5) Success Criteria

- [x] Gateway can be configured to listen on a specific address (e.g. Tailscale); when so configured, the server does not listen on 0.0.0.0.
- [x] Invalid or unsafe bind addresses are rejected at startup with a clear error.
- [x] Existing behavior is unchanged when `bindAddress` is not set.

---

## 6) Guardrails

- **Bind address:** Do not bind to addresses that clearly belong to another machine; validate or document allowed ranges (loopback, link-local, Tailscale/100.x.x.x, and any other intended private ranges).
- **Backward compatibility:** When `bindAddress` is omitted, current behavior (loopback vs all interfaces via `bind`) must be preserved.

---

## 7) Document Metadata

- **Version:** 1.2
- **Status:** Refocused on Tailnet security only. Shared message view (Phases V.1–V.2) is implemented and confirmed working (mobile/desktop parity via Tailnet with correct key). Phase V.3.1–V.3.2 implemented: `gateway.bindAddress` in config, listen host uses it when set, validation allows loopback/link-local/private/Tailscale (100.64.0.0/10) and rejects 0.0.0.0 and public IPs. V.3.3 implemented: Config page has Gateway bind address (Tailscale) field with Save; persists via config.patch.
