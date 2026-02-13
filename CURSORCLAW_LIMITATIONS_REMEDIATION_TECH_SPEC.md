# CursorClaw Limitations Remediation Tech Spec

Date: 2026-02-13  
Status: Proposed (implementation-ready)  
Scope: Security, maintainability, functionality, continuity, and reliability upgrades requested in issue brief.

---

## 1) Executive Summary

This spec is a codebase-grounded plan for five major improvement areas:

1. Security ("trust but verify", prompt-injection-resistant execution)
2. Maintainability (plugin architecture to reduce complexity debt)
3. Functionality (runtime observation + MCP expansion)
4. Lifelike behavior (continuity via decision journal + proactive suggestions)
5. Reliability (multi-path reasoning + local git checkpoints/rollback)

The current codebase already has a strong baseline (auth, rate limits, tool schema validation, SSRF controls, run snapshots, workflow idempotency), but key gaps remain around pre-egress secret scrubbing, explicit capability grants, extension architecture, runtime-state observability, persistent decision continuity, and failure-loop recovery.

This document defines implementation phases for each area, with success criteria and regression guardrails designed to keep code quality, security, and operational reliability very high.

---

## 2) Current-State Analysis (Evidence from Code)

### 2.1 Security baseline and gaps

**Implemented now:**
- Risk scoring and policy logs (`src/security.ts`)
- Tool schema validation + approval gates (`src/tools.ts`)
- Command intent classifier and destructive command denylist (`src/tools.ts`)
- SSRF guard with DNS/IP checks and redirect revalidation (`src/security.ts`, `src/tools.ts`)
- Prompt-injection wrapper for untrusted content (`wrapUntrustedContent`, `src/security.ts`)

**Gaps now:**
- No mandatory pre-egress secret/PII scanner before data leaves host (runtime/tool output path not scrubbed comprehensively)
- Approval logic is policy-based, but not an explicit user-consent workflow with one-time capabilities
- No provenance-linked policy that ties untrusted content to downstream execution constraints

### 2.2 Maintainability baseline and gaps

**Implemented now:**
- Clear modules (gateway/runtime/security/tools/scheduler/memory)
- Tool registry abstraction (`ToolRouter.register`)

**Gaps now:**
- Core wiring and lifecycle remain centralized in `src/index.ts`
- No formal plugin contracts for Collectors/Analyzers/Synthesizers
- No stable extension SDK boundary for community skills

### 2.3 Functionality baseline and gaps

**Implemented now:**
- Turn runtime, snapshots, memory retrieval, scheduler and orchestration loops

**Gaps now:**
- No runtime observation bus (debugger, logs, crash state, DB/browser runtime context)
- No MCP implementation or adapter surface (no `mcp` references in source)

### 2.4 Continuity baseline and gaps

**Implemented now:**
- Persistent run state (`RunStore`)
- Persistent autonomy state (`AutonomyStateStore`)
- Memory persistence (`MemoryStore`)

**Gaps now:**
- No persistent decision journal of "why" choices were made
- No file-change-aware proactive recommendation engine

### 2.5 Reliability baseline and gaps

**Implemented now:**
- Adapter fallback chain and timeout watchdog (`src/model-adapter.ts`)
- Runtime snapshots (`src/runtime.ts`)
- Workflow idempotency (`src/scheduler.ts`)

**Gaps now:**
- No failure-loop breaker with forced alternative hypotheses
- No automatic git checkpoint/rollback orchestration before risky multi-file refactors

---

## 3) Design Principles for All Improvements

1. **Default-deny for high-risk operations.**
2. **Local-first security controls before cloud/model boundary.**
3. **Composable interfaces over monolithic orchestration growth.**
4. **Append-only auditability for decisions and security events.**
5. **Fail safe, recover fast, and prove recovery via tests.**

---

## 4) Improvement #1: Security - Close "Trust but Verify" and Execution Gaps

## 4.1 Target Architecture

Add a new **Pre-Egress Privacy Pipeline** and **Capability-Based Action Gate**:

- `PrivacyScrubber` runs locally before prompt/tool payload leaves machine.
- Findings are tokenized into deterministic placeholders (per run/session map).
- Capability requirements are computed for each tool/command.
- High-risk capabilities require explicit user approval (time-bound, single-use).

### New components
- `src/privacy/secret-scanner.ts`
- `src/privacy/privacy-scrubber.ts`
- `src/security/capabilities.ts`
- `src/security/approval-workflow.ts`

---

## 4.2 Phase S1 - Differential Privacy Shrubbing Foundation

### Step-by-step
1. Define scanner interfaces:
   - `SecretFinding { type, confidence, range, source }`
   - `ScanResult { findings, redactedText, placeholders }`
2. Implement baseline detectors:
   - key/token/password regexes
   - PEM/private key patterns
   - entropy-based long secret heuristics
3. Add optional external scanner adapters (gitleaks/trufflehog CLI wrapper) with feature flag.
4. Add config controls in `src/config.ts`:
   - `privacy.scanBeforeEgress`
   - `privacy.detectors`
   - `privacy.failClosedOnScannerError`

### Success criteria
- [x] Secrets/PII are replaced with placeholders before model/tool egress.
- [x] Placeholder map remains local and is not emitted to external providers.
- [x] Scanner supports deterministic re-tokenization within a single run.
- [x] Scanner failures are observable and policy-controlled (fail-open only in explicit dev mode).

### Guardrails
- [x] Existing `tests/security-tools.test.ts` remains green.
- [ ] Add unit tests for at least 20 secret formats and false-positive control cases.
- [ ] Add performance benchmark: scanner adds <= 15% median turn overhead on baseline fixtures.

---

## 4.3 Phase S2 - Pre-Egress Integration Across Runtime

### Step-by-step
1. Inject scrubber into `AgentRuntime.buildPromptMessages` before adapter send.
2. Scrub tool outputs (`exec`, `web_fetch`) before:
   - runtime event emission
   - memory append
   - adapter-visible logs
3. Add policy decision logs:
   - `SCRUBBED_SECRET`
   - `SCRUBBER_ERROR`
4. Add redaction metadata to snapshots to support forensic review without leaking raw secrets.

### Success criteria
- [x] No unredacted secrets in adapter payloads, runtime snapshots, or decision logs.
- [x] Secret-bearing memory entries are never injected into prompt text without explicit allow policy.
- [x] Scrubber can process large tool output safely (bounded memory).

### Guardrails
- [x] Extend `tests/scheduler-memory-runtime.test.ts` with prompt-level scrub assertions.
- [x] Extend red-team corpus tests to verify placeholder substitution.
- [x] Add regression test that tool output containing PEM keys is never persisted raw.

---

## 4.4 Phase S3 - Capability-Based Permissions and Explicit Approval

### Step-by-step
1. Define capability taxonomy:
   - `fs.read`, `fs.write`, `net.fetch`, `process.exec`, `process.exec.mutate`, `process.exec.privileged`
2. Map each tool action to capability requirements.
3. Build approval workflow:
   - request envelope: action, rationale, risk, affected scope
   - user response token: one-time, TTL-bound, auditable
4. Extend gateway RPC for approval actions (`approval.request`, `approval.resolve`) or equivalent callback path.
5. Enforce provenance-aware policy:
   - if action is derived from untrusted content, require stricter approval path.

### Success criteria
- [x] Any network-impacting, mutating, or privileged command requires explicit capability grant.
- [x] Capability grants are single-use, scope-bound, and expire automatically.
- [x] Denied approvals block execution deterministically and log reason codes.

### Guardrails
- [x] Existing exec intent tests remain green.
- [x] Add tests for approval replay attacks (same token reused).
- [x] Add tests for prompt-injection-induced tool calls to verify capability denial.

---

## 5) Improvement #2: Maintainability - Plugin-Based Architecture

## 5.1 Target Architecture

Introduce plugin layers:

- **Collectors:** gather project/runtime/external data
- **Analyzers:** produce semantic findings/hypotheses
- **Synthesizers:** construct prompt or remediation plans

This reduces growth pressure on runtime/gateway orchestration and enables independent feature delivery.

### New core contracts
- `CollectorPlugin`
- `AnalyzerPlugin`
- `SynthesizerPlugin`
- `PluginContext`, `PluginHealth`, `PluginCapability`

---

## 5.2 Phase M1 - Extract Domain Contracts

### Step-by-step
1. Create `src/plugins/types.ts` with strict interfaces and lifecycle methods (`init`, `run`, `dispose`).
2. Introduce bounded context DTOs to prevent cross-module mutation.
3. Move tool-specific orchestration logic from core runtime into plugin-compatible facades.

### Success criteria
- [x] Plugin contracts compile cleanly and are covered by API tests.
- [ ] Core runtime no longer directly depends on feature-specific collector/analyzer logic.

### Guardrails
- [x] No behavior change in existing runtime/gateway integration tests.
- [ ] Type-only contract tests prevent backward-incompatible interface drift.

---

## 5.3 Phase M2 - Plugin Host and Registry

### Step-by-step
1. Implement plugin registry with deterministic load order and capability declarations.
2. Add config-driven enable/disable with schema validation.
3. Add plugin health checks and timeout budget per plugin call.
4. Add error isolation so one plugin failure cannot crash the entire turn.

### Success criteria
- [x] Plugins can be loaded/unloaded without core code edits.
- [x] Plugin failures degrade gracefully with typed error reports.
- [x] Plugin execution budgets are enforced.

### Guardrails
- [x] Add soak test with failing plugin to verify runtime remains available.
- [ ] Add throughput guardrail to ensure registry overhead stays within baseline limits.

---

## 5.4 Phase M3 - Migrate Built-ins to Plugin Model

### Step-by-step
1. Create built-in plugins:
   - Filesystem collector
   - Memory analyzer
   - Prompt synthesizer
2. Keep backward compatibility adapters for existing runtime paths during migration.
3. Remove compatibility path only after dual-run validation period.

### Success criteria
- [x] Built-ins run through plugin host in production mode.
- [x] No regression in existing behavior and test outcomes.

### Guardrails
- [ ] Dual-run comparison tests (legacy path vs plugin path output equivalence).
- [ ] Rollback flag to re-enable legacy path instantly.

---

## 6) Improvement #3: Functionality - Runtime Observation + MCP Expansion

## 6.1 Target Architecture

Add a **Runtime Observation Bus** and **MCP Gateway Integration**:

- Observation adapters collect debugger/log/crash/runtime evidence.
- Evidence is normalized and injected as structured context.
- MCP servers are first-class external context/action providers with policy gating.

---

## 6.2 Phase F1 - Runtime Observation Bus

### Step-by-step
1. Define observation schema:
   - `ObservationEvent { source, kind, timestamp, payload, sensitivity }`
2. Implement adapters:
   - process log tail adapter
   - test failure adapter
   - crash/snapshot adapter
3. Add bounded retention and sensitivity labels for observation records.

### Success criteria
- [x] Agent can consume runtime errors/log evidence in turn context.
- [x] Observation data is sensitivity-labeled and policy-filtered.

### Guardrails
- [x] No uncontrolled log ingestion (size/rate caps required).
- [x] Add tests for malformed and oversized observation payload rejection.

---

## 6.3 Phase F2 - Prompt Integration of Runtime Evidence

### Step-by-step
1. Extend prompt assembly to include observation summaries with provenance.
2. Prioritize high-signal runtime evidence over raw code excerpts when debugging.
3. Add confidence scoring for observation-to-hypothesis linkage.

### Success criteria
- [ ] Runtime-only bugs become reproducible/fixable from observed context.
- [x] Observation summaries remain under strict token/size budget.

### Guardrails
- [ ] Add regression tests for prompt budget overflow prevention.
- [x] Add tests to ensure secret-bearing runtime logs are scrubbed before prompt inclusion.

---

## 6.4 Phase F3 - MCP Core Support

### Step-by-step
1. Add MCP server registry and transport layer.
2. Implement typed wrappers for:
   - resources
   - tools
   - prompts
3. Add per-server policy controls:
   - allowlist
   - capability gating
   - rate limits and audit IDs
4. Add failure isolation and retry budget for MCP calls.

### Success criteria
- [x] CursorClaw can discover and call MCP resources/tools safely.
- [x] MCP interactions are fully auditable with stable reason codes.

### Guardrails
- [x] Add contract tests against mock MCP servers.
- [ ] Block release on any MCP policy bypass finding.

---

## 7) Improvement #4: Lifelike Behavior - Continuity and Proactive Suggestions

## 7.1 Target Architecture

Add:
- **Decision Journal** (`CLAW_HISTORY.log`) for persistent reasoning continuity.
- **Change-Awareness Engine** to suggest follow-up tasks when related files change.

---

## 7.2 Phase L1 - Decision Journal

### Step-by-step
1. Create append-only journal writer with strict schema:
   - decision id, context, alternatives considered, selected path, risk rationale
2. Log key decisions at:
   - tool approval/denial
   - architecture-level plan changes
   - rollback/retry decisions
3. Add rotation and archival policy to avoid unbounded growth.

### Success criteria
- [x] Agent decisions remain reconstructible across context resets/restarts.
- [x] Journal entries are human-readable and diff-friendly.

### Guardrails
- [x] Journal must never contain raw secrets (scrubber required).
- [ ] Add integrity test for append-only semantics and corruption recovery.

---

## 7.3 Phase L2 - Continuity-Aware Prompting

### Step-by-step
1. Build journal summarizer for last-N relevant decisions.
2. Inject summary into system context with strict token budget.
3. Add anti-recency bias rules (do not blindly repeat old decisions without fresh evidence).

### Success criteria
- [x] Sessions preserve architectural context after context window resets.
- [ ] Decision rationales stay consistent unless contradicted by new evidence.

### Guardrails
- [ ] Add tests for decision drift and stale-decision override behavior.
- [x] Add bounded context-size checks for journal injection.

---

## 7.4 Phase L3 - Proactive Suggestion Engine

### Step-by-step
1. Add file-change watcher with debounce and relevance scoring.
2. Map changes to related artifacts (tests/docs/config) through dependency heuristics.
3. Queue low-noise proactive intents via `AutonomyOrchestrator.queueProactiveIntent`.
4. Add user controls:
   - enable/disable proactive mode
   - per-repo quiet hours
   - suggestion frequency cap

### Success criteria
- [x] Agent can suggest relevant follow-up actions after meaningful code changes.
- [x] Suggestions are rate-limited and low-noise.

### Guardrails
- [x] Anti-spam tests (burst edits should not trigger burst suggestions).
- [x] No proactive suggestion while incident mode disables proactive sends.

---

## 8) Improvement #5: Reliability - Hallucination Anchors and Safe Rollback

## 8.1 Target Architecture

Add:
- **Failure Loop Detector** and **Multi-Path Reasoning Controller**
- **Automatic Git Checkpoint Manager** for risky multi-file edits

---

## 8.2 Phase R1 - Failure Loop Detection

### Step-by-step
1. Track fix-attempt history per error signature.
2. Detect repeated equivalent failures (same stack/error class) across attempts.
3. Trigger escalation when threshold reached (default: 2 failed attempts).

### Success criteria
- [x] Repeated identical failures are detected deterministically.
- [x] Retry behavior escalates instead of repeating same strategy.

### Guardrails
- [x] Add tests for false-positive suppression (different errors should not collapse incorrectly).
- [x] Add telemetry for loop events and resolutions.

---

## 8.3 Phase R2 - Multi-Path Reasoning Enforcement

### Step-by-step
1. On escalation, require generation of at least three distinct hypotheses:
   - root-cause class
   - change strategy
   - expected verification signal
2. Enforce strategy diversification before third attempt.
3. Require explicit verification plan selection before execution.

### Success criteria
- [x] Third fix attempt cannot proceed without multi-path hypothesis set.
- [ ] Successful resolution rate after repeated failures increases vs baseline.

### Guardrails
- [x] Add tests to verify hypothesis diversity gate is mandatory.
- [ ] Add regression checks to prevent infinite hypothesis loops.

---

## 8.4 Phase R3 - Local Git Checkpoints and Auto-Rollback

### Step-by-step
1. Define "risky edit" threshold (for example: >3 files or structural refactor labels).
2. Before risky execution:
   - create checkpoint ref (`checkpoint/<runId>/<ts>`) from current HEAD
   - persist checkpoint metadata in run state
3. Run reliability checks (tests/build/lint policy set).
4. On failure:
   - auto-reset to checkpoint
   - write rollback decision entry to `CLAW_HISTORY.log`
5. On success:
   - mark checkpoint as verified and prune old checkpoint refs by retention policy.

### Success criteria
- [x] Multi-file refactor failures can be reverted automatically to known-good state.
- [x] Rollback actions are auditable and reproducible.

### Guardrails
- [x] Never auto-reset over user-uncommitted unrelated changes; require clean or isolated agent workspace strategy.
- [x] Add integration tests for checkpoint create/fail/reset/succeed lifecycle.
- [x] Add safeguards to prevent checkpoint branch leaks.

---

## 9) Cross-Cutting Quality Gates (Release Blocking)

- [x] `npm test` remains fully green.
- [x] `npm run build` remains green.
- [x] Security suites remain green:
  - [x] `tests/security-tools.test.ts`
  - [x] `tests/prompt-injection-redteam.test.ts`
- [x] New suites added and green:
  - [x] privacy scrubber unit/integration suite
  - [x] capability approval workflow suite
  - [x] plugin host isolation suite
  - [x] runtime observation + MCP contract suite
  - [x] decision journal continuity suite
  - [x] multi-path reasoning + checkpoint rollback suite
- [x] Throughput and memory guardrails show no critical regressions.

---

## 10) Recommended Delivery Sequence

1. **Security first** (S1-S3) to harden egress and execution before expanding capabilities.
2. **Reliability core** (R1-R3) so future refactors are safer and self-recovering.
3. **Maintainability migration** (M1-M3) to establish plugin boundaries.
4. **Functionality expansion** (F1-F3) for runtime observation and MCP.
5. **Continuity/lifelike layer** (L1-L3) once safe, modular, and reliable substrate is in place.

This sequence minimizes risk of shipping high-autonomy behaviors on insecure or brittle foundations.

---

## 11) Final Outcome Definition

This remediation is complete when:

- Sensitive data is scrubbed locally before egress by default.
- High-risk actions require explicit, auditable capabilities and approval.
- Core engine supports plugin growth without monolithic complexity drift.
- Agent can reason with runtime observations and MCP context safely.
- Session continuity includes decision rationale, not only conversation text.
- Repeated failure loops are broken by enforced multi-path reasoning.
- Risky refactors have automatic checkpoint and rollback protection.

