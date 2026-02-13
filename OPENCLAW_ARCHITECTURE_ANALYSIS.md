# CursorClaw Unified Technical Specification

**Version:** 2.0  
**Date:** 2026-02-13  
**Status:** Draft for implementation  
**Scope:** Single consolidated spec combining architecture analysis, implementation guidance, improvement guidance, and additional engineering recommendations for security, responsiveness, autonomy, and functionality.

---

## 1) Executive Summary

CursorClaw is a security-first, autonomous personal agent platform inspired by OpenClaw, but with a native **Cursor-Agent CLI Auto** inference path and more lifelike behavior.

This specification defines:

- The baseline architecture inherited from OpenClaw (gateway, agent loop, sessions, tools, cron/heartbeat, memory, security).
- The required CursorClaw deltas (Cursor-Agent adapter, responsiveness upgrades, hardened security controls, higher reliability).
- A phased implementation and validation plan with measurable acceptance criteria.

Primary outcome: a production-capable autonomous agent that is:

1. **Autonomous:** executes periodic and scheduled tasks with controlled initiative.
2. **Responsive:** feels alive (typing, timing, presence, channel etiquette) without being spammy.
3. **Secure:** layered controls from ingress to tools to external-content handling.
4. **Reliable:** resilient under model/auth failures, crashes, and network instability.

---

## 2) Consolidated Inputs

This document unifies and supersedes prior fragmented guidance:

1. Existing `OPENCLAW_ARCHITECTURE_ANALYSIS.md` (earlier architecture and rollout guidance).
2. Implementation guidance from the prior session (gateway + runtime + tooling integration path).
3. Improvement guidance themes (security hardening, lifelike responsiveness, autonomy controls, operational robustness).
4. Source-level observations from OpenClaw docs and code reviewed in depth, including:
   - Gateway protocol/auth/security and RPC authorization.
   - Agent runtime turn orchestration and prompt construction.
   - Scheduling engines (heartbeat and cron).
   - Memory (markdown + vector search + compaction interplay).
   - Tool safety (exec safety/approvals, web fetch SSRF protection, prompt injection wrapping).

---

## 3) Product Goals, Constraints, and Non-Goals

### 3.1 Goals (Must Have)

1. **Native Cursor-Agent CLI Auto integration** as first-class model backend.
2. **Continuous autonomy loop** with heartbeat + cron + optional deterministic workflow runtime.
3. **Defense-in-depth security** across:
   - user/channel ingress,
   - gateway authentication and trusted network boundaries,
   - tool execution,
   - external content ingestion,
   - incident auditability.
4. **Human-like responsiveness**:
   - typing/presence,
   - natural pacing,
   - context-aware proactive behavior.
5. **Resilience**:
   - model/auth failover,
   - queue/session stability,
   - safe recovery.

### 3.2 Constraints

- Runtime: Node.js 22+ ecosystem compatibility.
- Existing OpenClaw-style gateway and workspace semantics should remain familiar.
- Configuration-first operation (`openclaw.json` style defaults with per-agent overrides).
- Multi-channel and remote-access capable while defaulting to local-safe posture.

### 3.3 Non-Goals (Initial)

- Full cloud-managed multi-tenant SaaS control plane.
- Autonomous unrestricted host execution by default.
- Persistent always-on voice assistant as hard requirement for v1 (optional extension).

---

## 4) OpenClaw Baseline: Deep Architecture Findings (Evidence-Driven)

This section captures what CursorClaw should preserve and where it should extend.

### 4.1 Gateway as Control Plane

OpenClaw architecture establishes a central gateway (WebSocket + HTTP) that:

- authenticates clients,
- validates protocol messages,
- routes channel events,
- dispatches typed RPC methods,
- manages sessions and agent job lifecycles.

**Key evidence surfaces reviewed:**

- `docs/concepts/architecture.md`
- `src/gateway/server/ws-connection/message-handler.ts`
- `src/gateway/protocol/index.ts`
- `src/gateway/server-methods.ts`
- `src/gateway/server-methods/agent.ts`
- `src/gateway/server-methods/agent-job.ts`
- `src/gateway/server-methods/agent-timestamp.ts`

**Implication for CursorClaw:** keep gateway-centered coordination and typed protocol validation; add stricter policy gates and observability.

### 4.2 Agent Turn Runtime and Session Queueing

OpenClaw runtime serializes and executes turns with session-aware queueing and streaming lifecycle events.

**Key evidence surfaces reviewed:**

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-subscribe.ts`
- `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts`

Notable strengths:

- per-session/global queue coordination,
- timeout and lifecycle handling,
- compaction retry pathways,
- event stream mapping (assistant/tool/lifecycle).

**Implication for CursorClaw:** preserve this runtime skeleton; swap/extend model backend with Cursor-Agent adapter while maintaining event semantics.

### 4.3 Prompt Construction and Context Control

OpenClaw system prompt is modular and policy-aware.

**Key evidence surfaces reviewed:**

- `docs/concepts/system-prompt.md`
- `src/agents/system-prompt.ts`
- `src/agents/system-prompt-report.ts`
- `src/agents/pi-embedded-helpers/bootstrap.ts`

Strengths:

- deterministic sections,
- tool and safety policy injection,
- workspace bootstrap limits (`bootstrapMaxChars`),
- heartbeat-specific control tokens.

Context pressure mitigation exists at two layers:

1. **Context pruning** (in-memory trimming of tool results):
   - `docs/concepts/session-pruning.md`
   - `src/agents/pi-extensions/context-pruning/extension.ts`
2. **Compaction** (persistent summary transition):
   - `docs/concepts/compaction.md`
   - lifecycle handlers coordinating pre/post compaction hooks.

**Implication:** CursorClaw should retain dual mechanisms and improve quality gates around summary correctness.

### 4.4 Memory Model

OpenClaw uses markdown files as truth and optional vector retrieval as augmentation.

**Key evidence surfaces reviewed:**

- `docs/concepts/memory.md`
- compaction-memory flush references from runtime/lifecycle integrations.

Strengths:

- durable human-readable memory (`MEMORY.md`, `memory/YYYY-MM-DD.md`),
- pre-compaction memory flush pathway,
- optional vector/hybrid retrieval with caching.

**Implication:** keep markdown-first memory model; add stricter privacy partitioning and memory provenance metadata.

### 4.5 Scheduling and Autonomy

OpenClaw distinguishes:

- **heartbeat** for periodic awareness turns,
- **cron jobs** for exact schedules and isolated execution contexts,
- optional deterministic workflows ("Lobster"-style runtime) for complex multi-step automation.

**Key evidence surfaces reviewed:**

- `docs/gateway/heartbeat.md`
- `docs/automation/cron-jobs.md`
- `docs/automation/cron-vs-heartbeat.md`
- `src/infra/heartbeat-runner.ts`
- `src/cron/service.ts` and service submodules
- `src/cron/isolated-agent/run.ts`
- `src/cron/delivery.ts`

**Implication:** CursorClaw should use all three patterns intentionally rather than treating cron and heartbeat as substitutes.

### 4.6 Security Baseline

OpenClaw security posture is already strong and practical.

**Key evidence surfaces reviewed:**

- `docs/gateway/security/index.md`
- `docs/gateway/authentication.md`
- `src/gateway/auth.ts`
- `src/gateway/net.ts`
- `src/security/external-content.ts`
- `src/infra/net/fetch-guard.ts`
- `src/agents/tools/web-fetch.ts`
- `src/infra/exec-safety.ts`
- `src/infra/exec-approvals.ts`

Strengths:

- DM and group trigger policies (`dmPolicy`, `groupPolicy`, allowlists),
- gateway auth + trusted proxy handling,
- SSRF protection with DNS pinning for fetch tools,
- explicit untrusted-content wrapping for prompt injection mitigation,
- host execution approvals and allowlist safety.

**Implication:** CursorClaw should preserve defaults and add risk-based controls for autonomous actions.

### 4.7 Responsiveness Surfaces

OpenClaw includes typing indicators, presence, and channel delivery controls.

**Key evidence surfaces reviewed:**

- `docs/concepts/typing-indicators.md`
- `docs/concepts/presence.md`
- session/send policy concepts (`docs/concepts/session.md`).

**Implication:** CursorClaw can exceed baseline by introducing a behavior policy engine for pacing and social realism.

---

## 5) CursorClaw Target Architecture

### 5.1 High-Level Component Model

```text
Channels (DM/Group/Web/UI/Mobile)
        |
        v
Gateway Control Plane (WS + HTTP + Typed RPC + Auth + Policy)
        |
        +--> Session Manager (isolation, queue keys, lifecycle)
        +--> Scheduler (Heartbeat + Cron + Workflow runtime)
        +--> Presence/Typing Coordinator
        |
        v
Agent Runtime Core
  - Prompt Assembler
  - Tool Router + Policy Enforcer
  - Memory Router (markdown + vector)
  - Model Adapter Layer
        |
        v
Cursor-Agent CLI Auto Adapter (primary)
Fallback Model Providers (secondary)
        |
        v
Tools (exec/web/browser/message/files/system integrations)
```

### 5.2 Core Design Principles

1. **Secure by default, powerful by explicit opt-in.**
2. **Typed contracts at every boundary.**
3. **Main-session continuity + isolated execution where needed.**
4. **Autonomy with bounded initiative and user override.**
5. **Human-legible state (markdown memory, explicit logs, explainable actions).**

---

## 6) Detailed Subsystem Specifications

### 6.1 Gateway and RPC Layer

#### Functional Requirements

- WS handshake MUST perform protocol version checks before method calls.
- Gateway MUST enforce auth for non-local and local clients unless explicitly disabled.
- RPC dispatcher MUST perform role/scope authorization per method.
- Agent RPC MUST remain asynchronous (`runId` immediate response + wait method).
- Gateway MUST expose health/status endpoints for monitoring.

#### Security Requirements

- Default bind MUST remain loopback.
- Trusted proxy chain MUST be explicit and auditable.
- Remote mode MUST require token/password and SHOULD support identity-header verification (for tailnet ingress).

#### Improvements over baseline

- Add per-method rate limits (especially `agent`, `chat.send`, `cron.add`).
- Add request risk scoring for inbound events (new/untrusted sender, high-frequency triggers, tool-heavy prompt patterns).
- Add immutable audit IDs per request and propagate across runtime/tool logs.

### 6.2 Session, Queueing, and Turn Lifecycle

#### Requirements

- Session keying MUST support `dmScope: "per-channel-peer"` and equivalent strict isolation modes.
- Turn execution MUST retain per-session ordering guarantees.
- Runtime MUST enforce per-turn timeout and global resource ceilings.
- Lifecycle events MUST include `queued`, `started`, `tool`, `assistant`, `compaction`, `completed`, `failed`.

#### Improvements

- Add backpressure policy:
  - soft queue depth warning,
  - hard queue cap with deterministic drop/defer strategy.
- Add recovery snapshot every N events for crash-safe stream reconstruction.

### 6.3 Cursor-Agent CLI Auto Adapter (Primary Delta)

#### Adapter Contract

Define `CursorAgentModelAdapter` implementing the same runtime model interface expectations:

1. `createSession(context) -> sessionHandle`
2. `sendTurn(messages, tools, options) -> streaming events`
3. `cancel(turnId)`
4. `close(sessionHandle)`

#### Process Model

- Execute Cursor-Agent CLI as managed subprocess.
- Use strict machine-readable transport:
  - preferred: newline-delimited JSON events on stdout,
  - fallback: framed JSON with sentinel boundaries.
- Parse stream into normalized runtime events (`assistant_delta`, `tool_call`, `usage`, `error`, `done`).

#### Safety and Reliability

- Subprocess runs with minimal environment variables.
- Adapter MUST scrub secrets before logging raw payloads.
- Parser MUST fail closed on malformed frames.
- Add watchdog for hung subprocess and staged termination:
  1. graceful cancel,
  2. SIGTERM,
  3. SIGKILL with incident log.

#### Tool Calling Requirements

- Tool call schema MUST be validated before execution.
- Unknown tool names MUST be rejected with structured error.
- Tool arguments MUST pass JSON schema validation and policy checks before dispatch.

#### Fallback Strategy

- If Cursor-Agent fails due to transport/model/auth errors:
  - rotate auth profile if configured,
  - fallback to secondary model only if policy allows,
  - preserve conversation continuity marker in session state.

### 6.4 Scheduling: Heartbeat, Cron, and Workflow Runtime

#### Heartbeat Spec

- Runs in main session and uses `HEARTBEAT.md` if present.
- Supports silent no-op contract via `HEARTBEAT_OK`.
- MUST support active hours, channel targeting, and visibility controls.

#### Cron Spec

- Supports `at`, `every`, and `cron` expressions.
- Supports isolated and main-session execution modes.
- Must include exponential retry/backoff and max concurrent run controls.

#### Workflow Runtime (Lobster-Style)

Use for deterministic multi-step automation requiring:

- explicit step graph,
- approvals,
- retries with idempotency keys,
- persistent execution state.

#### Improvements

- **Adaptive heartbeat interval**:
  - speed up when unread events are high,
  - slow down during quiet windows.
- **Autonomy budget**:
  - max proactive messages per hour/day per channel,
  - enforced per user/channel policy.

### 6.5 Memory and Context Management

#### Memory Tiers

1. **Durable markdown memory**
   - `MEMORY.md` (long-term).
   - `memory/YYYY-MM-DD.md` (daily append-only).
2. **Session transcript state**
   - current and compacted summaries.
3. **Vector retrieval**
   - optional semantic/hybrid lookups with embedding cache.

#### Requirements

- Pre-compaction memory flush MUST remain enabled by default for main sessions.
- Memory writes SHOULD include provenance tags:
  - source channel,
  - confidence,
  - timestamp,
  - sensitivity label.
- Group/session-specific sensitive facts MUST NOT leak into unrelated sessions.

#### Improvements

- Add memory classification labels: `public`, `private-user`, `secret`, `operational`.
- Block `secret` records from direct prompt injection unless explicitly required.
- Add periodic memory integrity scan (detect contradictions/stale assertions).

### 6.6 Tooling and Execution Policy

#### Baseline Requirements

- Tool registry and schema contracts MUST be typed and validated.
- `exec` defaults:
  - host: sandbox,
  - security: deny or strict allowlist,
  - approval: required for elevated host/node execution.
- `web_fetch` MUST enforce SSRF guard and untrusted-content wrapping.

#### Improvements

- Two-phase execution for high-risk tool calls:
  1. model proposes action plan,
  2. policy engine/approval gate allows execution.
- Command intent classifier for `exec`:
  - classify as read-only, mutating, network-impacting, privilege-impacting.
- Default deny for destructive patterns even under allowlist unless explicitly approved.

### 6.7 Security Architecture (Defense-in-Depth)

#### Trust Boundaries

1. External sender/channel input.
2. Gateway ingress and protocol layer.
3. Session and prompt assembly.
4. Tool execution and network egress.
5. Data persistence (memory/logs/credentials).

#### Required Controls

1. **Access controls**
   - DM policy defaults to pairing or strict allowlist.
   - Group policy defaults to mention-required or allowlist.
2. **Prompt injection defense**
   - wrap external/untrusted content with warning envelope.
   - highlight suspicious patterns to model and logs.
3. **Egress/network safety**
   - SSRF guard with DNS/IP policy enforcement.
4. **Execution safety**
   - command parsing, safe bins, approvals, sandboxing.
5. **Secrets hygiene**
   - no secret echoing in prompts/logs.
   - strict filesystem permissions for stored credentials.

#### Additional Hardening (New)

- Add policy decision logs (allow/deny + reason code) for every sensitive action.
- Add canary prompts in test mode to continuously validate injection resistance.
- Add anomalous behavior detector:
  - sudden surge in tool calls,
  - repeated fetch to suspicious domains,
  - repetitive self-trigger loops.
- Add incident command bundle:
  - revoke tokens,
  - disable proactive sends,
  - isolate tool hosts,
  - export forensic logs.

### 6.8 Responsiveness and Lifelike Behavior Layer

#### Behavioral Requirements

- Typing indicator modes MUST be configurable (`never`, `instant`, `thinking`, `message`).
- Presence state MUST deduplicate and expire by TTL.
- Delivery pacing SHOULD avoid robotic bursts.

#### Humanization Policy (New)

- Natural delay model:
  - short requests: low latency replies,
  - complex tool-heavy turns: periodic typing updates with final consolidated answer.
- Avoid triple-tap behavior:
  - enforce minimum inter-message interval unless urgent.
- Contextual greeting/re-engagement:
  - greet only when social context suggests it,
  - avoid repetitive salutations in ongoing threads.
- Emoji and tone adaptation:
  - opt-in per channel/persona policy, not global hardcoded behavior.

#### Safety Guardrails for Lifelike Mode

- Never fabricate status/presence events.
- Never imply human identity or consciousness claims.
- Proactive outreach MUST respect autonomy budgets and quiet-hour policies.

### 6.9 Reliability, Operations, and Recovery

#### Operational Requirements

- Service MUST support daemonized operation (systemd/launchd equivalent).
- Graceful shutdown MUST flush in-flight queue state and scheduler checkpoints.
- Health checks MUST include:
  - gateway liveness,
  - model adapter health,
  - scheduler backlog,
  - last successful heartbeat/cron execution.

#### Failover Requirements

- Model/auth profile rotation with cooldown and billing-disable awareness.
- Circuit breaker for repeatedly failing model/provider pairs.
- Tool host degradation policy (disable problematic tools while keeping chat available).

#### Recovery Requirements

- Snapshot session metadata and scheduler state periodically.
- Support startup replay for incomplete isolated jobs.
- Workspace backup guidance and restoration verification runbook.

### 6.10 Client Surfaces and Remote Access

#### Client Requirements

- Desktop clients MUST support:
  - full chat interaction,
  - session inspection,
  - cron and heartbeat controls,
  - security status visibility.
- Mobile clients MUST support:
  - low-friction chat and notifications,
  - safe reconnect and session continuity,
  - minimal control operations (pause autonomy, emergency stop, token rotation trigger).
- Web/PWA clients SHOULD provide a parity path when native clients are unavailable.

#### Remote Access Requirements

- Support SSH tunnel and tailnet-mediated remote access patterns.
- Remote transport MUST preserve gateway auth guarantees and SHOULD avoid direct public exposure by default.
- Credentials for remote mode MUST be revocable without full system redeploy.

---

## 7) Configuration Specification

CursorClaw keeps OpenClaw-style centralized config with per-agent overrides.

### 7.1 Minimum Secure Baseline

```json
{
  "gateway": {
    "bind": "loopback",
    "auth": { "mode": "token" },
    "mdns": { "enabled": false }
  },
  "agents": {
    "defaults": {
      "session": { "dmScope": "per-channel-peer" },
      "heartbeat": {
        "enabled": true,
        "every": "30m",
        "prompt": "Read HEARTBEAT.md if present. If no action needed, reply HEARTBEAT_OK."
      },
      "compaction": { "memoryFlush": true }
    }
  },
  "tools": {
    "exec": {
      "host": "sandbox",
      "security": "allowlist",
      "ask": "on-miss"
    }
  }
}
```

### 7.2 Cursor-Agent Adapter Config

```json
{
  "models": {
    "cursor-auto": {
      "provider": "cursor-agent-cli",
      "command": "cursor-agent",
      "args": ["auto", "--stream-json"],
      "timeoutMs": 600000,
      "fallbackModels": ["anthropic:claude-sonnet"]
    }
  },
  "agents": {
    "defaults": { "model": "cursor-auto" }
  }
}
```

---

## 8) Delivery Plan (Phased Implementation)

### Phase 0 - Spec Closure and Contracts (Week 0-1)

- Finalize adapter I/O event schema and test fixtures.
- Lock security baseline defaults and deny-by-default policies.
- Define acceptance metrics and dashboards.

**Exit criteria:**  
- [x] approved interface contract docs and threat model checklist.

### Phase 1 - Adapter Foundation (Week 1-3)

- Build Cursor-Agent subprocess wrapper.
- Implement event parser, cancellation, timeout, and usage mapping.
- Integrate with runtime model resolution.

**Exit criteria:**  
- [x] single-turn and multi-turn chat works with streaming + tool call skeleton.

### Phase 2 - Tooling and Policy Enforcement (Week 3-5)

- Enforce schema + policy gates for tool calls.
- Implement two-phase high-risk execution flow.
- Integrate approval prompts and decision logs.

**Exit criteria:**  
- [x] controlled tool execution passes policy tests and rejection paths.

### Phase 3 - Autonomy Engine (Week 5-7)

- Enable heartbeat + cron + isolated job routing.
- Add adaptive heartbeat and autonomy budget controls.
- Implement workflow runtime hooks for deterministic tasks.

**Exit criteria:**  
- [x] scheduled tasks, proactive behavior, and throttling validated end-to-end.

### Phase 4 - Memory and Compaction Quality (Week 7-8)

- Add memory provenance and sensitivity labels.
- Validate pre-compaction memory flush reliability.
- Add memory integrity scans and leak-prevention checks.

**Exit criteria:**  
- [x] no cross-session leakage in test matrix, stable memory retrieval quality.

### Phase 5 - Responsiveness and UX Behavior (Week 8-9)

- Add pacing/typing behavior policy engine.
- Tune message timing and anti-spam heuristics per channel.
- Validate lifelike behavior without policy violations.

**Exit criteria:**  
- [x] user-acceptance playbooks pass (timeliness + naturalness).

### Phase 6 - Hardening and Production Readiness (Week 9-10)

- Security audit automation in CI.
- Recovery drills: model outage, scheduler crash, queue backlog.
- Final performance and reliability burn-in.

**Exit criteria:**  
- [x] release gate checklist all green.

---

## 9) Verification and Test Strategy

### 9.1 Unit Tests

- Adapter event parsing, malformed frame handling, cancellation.
- Policy evaluator (dm/group/send/tool decisions).
- Exec safety classifier and allowlist matching.
- Memory classification and filter rules.

### 9.2 Integration Tests

- WS handshake/auth/protocol validation.
- Agent run lifecycle with tool calls and retries.
- Heartbeat silent mode (`HEARTBEAT_OK`) behavior.
- Cron isolated delivery and backoff behavior.
- Failover across auth profiles and fallback models.

### 9.3 Security Tests

- Prompt injection corpus against wrapped external content.
- SSRF bypass attempts (DNS rebinding, local IP aliases).
- Privilege escalation attempts via exec tool payload variants.
- Trusted proxy spoofing and header-forgery scenarios.

### 9.4 End-to-End Scenarios

1. User DM onboarding with pairing and session isolation.
2. Daily autonomy cycle with heartbeat + cron reminders.
3. Web research task with safe fetch + synthesis + citations.
4. Incident mode: disable proactive sends and rotate credentials.

### 9.5 Performance and Reliability Tests

- Concurrent session queue stress.
- Long-running tool stream handling.
- Recovery from abrupt process kill during active turn.
- Scheduler persistence under restart loops.

---

## 10) SLOs, Metrics, and Observability

### 10.1 Target SLOs (Initial)

- Gateway availability: >= 99.9%.
- Successful turn completion (non-user-error): >= 99.0%.
- Median response start latency (non-tool-only turns): <= 2.0s.
- Scheduler on-time execution for cron jobs: >= 99.5% within tolerance window.

### 10.2 Required Metrics

- Turn lifecycle counters and latency histograms.
- Queue depth per session and globally.
- Tool allow/deny counts by reason code.
- Security signal counters (injection flags, SSRF blocks, approval denials).
- Heartbeat and cron success/failure rates.
- Adapter subprocess crash/timeout counts.

### 10.3 Logging Requirements

- Structured JSON logs with request/session/run IDs.
- Redaction of secrets and sensitive message content by policy.
- Retention policy with configurable privacy levels.

---

## 11) Release Gates and Acceptance Checklist

A release is blocked unless all are true:

- [x] Cursor-Agent adapter passes contract/integration suite.
- [x] Security baseline config is enabled by default.
- [x] `security audit` pipeline passes or approved exceptions are documented.
- [x] No critical prompt injection or SSRF test regressions.
- [x] Queue, scheduler, and crash-recovery tests pass.
- [x] Lifelike behavior policy passes anti-spam and consistency checks.

### 11.1 Implementation Verification Snapshot (2026-02-13)

- [x] Adapter contract doc created: `docs/cursor-agent-adapter.md`.
- [x] Adapter implementation delivered: `src/model-adapter.ts`.
- [x] Gateway + runtime + scheduler + security baseline implemented:
  - `src/gateway.ts`
  - `src/runtime.ts`
  - `src/scheduler.ts`
  - `src/security.ts`
  - `src/tools.ts`
  - `src/memory.ts`
  - `src/responsiveness.ts`
- [x] Verification completed:
  - `npm test` (18 passing tests)
  - `npm run build` (strict TypeScript compile success)
- [x] CI security suite added: `.github/workflows/ci.yml` (security tests + dependency audit).

---

## 12) Key Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Cursor CLI output format drift | Adapter breakage | Version pinning, schema negotiation, compatibility tests |
| Over-aggressive autonomy | User trust erosion | Autonomy budgets, quiet hours, approval policy |
| Tool misuse in compromised prompt context | Security incident | Two-phase execution, approvals, strict allowlists |
| Compaction quality loss | Memory hallucination | pre/post compaction validation and memory flush checks |
| Multi-channel session leakage | Privacy breach | strict dmScope, sensitivity labels, session-bound retrieval |

---

## 13) Immediate Next Actions (Implementation Starter)

- [x] Create adapter contract doc (`docs/cursor-agent-adapter.md`) with event schemas.
- [x] Implement adapter MVP behind feature flag.
- [x] Add policy-decision logging scaffold and reason codes.
- [x] Add adaptive heartbeat interval and autonomy budget controls.
- [x] Add CI security suite (injection + SSRF + exec misuse tests).

---

## 14) Final Notes

This document is the authoritative single technical specification for CursorClaw v1 planning.  
It intentionally keeps OpenClaw architectural strengths while introducing explicit, testable upgrades in:

- model integration (Cursor-Agent native path),
- behavioral realism,
- safety boundaries,
- and production reliability.

Any implementation that diverges from this spec must document rationale, risk, and updated acceptance criteria.
