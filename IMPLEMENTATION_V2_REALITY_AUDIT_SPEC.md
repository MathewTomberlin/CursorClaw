# CursorClaw v2 Reality Audit and Fix Specification

**Date:** 2026-02-13  
**Branch:** `cursor/agent-framework-analysis-1804`  
**Scope:** Validate implemented v2 behavior against intended spec, OpenClaw baseline expectations, and public security discussion patterns.

---

## 1) Audit Objective

This document answers:

1. Which intended v2 features are fully functional.
2. Which features are partially implemented or not wired.
3. What security implications exist today and are practical to fix.
4. How to improve responsiveness, lifelike behavior, orchestration, maintenance, and security without regressions.

---

## 2) Evidence Used

### Repository evidence (direct code/test review)

- Runtime and wiring: `src/index.ts`, `src/runtime.ts`, `src/gateway.ts`
- Security and policies: `src/security.ts`, `src/tools.ts`
- Adapter: `src/model-adapter.ts`
- Scheduling/autonomy: `src/scheduler.ts`
- Memory: `src/memory.ts`
- Responsiveness: `src/responsiveness.ts`
- Spec target: `OPENCLAW_ARCHITECTURE_ANALYSIS.md`

### Validation executed

- `npm test` -> **26/26 tests passing**
- `npm run build` -> **TypeScript build passing**
- `npm run security:audit` -> **0 high vulnerabilities reported**

### OpenClaw upstream security discussion sampled

Representative merged PRs and discussion threads:

- #13184: default bind to loopback  
  <https://github.com/openclaw/openclaw/pull/13184>
- #13185: sanitize error responses (avoid internal leakage)  
  <https://github.com/openclaw/openclaw/pull/13185>
- #9518: auth bypass on canvas host endpoints  
  <https://github.com/openclaw/openclaw/pull/9518>
- #9858: config redaction, round-trip breakage discussion  
  <https://github.com/openclaw/openclaw/pull/9858>
- #1827: prompt injection mitigation limits called out in comments  
  <https://github.com/openclaw/openclaw/pull/1827>
- #15604: SSRF blocking improvements + DNS-bypass concern raised  
  <https://github.com/openclaw/openclaw/pull/15604>

---

## 3) Current-State Feature Reality Matrix

Legend:  
- **Functional** = implemented and currently used in runtime path.  
- **Partial** = implemented primitives but incomplete enforcement/wiring.  
- **Non-functional** = exists on paper or as class only; not actually active in app flow.

| Area | Intended v2 behavior | Observed state | Status |
|---|---|---|---|
| Gateway protocol/auth/rate/risk/audit IDs | Versioned RPC, auth, role checks, rate/risk gates, audit IDs | Implemented in `src/gateway.ts` and used | Functional |
| Async run/wait turn lifecycle | `agent.run` returns `runId`, `agent.wait` resolves later | Implemented and tested | Functional |
| Session ordering + queue caps + snapshots | Ordered per session, soft/hard limits, snapshots | Implemented in `SessionQueue`/`AgentRuntime` | Functional |
| Cursor-Agent CLI adapter with fallback | Streaming parser, malformed fail-closed, cancellation, fallback | Implemented and tested | Functional |
| Tool schema validation and routing | Unknown tools blocked, schema checked | Implemented in `ToolRouter` and adapter | Functional |
| Exec safety controls | Intent classifier, destructive deny, approval gates | Logic exists, but default runtime uses `AlwaysAllowApprovalGate` | Partial |
| Web fetch SSRF defense | Block private targets including redirect chain | Redirect re-check exists, but DNS pinning/rebinding hardening is incomplete | Partial |
| Memory provenance/sensitivity/session isolation | Markdown store, labeled records, secret filtering | Implemented and tested for session/secret filtering | Functional |
| Pre-compaction memory flush | Flush checkpoint before compaction | Implemented | Functional |
| Integrity scan | Contradiction/staleness checks | Implemented but not scheduled/wired | Partial |
| Heartbeat engine | Adaptive interval, budget-aware proactive turning | Class exists; not wired to a running loop | Non-functional |
| Cron execution | Add jobs and execute on schedule | Job storage works, but no production `tick` loop | Non-functional |
| Workflow runtime | Deterministic approvals + idempotency | Class exists, tested, not integrated in app orchestration | Partial |
| Responsiveness layer | Typing/presence/pacing/greeting in runtime delivery | Classes exist only (`src/responsiveness.ts`); not wired | Non-functional |
| Ingress policy enforcement | DM/group policy checks before runtime | `evaluateIngressPolicy` exists but is not used in gateway | Non-functional |
| Anomaly detection | Monitor surges/loops/suspicious fetches | `AnomalyDetector` exists but unused | Non-functional |
| Incident controls | Revoke tokens, disable proactive, isolate tools | RPC endpoint exists; effects are not enforced in runtime/tool path | Partial |
| Config-driven operation from file | OpenClaw-style config file operation | `main()` uses defaults only; no file load path | Non-functional |

---

## 4) Security Implications (Actionable)

## P0 - High impact / immediate priority

1. **Runtime defaults weaken policy intent**
   - `src/index.ts` uses `AlwaysAllowApprovalGate`.
   - High-risk exec/tool approval path is effectively auto-approved.
   - Impact: model-originated high-risk actions can execute without real operator gate.

2. **Autonomy stack is not actually running**
   - `HeartbeatRunner`, `AutonomyBudget`, and `WorkflowRuntime` are instantiated then discarded (`void ...`).
   - `CronService.tick()` is never called in production path.
   - Impact: intended autonomous behavior is absent, and budget/quiet-hour safeguards are also not active.

3. **Error details are returned to RPC clients**
   - `gateway.ts` catch block returns raw error message to client.
   - Impact: internal details leak (similar class of issue fixed in OpenClaw #13185).

4. **No external config loading despite config-first intent**
   - `loadConfig(DEFAULT_CONFIG)` in `main` means no real runtime config input source.
   - Impact: secure deployment hardening knobs cannot be reliably applied.

## P1 - Significant security and correctness risk

5. **Auth comparisons are not timing-safe**
   - `AuthService` uses string equality checks for token/password.
   - Impact: side-channel risk; OpenClaw has repeated hardening activity around token comparison.

6. **SSRF guard is not DNS-pinned and lacks full IP-form normalization**
   - DNS is resolved once before fetch; connection target is not pinned.
   - Private-IP checks miss some edge representations (for example mapped/normalized variants).
   - Impact: rebinding and hostname indirection classes remain possible (same concern raised in OpenClaw #15604 discussions).

7. **Incident controls do not enforce behavior**
   - `incident.bundle` toggles state in `IncidentCommander`, but runtime/tools do not consume that state.
   - Impact: emergency controls may appear successful but not materially change execution.

8. **Static placeholder default token**
   - Default auth token is `"changeme"`.
   - Impact: accidental insecure deployments if token rotation/setup is skipped.

## P2 - Medium risk / robustness & maintainability

9. **Global runtime handler registry**
   - `executeHandlerRegistry` is module-global in `runtime.ts`.
   - Risk: cross-instance coupling, harder lifecycle control.

10. **Unbounded in-memory logs**
    - Adapter event logs and decision logs are unbounded arrays.
    - Risk: long-run memory pressure.

11. **Responsiveness and ingress policy are dead code**
    - Behavioral and safety policy objects are not integrated.
    - Risk: spec drift, false confidence, maintenance burden.

---

## 5) OpenClaw Baseline + Discussion Takeaways to Apply

1. **Default-safe network posture must be enforced in code paths, not only docs**  
   (OpenClaw #13184, #9518)
2. **Security response surfaces should not leak implementation detail**  
   (OpenClaw #13185)
3. **Secret redaction work must include round-trip safety and not create config corruption**  
   (OpenClaw #9858 thread)
4. **Prompt-injection controls should be layered and explicit about limitations**  
   (OpenClaw #1827 comments)
5. **SSRF defense needs DNS-aware and redirect-aware enforcement end-to-end**  
   (OpenClaw #15604 review comments)

---

## 6) Step-by-Step Fix Plan (Implementation Spec)

## Workstream A - Secure defaults and real configuration loading

### Steps

1. Add real config source loading (`openclaw.json` or env-configured path), then merge with defaults.
2. Fail startup if auth token/password is unset, placeholder, or literal `"undefined"` / `"null"`.
3. Replace `AlwaysAllowApprovalGate` in production wiring with policy-based gate.
4. Add explicit dev mode flag if permissive approval behavior is needed for tests.

### Implementation criteria

- [ ] `main()` reads external config source before boot.
- [ ] Placeholder tokens are rejected at startup.
- [ ] Production boot path no longer uses always-allow approvals.
- [ ] Unit tests cover secure config rejection and dev override path.

### Guardrails

- [ ] Regression test: insecure default token refuses startup.
- [ ] Regression test: prod mode denies unapproved high-risk exec.
- [ ] Regression test: existing unit suites still pass with strict mode on.

---

## Workstream B - Gateway hardening and safer auth

### Steps

1. Replace raw string compare with timing-safe token/password compare.
2. Normalize and sanitize all internal errors returned from `/rpc`.
3. Introduce typed error categories (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `INTERNAL`) instead of reusing tool policy codes for all failures.
4. Add request body size and message size caps.

### Implementation criteria

- [ ] Timing-safe compare is used for auth secrets.
- [ ] Client-facing 500 messages are generic; detailed errors remain server-side logs only.
- [ ] Error code mapping is stable and semantically correct.
- [ ] Payload size limits reject oversized requests predictably.

### Guardrails

- [ ] Test mirrors OpenClaw #13185 class: no stack/path details in response body.
- [ ] Negative tests for malformed/oversized RPC envelopes.

---

## Workstream C - Tool policy enforcement and incident controls

### Steps

1. Implement `PolicyApprovalGate` with explicit allow/deny reason codes.
2. Enforce `IncidentCommander` flags in tool execution:
   - block proactive sends when incident mode is active,
   - isolate or deny high-risk tools when tool isolation is active.
3. Add command allowlist profiles by environment (strict default).

### Implementation criteria

- [ ] Approval decisions are policy-driven and logged with reason codes.
- [ ] Incident mode materially changes runtime/tool behavior.
- [ ] `exec` defaults are strict and documented.

### Guardrails

- [ ] Test: `incident.bundle` followed by high-risk tool call is denied.
- [ ] Test: approval-required path cannot be bypassed by default.

---

## Workstream D - SSRF/network egress hardening

### Steps

1. Upgrade URL safety check to resolve all A/AAAA addresses and block any private/local/meta range.
2. Add DNS pinning strategy per request chain; revalidate each redirect target and resolved endpoint.
3. Normalize IP forms (including mapped IPv6 and equivalent local forms).
4. Add response byte cap and content-type constraints for `web_fetch`.

### Implementation criteria

- [ ] Private/local/meta addresses blocked for direct and indirect hostnames.
- [ ] Redirect chain validation enforces same policy on each hop.
- [ ] Unit/integration tests include rebinding-style and mapped-address cases.

### Guardrails

- [ ] Keep existing redirect revalidation test passing.
- [ ] Add tests matching OpenClaw #15604 review concern (hostname -> private resolve).

---

## Workstream E - Orchestration wiring (autonomy becomes real)

### Steps

1. Add scheduler loop service that periodically calls `CronService.tick(...)`.
2. Wire heartbeat runner to main session with autonomy budget and quiet-hours policy.
3. Connect workflow runtime to a dispatch path for deterministic multi-step tasks.
4. Add graceful startup/shutdown around scheduler and in-flight turn handling.

### Implementation criteria

- [ ] Cron jobs added through RPC are actually executed over time.
- [ ] Heartbeat runs only when enabled and budget allows.
- [ ] Workflow runtime is reachable from orchestrator path.
- [ ] Shutdown flushes scheduler/checkpoint state.

### Guardrails

- [ ] Integration test: `cron.add` leads to execution without manual `tick`.
- [ ] Integration test: quiet hours and budget suppress proactive runs.

---

## Workstream F - Responsiveness and lifelike behavior integration

### Steps

1. Integrate `TypingPolicy`, `PresenceManager`, `DeliveryPacer`, and `GreetingPolicy` into message delivery lifecycle.
2. Add anti-spam pacing guard (min inter-message interval) with urgent override.
3. Ensure no fabricated human identity/presence claims are generated.

### Implementation criteria

- [ ] Typing/presence events are emitted according to policy mode.
- [ ] Pacing prevents burst spam in normal mode.
- [ ] Greeting behavior is thread-aware and cooldown-bound.

### Guardrails

- [ ] Behavior tests for `never/instant/thinking/message` typing modes.
- [ ] Regression tests for no double-send under pacing rules.

---

## Workstream G - Memory safety and context quality

### Steps

1. Add scheduled `integrityScan()` execution with reporting.
2. Wire memory retrieval into prompt assembly with sensitivity-aware filtering.
3. Add configurable policy for secret memory inclusion (default deny in prompts).

### Implementation criteria

- [ ] Integrity findings are generated and observable.
- [ ] Session boundaries are preserved during retrieval.
- [ ] Secret records are excluded from prompt context by default.

### Guardrails

- [ ] Cross-session leak tests.
- [ ] Prompt construction tests confirm secret suppression.

---

## Workstream H - Maintainability and reliability improvements

### Steps

1. Move module-global run handler registry to runtime instance-owned state.
2. Bound in-memory logs and add structured rotating sink.
3. Cache AJV validators by tool name/schema hash to avoid compile-per-call overhead.
4. Add metrics counters/histograms for queue depth, tool decisions, adapter timeouts.

### Implementation criteria

- [ ] Runtime lifecycle state is instance-local.
- [ ] Log growth is bounded and policy-controlled.
- [ ] Validator cache exists and is benchmarked.
- [ ] Core SLO metrics are emitted.

### Guardrails

- [ ] Stress test for long-running process memory stability.
- [ ] Benchmark check for tool-call throughput regression.

---

## 7) Regression Gate Checklist (must stay green)

- [ ] Existing `npm test` suite remains passing.
- [ ] Existing `npm run build` remains passing.
- [ ] Security tests include:
  - [ ] auth token timing-safe behavior,
  - [ ] RPC error sanitization,
  - [ ] high-risk tool approval enforcement,
  - [ ] DNS/redirect SSRF bypass attempts,
  - [ ] incident mode enforcement,
  - [ ] heartbeat/cron orchestration integration.
- [ ] No feature regression in async `agent.run` / `agent.wait`.
- [ ] No cross-session memory leakage.

---

## 8) Practical Delivery Order

Recommended order to minimize risk:

1. Workstream A + B (secure startup and gateway hardening)
2. Workstream C + D (tool/egress controls)
3. Workstream E (real orchestration wiring)
4. Workstream F + G (behavior and memory quality)
5. Workstream H (maintenance and performance hardening)

---

## 9) Final Assessment Snapshot

- The project has a solid **foundation layer** (typed contracts, runtime queueing, adapter abstraction, policy primitives, and tests).
- The largest gap is **integration depth**: several v2 capabilities are present as classes but not active in production orchestration.
- Security posture is **better than minimal baseline**, but key deployment-path hardening is still required before calling it fully security-first in operation.

