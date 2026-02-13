# CursorClaw Autonomous Living Assistant
## Deep Codebase Analysis and Completion Specification

**Date:** 2026-02-13  
**Branch analyzed:** `cursor/agent-design-specification-dd46`  
**Status:** Design-completion specification (implementation-ready)

---

## 1) Target Outcome (as requested)

Build CursorClaw into a **high-quality autonomous living assistant** that is:

1. **Natively integrated with Cursor-Agent CLI** (primary model path).
2. **Persistent like OpenClaw** (state, memory, jobs, and behavior continuity across restarts).
3. **At least OpenClaw-parity functional** (persistent learning agent, multi-endpoint access, secure tooling/autonomy controls).
4. **Highly secure by default**, including robust guardrails against prompt injection and unsafe tool execution.

---

## 2) Evidence and Methodology

### 2.1 Source reviewed in detail

- Runtime and control plane:
  - `src/index.ts`
  - `src/gateway.ts`
  - `src/runtime.ts`
  - `src/orchestrator.ts`
  - `src/scheduler.ts`
- Model integration:
  - `src/model-adapter.ts`
  - `docs/cursor-agent-adapter.md`
- Security and tools:
  - `src/security.ts`
  - `src/tools.ts`
  - `src/config.ts`
- Memory and behavior:
  - `src/memory.ts`
  - `src/responsiveness.ts`
- Type contracts:
  - `src/types.ts`
- Existing design/audit docs:
  - `OPENCLAW_ARCHITECTURE_ANALYSIS.md`
  - `IMPLEMENTATION_V2_REALITY_AUDIT_SPEC.md`
  - `IMPLEMENTATION_V2_AUDIT_SPEC.md`

### 2.2 Verification runs executed

- `npm test` -> **57/57 tests passing**
- `npm run build` -> **TypeScript build passing**
- `npm run security:audit` -> **0 high vulnerabilities**

This spec is grounded in code + tests, not only intent documents.

---

## 3) Current System Reality: Detailed Findings

## 3.1 Control plane and RPC gateway (`src/gateway.ts`)

### What is strong now

- Protocol version enforcement and typed envelope handling.
- Auth, method scopes, rate limiting, and risk scoring before method execution.
- Async run lifecycle (`agent.run` returns `runId`, `agent.wait` blocks/returns result).
- Incident endpoint exists (`incident.bundle`) and affects proactive sends/tool isolation.
- `/health` and `/status` endpoints expose core runtime and incident state.
- Internal errors are sanitized for client responses.

### Gaps vs living-assistant/OpenClaw parity

- HTTP RPC only; no production-grade WebSocket stream channel.
- No real channel adapters (Slack/Discord/Telegram/WhatsApp/SMS/email) behind `chat.send`.
- `chat.send` is currently synthetic (returns payload rather than actually delivering).
- No ingress policy wiring for DM/group mention allowlist decisions in gateway path.
- Risk model is simple regex + counters, not adaptive/actor-aware over time.

---

## 3.2 Runtime/session execution (`src/runtime.ts`)

### What is strong now

- Per-session queueing with soft/hard limits and drop/defer strategies.
- Ordered turn execution and event lifecycle (`queued`, `started`, `tool`, `assistant`, `completed`, etc.).
- Snapshot persistence of turn events to disk.
- Prompt memory preloading by session with secret filtering.
- Metrics for starts/completions/failures/tool calls.

### Gaps vs OpenClaw parity

- Queue state is in-memory only (not durable); restart loses pending turns.
- No compaction quality validation pipeline (simple size-based trigger only).
- No transcript/token budget manager beyond max message count/char limits.
- No streaming lifecycle fan-out to external subscribers/clients.
- Session/model handle persistence is in-memory only.

---

## 3.3 Cursor-Agent adapter (`src/model-adapter.ts`)

### What is strong now

- Native subprocess model adapter contract implemented.
- NDJSON + sentinel-framed parsing support.
- Fail-closed malformed frame behavior.
- Tool call validation against tool schemas.
- Timeout watchdog + staged termination + cancellation.
- Fallback chain across models/auth profiles.

### Gaps to close

- No contract version negotiation with CLI output schema.
- No robust stderr taxonomy (auth/transport/model/process categories are regex-based).
- No adapter-level telemetry export endpoint (only in-memory counters).
- No replay/recovery for interrupted stream events.
- No multi-tenant/session-level resource isolation limits per adapter process.

---

## 3.4 Tooling and execution policy (`src/tools.ts`)

### What is strong now

- Typed tool registry and AJV schema validation.
- Approval-gate abstraction with strict policy gate available.
- Destructive command detection and default-deny behavior.
- Intent classification (read-only, mutating, network-impacting, privilege-impacting).
- SSRF guard with redirect revalidation, content-type restrictions, body-size caps.
- DNS rebinding detection across redirect chain.

### Gaps to close for production safety

- `exec` still executes host binaries directly (`execFile`) without true OS sandbox/container boundary.
- No mandatory per-tool runtime budget (CPU/memory/wall clock) beyond basic timeout.
- No egress allowlist policy for domains (only private-range denial).
- No signed/attested tool package mechanism for "learned skills".
- No mandatory human approval path for specific irreversible operations by policy class.

---

## 3.5 Security stack (`src/security.ts`, `src/config.ts`)

### What is strong now

- Timing-safe secret comparison for auth.
- Config startup validation for placeholder/nullish secrets.
- Policy decision logging with bounded size.
- Incident commander supports proactive disable + tool isolation + token hash revocation log.
- Untrusted content wrapping helper exists.
- Rate limiter and inbound risk scoring implemented.

### Gaps to close (critical for "highly secure" target)

- Revoked token hashes are not enforced in auth path (recorded only).
- No signed identity/session binding for downstream adapters.
- No policy-as-code engine (OPA/Cedar-style) for explainable access/tool decisions.
- No mandatory content provenance tags throughout prompt assembly pipeline.
- Prompt injection defenses are mostly wrapper-based; no multi-stage adversarial filtering stack.
- No secure secret store integration (KMS/Vault/OS keychain).

---

## 3.6 Scheduler/autonomy/orchestration (`src/scheduler.ts`, `src/orchestrator.ts`)

### What is strong now

- Heartbeat interval adaptation and autonomy budget object.
- Cron service with retries/backoff/concurrency and persisted state file.
- Workflow runtime with idempotency key + step approvals + persistent workflow state.
- Orchestrator loop wiring for cron/heartbeat/integrity scan.
- Graceful stop persists cron state.

### Gaps vs "persistent living assistant"

- No persisted autonomy planner state/history (initiative memory and social context memory are missing).
- Heartbeat unread-event input is not yet connected to real message backlog signals.
- No real endpoint-driven proactive messaging dispatch.
- No cross-channel "presence brain" (availability, interruption budget, social timing heuristics).
- No job lease/claim model for distributed/HA runtime.

---

## 3.7 Memory and learning (`src/memory.ts`)

### What is strong now

- Durable markdown memory (`MEMORY.md` + daily files).
- Provenance + sensitivity labels on records.
- Secret filtering by default in prompt retrieval.
- Integrity scan detects contradiction/staleness patterns.

### Major parity gaps

- No vector/semantic retrieval or hybrid memory ranking.
- No explicit long-term user model with confidence decay and conflict resolution.
- No "learn new skills" pipeline (detect repetitive tasks -> propose skill -> validate -> persist).
- No versioned memory schema/migrations.
- No data retention/privacy purge tooling for endpoint-specific compliance.

---

## 3.8 Responsiveness/lifelike behavior (`src/responsiveness.ts`)

### What is strong now

- Typing policy modes.
- Presence manager with TTL.
- Delivery pacing and greeting cooldown logic.
- Behavior engine integrated in gateway `chat.send` path.

### Gaps

- Not connected to real messaging adapters and thread APIs.
- No persona/time-zone/user-context adaptive behavior model.
- No anti-annoyance policy tied to user-level preferences and recent sentiment.
- No persistent social memory (e.g., preferred communication style, interruption tolerances).

---

## 3.9 Test and CI posture

### Strong coverage areas

- Adapter parsing/cancel/fallback behavior.
- Security guards (auth, SSRF, approvals, destructive commands).
- Runtime/scheduler/orchestrator integration.
- Responsiveness policy logic.
- Config startup security checks.

### Coverage gaps to close

- No endpoint adapter contract tests (Slack/Discord/Telegram/etc).
- No chaos/restart tests for in-flight runtime queue persistence.
- No red-team prompt injection corpus integrated in CI.
- No long-horizon memory growth and compaction quality benchmarks.
- No end-to-end "persistent learning of new skill" acceptance test.

---

## 4) OpenClaw Parity Gap Matrix

| Capability area | Current status | Parity rating | Required delta |
|---|---|---|---|
| Cursor-Agent native path | Implemented | Near parity | Add contract versioning + stronger process telemetry |
| Session ordering | Implemented | Parity | Add durable queue state across restarts |
| Async run/wait lifecycle | Implemented | Parity | Add stream subscriptions and resumable wait |
| Gateway auth/rate/risk | Implemented | Partial parity | Add revocation enforcement + policy engine |
| Prompt injection defense | Partial | Below parity target | Multi-layer content trust + adversarial filtering + action gating |
| SSRF/web safety | Implemented | Partial parity | Add domain allowlist and egress policy governance |
| Exec safety | Implemented | Partial parity | True sandbox isolation + per-command capability model |
| Heartbeat/cron/workflow | Implemented | Partial parity | Persist planner context and real proactive messaging delivery |
| Persistent memory | Implemented | Partial parity | Add semantic retrieval, confidence decay, memory compaction QA |
| Skill learning | Missing | Not at parity | Add skill lifecycle engine and secure skill registry |
| Multi-endpoint messaging | Missing | Not at parity | Add adapter framework + connectors + unified channel model |
| Incident response | Partial | Partial parity | Enforce revoked tokens, emergency kill-switch coverage |
| Observability/SLO | Partial | Below parity target | Add metrics/tracing, SLO alerts, replayable audit logs |
| Deployment hardening | Partial | Below parity target | Secret store, hardened run modes, backup/restore drills |

---

## 5) Priority Gap Summary (What must change first)

## P0 (immediate)

1. **Multi-endpoint framework + first messaging adapters** (without this, not a living assistant).
2. **Durable runtime state** (pending turns/session handles/initiative state survive restart).
3. **Prompt-injection and action-safety hardening** (beyond wrappers).
4. **Skill learning lifecycle implementation** with secure approval/sandbox pipeline.
5. **Revoked token enforcement** in authentication path.

## P1 (near-term)

6. Semantic memory retrieval + confidence-based memory lifecycle.
7. Real proactive messaging + per-user/channel autonomy governance.
8. Full observability and SLO enforcement.

## P2 (medium-term)

9. Distributed runtime primitives and HA scheduler.
10. Advanced social behavior tuning and adaptive cadence models.

---

## 6) Target Architecture to Reach Requested Outcome

```text
Inbound Endpoints (Slack, Discord, Telegram, SMS, Web, Mobile, CLI)
    -> Channel Adapter Layer (normalized events, auth, replay IDs)
    -> Gateway Control Plane (RPC + WS + policy-as-code + audit)
    -> Runtime Core (session queue, planner, prompt builder, tool router)
    -> Model Adapter Layer (Cursor-Agent primary, governed fallback chain)
    -> Tooling Layer (sandboxed exec, web fetch, endpoint actions, skill tools)
    -> Memory + Skill Stores (markdown + DB + vector index + skill registry)
    -> Observability Plane (metrics, traces, audit logs, anomaly detectors)
```

---

## 7) Implementation Workstreams (Step-by-step)

## Workstream A - Durable State and Persistence Backbone

### Steps

1. Introduce a persistent state store (SQLite/Postgres) for:
   - sessions,
   - pending runs,
   - run lifecycle events,
   - adapter session handles,
   - autonomy planner state.
2. Migrate `pendingRuns` from in-memory map to durable table.
3. Add runtime crash-recovery on startup:
   - resume `agent.wait` from persisted completed runs,
   - mark interrupted runs with explicit terminal reason.
4. Persist delivery pacing/greeting/presence state for continuity after restart.
5. Add schema migrations and startup migration checks.

### Success criteria

- [ ] Restart does not lose pending/finished run visibility.
- [ ] `agent.wait` returns durable results after process restart.
- [ ] Session ordering remains deterministic after recovery.
- [ ] No data corruption across migration versions.

### Guardrails (must remain green)

- [ ] Existing runtime integration tests remain passing.
- [ ] New restart-recovery integration tests pass.
- [ ] Load test: 10k turns with restart mid-run shows zero orphaned "running" states.

---

## Workstream B - Channel Endpoint Framework and Messaging Connectors

### Steps

1. Define `ChannelAdapter` interface:
   - `connect()`, `disconnect()`, `send()`, `ack()`, `normalizeIncoming()`.
2. Implement adapter host service with backoff/retry and dead-letter queue.
3. Build initial production connectors:
   - Slack,
   - Discord,
   - Telegram.
4. Convert `chat.send` from synthetic response to actual adapter dispatch.
5. Add webhook signature verification and replay protection per platform.

### Success criteria

- [ ] Agent receives and replies across at least 3 external messaging endpoints.
- [ ] Message IDs and delivery states are persisted and queryable.
- [ ] Duplicate webhook events are idempotently ignored.
- [ ] Per-endpoint auth and secrets are isolated.

### Guardrails

- [ ] Contract tests for each adapter (ingress normalization + outbound formatting).
- [ ] Replay-attack and invalid-signature tests.
- [ ] Delivery retries do not duplicate user-visible sends.

---

## Workstream C - Persistent Learning and Memory Intelligence

### Steps

1. Add semantic memory index (vector + metadata filtering by session/sensitivity).
2. Introduce memory confidence decay and contradiction resolution model.
3. Split memory tiers:
   - episodic (recent interactions),
   - semantic (stable facts),
   - procedural (learned skills/workflows).
4. Add memory governance jobs:
   - compaction QA,
   - stale fact verification,
   - privacy purge workflows.
5. Surface memory provenance + confidence in prompt assembly and operator UI.

### Success criteria

- [ ] Retrieval quality improves on benchmarked multi-turn tasks.
- [ ] No cross-session leakage in retrieval.
- [ ] Secret/regulated records remain excluded by default.
- [ ] Memory drift/contradiction alerts are generated and actionable.

### Guardrails

- [ ] Existing memory tests remain passing.
- [ ] New retrieval accuracy suite (golden Q/A corpus) passes target threshold.
- [ ] Red-team tests confirm secret suppression in prompts/logs.

---

## Workstream D - Skill Learning Engine (OpenClaw parity + beyond)

### Steps

1. Add `SkillRegistry` with signed skill manifests and versioning.
2. Add skill proposal pipeline:
   - detect repeated user requests,
   - synthesize candidate workflow/tool composition,
   - generate test plan.
3. Add secure validation pipeline:
   - sandbox execution,
   - policy lint checks,
   - canary runs.
4. Add approval flow:
   - manual approval for high-risk skills,
   - auto-approve only low-risk deterministic skills with proven tests.
5. Persist skill performance metrics and rollback metadata.

### Success criteria

- [ ] Agent can learn and reuse at least one new skill from interaction history.
- [ ] Learned skills have tests and policy metadata before activation.
- [ ] Failing/newly risky skills can be rolled back instantly.
- [ ] Skill execution is auditable (who approved, when, why).

### Guardrails

- [ ] No unsigned skill can execute.
- [ ] No high-risk skill auto-activation without explicit approval.
- [ ] Regression suite verifies legacy tools still function with skill framework enabled.

---

## Workstream E - Security Hardening and Prompt Injection Defense-in-Depth

### Steps

1. Enforce token revocation in `AuthService` against `IncidentCommander` revocation store.
2. Add policy-as-code decision engine for:
   - ingress permissions,
   - tool permissions,
   - autonomy actions,
   - endpoint send controls.
3. Build layered prompt-injection defense:
   - trust-label all content segments,
   - isolate untrusted content in strict sections,
   - pre-tool action risk evaluator,
   - require confirmation for sensitive actions from untrusted context.
4. Add domain allowlist + egress classes for fetch/network tools.
5. Integrate secret manager (Vault/KMS/keychain), remove plaintext secret reliance.
6. Add continuous red-team suite in CI with known injection corpora.

### Success criteria

- [ ] Revoked tokens are immediately denied across all endpoints.
- [ ] Sensitive actions from untrusted content require policy/approval gate.
- [ ] Prompt injection corpus pass rate meets defined threshold.
- [ ] Security decisions include stable reason codes and audit IDs.

### Guardrails

- [ ] Existing `tests/security-tools.test.ts` remains passing.
- [ ] New prompt-injection E2E suite is mandatory in CI.
- [ ] Any SSRF/exec safety regression blocks release.

---

## Workstream F - Autonomy and "Living Assistant" Behavior

### Steps

1. Introduce persistent autonomy planner:
   - goals,
   - reminders,
   - pending commitments,
   - social cadence context.
2. Connect heartbeat cadence to real unread/backlog and urgency signals.
3. Add per-user autonomy budgets and interruption policies (not channel-only).
4. Add real proactive sends through channel adapters with quiet hours and fatigue protection.
5. Add "do-not-disturb" and emergency pause controls per endpoint.

### Success criteria

- [ ] Agent can proactively follow up without spamming.
- [ ] Budgets/quiet hours are honored per user + channel + endpoint.
- [ ] Presence/typing behavior works on real endpoint APIs.
- [ ] Behavioral continuity persists across restarts.

### Guardrails

- [ ] Anti-spam tests prevent burst messaging regressions.
- [ ] Quiet-hour and emergency-stop tests are release blockers.
- [ ] No fabricated identity/human claims in proactive messaging templates.

---

## Workstream G - Reliability, Observability, and Operations

### Steps

1. Add structured logs with retention controls and PII redaction.
2. Export Prometheus/OpenTelemetry metrics for:
   - latency,
   - queue depth,
   - scheduler health,
   - tool allow/deny,
   - injection detections.
3. Add health endpoints for adapter/channel/scheduler status and lag.
4. Add backup/restore and disaster recovery runbooks.
5. Add chaos tests for process kill, adapter crashes, endpoint outages.

### Success criteria

- [ ] SLO dashboard exists and is accurate.
- [ ] Runbooks validated by recovery drills.
- [ ] Crash recovery preserves critical state.
- [ ] Alerting catches scheduler stall and adapter failure quickly.

### Guardrails

- [ ] Existing CI gates remain mandatory (`test`, `build`, `security:audit`).
- [ ] New chaos suite required pre-release.
- [ ] Memory/CPU guardrail benchmarks prevent silent performance regressions.

---

## Workstream H - OpenClaw Parity Certification

### Steps

1. Define explicit parity checklist by subsystem.
2. Build parity acceptance tests mapped 1:1 to checklist items.
3. Perform gap closure sprint until all parity blockers are closed.
4. Publish parity report with residual differences and rationale.

### Success criteria

- [ ] All mandatory OpenClaw-equivalent capabilities are demonstrably present.
- [ ] Residual non-parity items are documented as explicit deferments.
- [ ] No critical security deferments remain open.

### Guardrails

- [ ] Parity checklist must be versioned and signed off.
- [ ] Any removal of previously certified capability requires RFC + migration plan.

---

## 8) Regression Prevention Framework (release blocking guardrails)

Release must be blocked unless all items below are true:

- [ ] All existing tests remain passing.
- [ ] New endpoint adapter contract tests pass.
- [ ] Restart-recovery tests pass for runtime + scheduler + workflows.
- [ ] Prompt injection red-team suite passes threshold.
- [ ] SSRF/exec/approval security suites pass.
- [ ] Memory leakage and secret-suppression tests pass.
- [ ] Throughput and latency guardrail tests meet baseline.
- [ ] No unbounded in-memory growth in 24h soak test.
- [ ] Incident mode actually blocks high-risk operations and proactive sends.
- [ ] Revoked tokens are denied in real-time.

---

## 9) Suggested Delivery Sequence (low-risk path)

1. Workstream A + E (durability and security enforcement first).  
2. Workstream B (real endpoints), then F (living behavior on real channels).  
3. Workstream C + D (persistent learning and skill lifecycle).  
4. Workstream G + H (operations hardening and parity certification).

This order minimizes the risk of building user-visible autonomy on top of insecure or non-durable foundations.

---

## 10) Immediate Next Iteration Backlog (actionable first sprint)

- [x] Implement durable run store and `agent.wait` recovery after restart.
- [x] Enforce revoked-token checks in auth path.
- [x] Add `ChannelAdapter` interface and Slack connector skeleton.
- [x] Replace synthetic `chat.send` with adapter dispatch abstraction.
- [x] Add prompt-injection red-team fixture set and CI job.
- [x] Add persistent autonomy state table (budgets + pending proactive intents).

---

## 11) Final Assessment

Current CursorClaw is a strong **security-first agent runtime foundation** with native Cursor-Agent integration and substantial tests.  
It is **not yet full OpenClaw-equivalent as a persistent, multi-endpoint, self-learning living assistant**.

The highest-value path is:

1. make state and auth controls fully enforceable and durable,  
2. add real endpoint adapters,  
3. implement persistent learning/skill lifecycle,  
4. harden prompt-injection defenses with policy-driven action gating,  
5. certify parity with explicit release-blocking guardrails.

