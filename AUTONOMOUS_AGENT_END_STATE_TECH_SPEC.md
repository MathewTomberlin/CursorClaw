# CursorClaw End-State Technical Specification
## Autonomous, Secure, OpenClaw-Parity+ Engineering and General Assistant

**Date:** 2026-02-14  
**Branch:** `cursor/agent-project-tech-spec-940d`  
**Status:** Implementation roadmap (codebase-grounded)  
**Audience:** Core runtime maintainers, platform/security engineers, autonomy/AI engineers, UI/integration engineers

---

## 1) Mission and End-State Definition

The target end state is:

1. A highly-intelligent, resilient autonomous agent that can execute complex software-engineering tasks end-to-end.
2. A generalized assistant with lifelike communication behavior and continuity.
3. A secure on-device intelligence runtime accessible remotely via messaging channels and a web UI.
4. A platform that includes OpenClaw-class features while being stricter and safer by default.

This specification provides:

- A deep current-state audit based on `src/` and `tests/`.
- A gap map from current implementation to the desired end state.
- A phase-based implementation plan with step-by-step tasks.
- A success checklist per phase.
- Regression guardrails to prevent security regressions and broken behavior.

---

## 2) Current-State Deep Analysis (Codebase Reality)

## 2.1 Repository Composition and Runtime Surface

Current repository shape:

- Runtime: TypeScript (`Node >=22`, ESM).
- Core dependencies: `fastify`, `ajv`, `cron-parser`, `ws`.
- Source modules: gateway, runtime, security, tools, scheduler, context indexing/retrieval, MCP, reflection, reliability, privacy.
- Test suite: 24 test files spanning integration-heavy runtime/gateway/security/orchestration behavior and unit guardrails.

Primary startup wiring is centralized in `src/index.ts`, where all subsystems are assembled.

---

## 2.2 Gateway and RPC Control Plane (`src/gateway.ts`)

### Implemented now

- HTTP endpoints: `/health`, `/status`, `/rpc`.
- Strict RPC envelope and protocol version enforcement.
- Auth + role scope enforcement via `AuthService`.
- Method-level rate limiting (`MethodRateLimiter`).
- Inbound risk scoring (`scoreInboundRisk`), hard block at high score.
- Async run lifecycle:
  - `agent.run` starts queued runtime turn and returns `runId`.
  - `agent.wait` resolves or fails with consumptive semantics.
- Admin/control methods:
  - `cron.add`, `incident.bundle`, `approval.list`, `approval.resolve`, `approval.capabilities`.
- Workspace and advisor methods:
  - `advisor.file_change`, `workspace.status`, `workspace.semantic_search`, `trace.ingest`, `advisor.explain_function`.

### Key strengths

- Good method coverage for both operations and advisory behavior.
- Strong baseline request gate ordering (protocol -> auth -> role -> rate -> risk).
- Error sanitization for unexpected internal errors (`INTERNAL`, generic message).

### Gaps versus desired end state

- No inbound event transport for messaging platforms (only RPC invocation).
- No WebSocket/SSE run stream for live lifecycle subscriptions.
- No durable request/reply audit persistence (policy logs are in-memory).
- Risk scoring is heuristic and static, not actor-adaptive over time.

---

## 2.3 Security Model (`src/security.ts`, `src/config.ts`, `src/tools.ts`)

### Implemented now

- Auth modes: token/password/none with role mapping.
- Timing-safe secret compare for token/password.
- Trusted proxy + trusted identity header support.
- Token revocation checks wired through `IncidentCommander`.
- Policy decision logger with bounded retention.
- SSRF guard:
  - protocol restrictions,
  - DNS resolution checks,
  - private IP denial (IPv4 + mapped IPv6 handling),
  - redirect revalidation,
  - DNS rebinding detection in `web_fetch`.
- Startup hardening:
  - reject `changeme`,
  - reject literal `"undefined"` / `"null"` credentials (non-dev mode).
- Incident controls:
  - revoke token hashes,
  - disable proactive sends,
  - isolate high-risk tools.

### Tool security specifics

- `ToolRouter` schema validation for all tool calls (AJV).
- Unknown tool and invalid schema denies.
- `exec` intent classification (`read-only`, `mutating`, `network-impacting`, `privilege-impacting`).
- Destructive command signatures denied by default.
- Capability approval gate support (explicit grant workflow).

### Key strengths

- Defense-in-depth layers are already present and tested.
- SSRF handling is significantly stronger than typical baseline implementations.
- Approval/capability primitives are implemented, not just planned.

### Gaps versus desired end state

- `exec` is still direct host process execution (not containerized micro-sandbox by default).
- No policy-as-code engine (OPA/Cedar-like externalized policy evaluation).
- No persistent signed audit ledger for high-risk approvals/executions.
- No egress domain allowlist policy tier for production hardening beyond private range blocking.

---

## 2.4 Runtime Execution Core (`src/runtime.ts`)

### Implemented now

- Per-session queued execution with soft/hard queue caps and drop strategy.
- Full turn lifecycle events (`queued`, `started`, `assistant`, `tool`, `compaction`, `completed`, `failed`).
- Prompt assembly includes:
  - freshness trimming and contradiction annotation,
  - failure-loop escalation hints,
  - reasoning reset deep-scan summaries,
  - recent decision journal lines,
  - plugin-generated context.
- Privacy scrubber integration for prompt/tool/assistant outputs.
- Reliability controls:
  - failure-loop tracking,
  - reasoning reset,
  - deep scan,
  - confidence scoring with human hint gating,
  - optional git checkpoint + rollback around risky operations.
- Snapshot persistence to `tmp/snapshots`.

### Key strengths

- Runtime architecture is robust and explicit.
- Reliability mechanisms are already integrated into turn flow (not sidecar-only).
- Structured telemetry exists (`getMetrics`, decision logs, observations).

### Gaps versus desired end state

- No persistent session queue replay on process restart.
- No multi-step planning graph per turn (planner-executor-critic is implicit, not explicit).
- No deterministic "plan artifact" persistence with formal verification requirements.
- No native streaming output API to remote clients (gateway uses poll via `agent.wait`).

---

## 2.5 Model Adapter (`src/model-adapter.ts`)

### Implemented now

- Supports Cursor-Agent CLI subprocess streaming (NDJSON + framed fallback).
- Strict event type validation and tool-call schema validation.
- Timeout watchdog and staged terminate (`cancel`, `SIGTERM`, `SIGKILL`).
- Fallback chain across models and auth profiles.
- Adapter metrics (timeouts/crashes/fallback attempts).
- Redacted bounded event logs.

### Key strengths

- Adapter is production-shaped and hardened for malformed/missing-stream behavior.
- Good recoverability path with fallback chain.

### Gaps versus desired end state

- No adapter protocol version negotiation handshake with external CLI.
- No long-lived model session pooling/resource budgeting across many concurrent users.
- No persistent adapter diagnostics export endpoint.

---

## 2.6 Context, Workspace Intelligence, and Retrieval

Files:

- `src/context/summary-cache.ts`
- `src/context/embedding-index.ts`
- `src/context/retriever.ts`
- `src/context/context-index-service.ts`
- `src/workspaces/catalog.ts`
- `src/workspaces/multi-root-indexer.ts`
- `src/workspaces/cross-repo-graph.ts`
- `src/network/trace-collector.ts`
- `src/network/trace-linker.ts`

### Implemented now

- Multi-root workspace catalog and health checks.
- Recursive indexer with extension/size/ignored-directory controls.
- Semantic summary cache with content-hash invalidation.
- Local embedding index and cosine retrieval.
- Semantic retrieval collector plugin with module ranking and cross-repo suspect hints.
- Cross-repo graph built from import/http call signals.
- Optional network trace ingestion and route-to-module linking.

### Key strengths

- Solid local semantic retrieval pipeline already exists.
- Cross-repo awareness exists in first iteration (not single-root only).
- Trace ingestion provides runtime evidence linking for debugging.

### Gaps versus desired end state

- Graph confidence is heuristic; no probabilistic/learning-based edge scoring.
- Indexing is full refresh based cadence, not robust incremental file watcher pipeline.
- No AST/semantic parser abstraction by language for high-precision symbol intelligence.

---

## 2.7 Autonomy, Scheduler, Workflow, and Proactive Behavior

Files:

- `src/scheduler.ts`
- `src/orchestrator.ts`
- `src/autonomy-state.ts`
- `src/proactive-suggestions.ts`

### Implemented now

- Cron scheduler with retries/backoff/persisted state.
- Heartbeat runner with adaptive interval and budget checks.
- Workflow runtime with deterministic idempotent step progression + approvals.
- Orchestrator ties cron, heartbeat, integrity scan, and proactive intent dispatch.
- Autonomy state persistence includes budget windows and proactive intent queue.

### Key strengths

- Genuine autonomy substrate exists and is wired.
- Budget controls and quiet-hour semantics are implemented.

### Gaps versus desired end state

- No long-horizon goal planner (daily/weekly objective graph).
- No user-level personalization/autonomy governance model beyond channel budgets.
- No durable "intent rationale history" for why proactive actions were chosen.

---

## 2.8 Lifelike Communication and Channels

Files:

- `src/channels.ts`
- `src/responsiveness.ts`

### Implemented now

- Channel adapter abstraction (`ChannelHub`).
- Deterministic local adapter and Slack skeleton adapter.
- Behavior policy engine:
  - typing policy,
  - presence tracking,
  - delivery pacing,
  - greeting cooldown.

### Key strengths

- Communication behavior abstraction is present and test-covered.
- Pacing/greeting controls help prevent robotic or spammy behavior.

### Gaps versus desired end state

- Slack adapter is skeleton only; no real API integration path.
- No Discord/Telegram/WhatsApp/SMS/email adapters.
- No web UI backend/frontend currently present in repository.
- No persistent social preference model.

---

## 2.9 Privacy and Secret Handling

Files:

- `src/privacy/secret-scanner.ts`
- `src/privacy/privacy-scrubber.ts`

### Implemented now

- Multi-detector secret scanner (assignment, GH tokens, AWS key IDs, JWT, PEM blocks, entropy token).
- Scoped deterministic placeholders.
- Recursive scrubbing for nested structures.
- Runtime integration scrubs prompt egress and tool/assistant artifacts.

### Key strengths

- One of the strongest implemented subsystems.
- Test coverage includes breadth and performance baselines.

### Gaps versus desired end state

- No external DLP provider integration (optional enterprise mode).
- No cryptographic audit attestations for scrub decisions.

---

## 2.10 Reflection, Reliability, and Explainability

Files:

- `src/reflection/*`
- `src/reliability/*`

### Implemented now

- Idle reflection scheduler.
- Speculative flaky test runner + flaky score.
- Function explainer (symbol extraction + side-effect heuristics + git history).
- Failure-loop guard, reasoning reset, deep scan, confidence model.
- Git checkpoint create/rollback/cleanup around risky turns.

### Key strengths

- Reliability path is unusually mature for this stage.
- Confidence-gate-to-human hint is implemented and tested.

### Gaps versus desired end state

- Reflection jobs are basic; no learned prioritization or workload shaping.
- Explainability is heuristic and code-pattern based, not semantic CFG/dataflow-based.

---

## 2.11 Persistence and Operational Data

Current persisted files (runtime):

- `MEMORY.md`, `memory/*.md`
- `CLAW_HISTORY.log`
- `tmp/snapshots/*.json`
- `tmp/observations.json`
- `tmp/run-store.json`
- `tmp/cron-state.json`
- `tmp/workflow-state/*.json`
- `tmp/autonomy-state.json`
- `tmp/context-summary.json`
- `tmp/context-embeddings.json`
- `tmp/context-index-state.json`

### Strengths

- Broad persistence footprint already exists for many subsystems.

### Gaps

- No unified datastore with migrations/transactions for cross-subsystem consistency.
- No signed append-only audit store for critical security events.

---

## 2.12 Test Coverage Reality

High-confidence tested areas:

- Gateway auth/rate/risk/error semantics.
- Runtime lifecycle, privacy scrubbing, context freshness.
- Tool routing, approvals, SSRF, destructive command controls.
- Scheduler/orchestrator/autonomy state persistence.
- Context compression and workspace tracing.
- Adapter stream/error/fallback behavior.
- Responsiveness and channels.

Coverage gaps to add for end state:

- Real messaging platform contract/e2e tests.
- Web UI auth/session/streaming tests.
- Chaos/recovery tests with mid-turn process crashes and replay.
- Large multi-repo performance and long-horizon memory drift tests.
- Policy-as-code and signed approval/audit integrity tests.

---

## 3) OpenClaw Parity and Beyond Matrix

| Capability Domain | OpenClaw-Class Expectation | Current CursorClaw State | Target Delta |
|---|---|---|---|
| Gateway + RPC auth/policy | Strong gateway control plane | Implemented and strong | Add streaming clients and durable audit persistence |
| Session queueing + lifecycle | Ordered turn execution | Implemented | Add queue replay and resilient distributed workers |
| Tool policy and approvals | Strict action controls | Implemented with capability workflow | Add sandbox isolation and policy-as-code |
| SSRF/prompt injection guards | External content safety | Implemented and tested | Add trust provenance propagation + adaptive defense |
| Memory continuity | Durable memory + retrieval | Implemented + semantic retrieval | Add long-horizon user model and skill memory |
| Cron/heartbeat/workflows | Autonomous scheduling | Implemented | Add long-horizon planner and richer governance |
| Messaging adapters | Multi-endpoint interaction | Local + Slack skeleton only | Build production adapters and inbound event handling |
| Web UI remote access | Secure remote operator UI | Missing | Build full web app + secure edge path |
| Explainability | Reasonable action rationale | Partial (journal/explainer) | Add stronger causal trace and plan provenance |
| Reliability/self-heal | Fail-safe loops and rollback | Implemented in core | Expand with chaos drills and distributed continuity |

---

## 4) Desired End-State Architecture

```text
Remote Users (Messaging Apps, Web UI, Mobile)
        |
        v
Secure Edge Layer
  - identity federation / device auth / replay protection
  - transport security / policy checks / rate controls
        |
        v
CursorClaw Gateway Control Plane
  - RPC + streaming
  - method scopes and policy decisions
  - run lifecycle APIs
        |
        v
Autonomous Agent Core
  - planner -> executor -> verifier -> critic loop
  - session queue + durable run state
  - decision journal and action envelopes
        |
        +--> Tool Fabric (sandboxed exec, web fetch, MCP, connectors)
        +--> Context Fabric (semantic index, cross-repo graph, trace evidence)
        +--> Memory Fabric (episodic/semantic/procedural memory)
        +--> Autonomy Fabric (cron, heartbeat, goal planner, proactive intents)
        +--> Safety Fabric (privacy scrubber, approval workflow, capability grants)
        |
        v
Observability + Operations
  - metrics/traces/logs
  - incident controls
  - recovery and runbooks
```

---

## 5) Phased Implementation Plan

The sequence intentionally secures the platform first, then expands intelligence and remote surfaces.

## Phase 0 - Program Baseline, Contracts, and Migration Safety

**Goal:** Lock interfaces and migration strategy before major expansion.

### Step-by-step

1. Freeze stable interfaces for gateway, adapter events, tool policy results, and action envelopes.
2. Define datastore migration strategy and schema versioning policy.
3. Add architecture decision records (ADR) for policy engine, sandbox approach, and remote edge model.
4. Establish release gating policy and branch protection requirements.

### Success criteria checklist

- [ ] Interface contracts versioned and published.
- [ ] Migration framework chosen and documented.
- [ ] ADR set approved for critical architecture choices.
- [ ] Release gate policy adopted in CI.

### Guardrails

- [ ] No breaking contract change without version bump + compatibility test.
- [ ] Migrations must be forward/backward tested on fixture data.

---

## Phase 1 - Secure Remote Access Foundation (Messaging + Web UI Readiness)

**Goal:** Enable remote access safely while preserving on-device-first trust boundaries.

### Step-by-step

1. Keep core runtime bound to loopback by default; introduce secure edge service for remote ingress.
2. Implement robust identity:
   - short-lived JWT/session tokens,
   - optional OIDC for web UI,
   - anti-replay nonces for webhook-based channels.
3. Implement persistent token/session revocation store.
4. Add per-identity RBAC and method scopes (not only IP-based subject limits).
5. Build secure session management APIs for web UI and channel bridge services.

### Success criteria checklist

- [ ] Remote access works without exposing raw runtime process directly.
- [ ] Session/token revocation is immediate and durable.
- [ ] Identity-linked scope enforcement verified.
- [ ] Security logs include actor identity, audit ID, and decision reason.

### Guardrails

- [ ] Failed-auth/replay/fuzz tests added for remote ingress.
- [ ] Any unauthenticated remote method execution blocks release.

---

## Phase 2 - High-Assurance Action Safety and Policy Engine

**Goal:** Make high-risk actions cryptographically/auditably governable and sandboxed.

### Step-by-step

1. Integrate policy-as-code engine for ingress/tool/autonomy decisions.
2. Replace host `exec` default with sandbox runtime:
   - container/nsjail/firecracker profile,
   - resource and syscall restrictions.
3. Add egress policy classes:
   - domain allowlist/denylist,
   - environment-based strictness tiers.
4. Introduce explicit multi-step approval UX for high-risk tool and autonomous actions.
5. Persist signed audit artifacts for approvals/denials/executions.

### Success criteria checklist

- [ ] High-risk actions are impossible without policy permit.
- [ ] `exec` runs in sandbox by default in production profile.
- [ ] All policy decisions are explainable and audit-persisted.
- [ ] Egress rules enforce domain policy deterministically.

### Guardrails

- [ ] Red-team suites for prompt injection + tool escalation are mandatory.
- [ ] SSRF bypass corpus must remain fully blocked.
- [ ] Any sandbox escape finding blocks release.

---

## Phase 3 - Software Engineering Cognition Core (Planner-Executor-Verifier)

**Goal:** Upgrade from single-pass turn execution to robust engineering loops.

### Step-by-step

1. Add explicit plan graph object per work item:
   - hypotheses,
   - selected path,
   - verification plan,
   - stop conditions.
2. Add verifier loop with deterministic checks:
   - tests/build/lint targeted by changed scope.
3. Add critic stage to detect low-confidence or contradictory outcomes.
4. Persist plan and verification outcomes in run state.
5. Add policy-limited autonomous retries with confidence decay.

### Success criteria checklist

- [ ] Agent emits explicit plan artifacts for non-trivial engineering tasks.
- [ ] Verifier checks run automatically for mutating code paths.
- [ ] Critic stage can halt low-confidence retries and request human hint.
- [ ] Plan continuity survives restart and resume.

### Guardrails

- [ ] Regression tests ensure no infinite retry loops.
- [ ] Mutation actions without verification must fail closed in strict mode.

---

## Phase 4 - Deep Workspace Intelligence and Cross-System Reasoning

**Goal:** Make multi-repo and distributed-debugging reasoning first-class.

### Step-by-step

1. Add incremental file watchers and index updates (reduce full-scan dependence).
2. Introduce language-aware AST parsing for symbol-level retrieval and call graph extraction.
3. Enrich cross-repo graph with confidence scoring from:
   - static imports,
   - runtime trace evidence,
   - test failure locality.
4. Add route-to-code mapping quality scoring and provenance metadata.
5. Add retrieval quality telemetry and stale-index detection alarms.

### Success criteria checklist

- [ ] Incremental indexing significantly reduces refresh latency.
- [ ] Symbol-level retrieval improves top-K precision on benchmark set.
- [ ] Cross-repo suspect ranking is evidence-backed and explainable.
- [ ] Runtime traces are linked to likely modules with confidence scores.

### Guardrails

- [ ] Retrieval precision/recall benchmark suite introduced and enforced.
- [ ] Index corruption fallback path validated.

---

## Phase 5 - Real Remote Surfaces: Messaging Connectors and Web UI

**Goal:** Deliver secure remote usability through real channels and web interface.

### Step-by-step

1. Build production channel adapters:
   - Slack (full API integration),
   - Discord,
   - Telegram (initial set).
2. Add inbound event normalization and idempotency keys.
3. Build web UI backend + frontend:
   - secure login/session,
   - run streaming view,
   - approvals dashboard,
   - incident control panel.
4. Add thread/session mapping between channels and runtime sessions.
5. Implement outbound delivery reliability (retry, dedupe, dead-letter queue).

### Success criteria checklist

- [ ] Users can interact via at least three real messaging surfaces.
- [ ] Web UI supports live run status and approvals.
- [ ] Inbound events are replay-safe and idempotent.
- [ ] Delivery failures are retried safely without duplicate user-visible sends.

### Guardrails

- [ ] End-to-end adapter contract tests in CI.
- [ ] Signature verification/replay-attack tests mandatory.

---

## Phase 6 - Autonomy, Personalization, and Lifelike Behavior

**Goal:** Move from periodic automation to personalized, bounded, lifelike autonomy.

### Step-by-step

1. Add long-horizon planner (goals, commitments, follow-up intents).
2. Introduce user preference memory for communication style and interruption policy.
3. Upgrade proactive logic from pattern heuristics to evidence- and intent-based suggestions.
4. Expand behavior engine:
   - tone adaptation per channel/user preference,
   - activity-aware pacing and "quiet compliance",
   - context-sensitive greeting/re-engagement.
5. Add human override controls:
   - pause autonomy,
   - DND windows,
   - proactive strictness profile.

### Success criteria checklist

- [ ] Proactive behavior is relevant, low-noise, and policy-compliant.
- [ ] User-level communication preferences persist and influence behavior.
- [ ] Lifelike output remains bounded by anti-spam safeguards.
- [ ] Operators can pause/override autonomy instantly.

### Guardrails

- [ ] Anti-spam and quiet-hour regression tests block release on failure.
- [ ] No proactive send when incident mode or user policy forbids.

---

## Phase 7 - Reliability, Continuity, and Safe Self-Healing

**Goal:** Guarantee continuity and bounded recovery from failures.

### Step-by-step

1. Persist queue state and in-flight turn metadata for restart-safe resume.
2. Add deterministic replay/reconciliation for interrupted runs.
3. Enhance checkpoint policy:
   - automatic scope detection (changed files count, risk intent),
   - post-action verification matrix.
4. Add chaos-tested failure recovery:
   - adapter crash,
   - process kill,
   - partial persistence failure.
5. Introduce automated incident playbook triggers for repeated anomalies.

### Success criteria checklist

- [ ] Restart preserves or reconciles in-flight runs deterministically.
- [ ] Rollback flow restores known-good state on failed risky mutations.
- [ ] Chaos test suite demonstrates bounded error recovery.
- [ ] Incident triggers fire with actionable forensic bundles.

### Guardrails

- [ ] No data-loss regression in durability suite.
- [ ] Any unresolved interrupted-run leak blocks release.

---

## Phase 8 - Observability, SLOs, and Operations Hardening

**Goal:** Production-grade operability and measurable reliability.

### Step-by-step

1. Add metrics/tracing exporters for gateway/runtime/adapter/tool/scheduler subsystems.
2. Create dashboards for:
   - latency,
   - queue depth,
   - error rates,
   - tool deny reasons,
   - autonomy activity and throttle rates.
3. Define SLOs and alert thresholds.
4. Implement runbooks for incident response, backup/restore, token rotation, and rollback.
5. Add retention and privacy controls for operational logs.

### Success criteria checklist

- [ ] SLO dashboards and alerts operational.
- [ ] Runbooks tested via live drills.
- [ ] Operational logs are privacy-safe and policy-compliant.
- [ ] On-call can diagnose failures without code-level deep dive.

### Guardrails

- [ ] Alert coverage for silent failure classes (stalled scheduler, adapter dead loops).
- [ ] Backup/restore drill failure blocks production promotion.

---

## Phase 9 - OpenClaw Parity+ Certification and Staged Rollout

**Goal:** Formal parity validation plus explicit superiority claims (security + functionality).

### Step-by-step

1. Define parity checklist mapped to OpenClaw-equivalent capabilities.
2. Define parity-plus checklist:
   - stronger security defaults,
   - deeper reliability controls,
   - richer engineering autonomy.
3. Run full validation matrix in staging and canary cohorts.
4. Perform staged rollout with rollback thresholds and kill-switch policy.
5. Publish parity and risk report with residual known limitations.

### Success criteria checklist

- [ ] OpenClaw parity checklist passes fully (or approved exceptions documented).
- [ ] Parity-plus security and reliability gates pass.
- [ ] Canary rollout shows stable error/security metrics.
- [ ] Clear rollback and incident criteria are in place and tested.

### Guardrails

- [ ] No production rollout without full red-team and chaos pass.
- [ ] Any critical security regression auto-triggers rollback gate.

---

## 6) Global Regression Guardrail Matrix

These are non-negotiable release gates across all phases.

## 6.1 Build and Contract Guardrails

- [ ] `npm run build` must pass on every merge.
- [ ] Interface contract tests must pass for:
  - adapter events,
  - RPC envelopes,
  - tool schemas,
  - channel adapter payloads.
- [ ] Backward-compatibility test suite required for versioned APIs.

## 6.2 Security Guardrails

- [ ] Auth and method-scope tests required.
- [ ] Prompt-injection red-team corpus required.
- [ ] SSRF + DNS rebinding suites required.
- [ ] Capability/approval bypass tests required.
- [ ] Incident mode enforcement tests required.
- [ ] Secret scrubbing tests required for prompt/tool/log flows.

## 6.3 Reliability Guardrails

- [ ] Run continuity tests under restart and crash conditions.
- [ ] Checkpoint rollback lifecycle tests required.
- [ ] Failure-loop and confidence-gate tests required.
- [ ] Scheduler correctness tests required for cron/heartbeat/workflows.

## 6.4 Behavior and UX Guardrails

- [ ] Anti-spam pacing tests required.
- [ ] Quiet-hours and autonomy budget tests required.
- [ ] No fabricated human-identity claims in templates/policies.

## 6.5 Performance Guardrails

- [ ] Throughput baseline tests for tool router and plugin pipeline required.
- [ ] Prompt assembly budget tests required.
- [ ] Large workspace indexing/retrieval latency guardrails required.

## 6.6 Operations Guardrails

- [ ] Metrics/traces/log exporters must be healthy in staging.
- [ ] Backup/restore drills must pass before production promotion.
- [ ] Incident response runbooks must be validated each release cycle.

---

## 7) Recommended Delivery Order (Risk-Minimizing)

1. Phase 0 -> 2 (contracts + remote auth + safety hardening)
2. Phase 3 -> 4 (engineering cognition + deep context intelligence)
3. Phase 5 (remote channels and web UI)
4. Phase 6 (lifecycle/lifelike autonomy)
5. Phase 7 -> 8 (continuity + operations hardening)
6. Phase 9 (formal parity+ certification and staged launch)

This order prevents exposing advanced autonomy to remote users before the safety and reliability substrate is mature.

---

## 8) Immediate Next Iteration (Two-Week Execution Starter)

1. Build Phase 0 deliverables:
   - interface contract versioning doc,
   - migration skeleton,
   - CI release gates.
2. Start Phase 1:
   - secure edge service and durable revocation store.
3. Begin Phase 2 groundwork:
   - policy-as-code integration spike,
   - sandbox execution proof-of-concept replacing host `exec`.
4. Define parity checklist draft for Phase 9 to keep roadmap measurable from day one.

---

## 9) Final Assessment

CursorClaw today is already a strong security-first autonomous runtime with substantial reliability and context infrastructure.  
To reach the requested end state (highly-intelligent, resilient, lifelike, secure remote assistant with OpenClaw feature parity and beyond), the highest-leverage work is:

1. secure remote surface and policy hardening,
2. explicit engineering planning/verifier loops,
3. production-grade channel/web interfaces,
4. long-horizon personalization/autonomy controls,
5. durability/observability hardening with strict release guardrails.

This document is the implementation reference for that transformation.

