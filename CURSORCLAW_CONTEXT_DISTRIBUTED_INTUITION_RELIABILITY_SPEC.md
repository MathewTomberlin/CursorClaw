# CursorClaw Advanced Context, Distributed Debugging, Intuition, and Reliability Spec

Date: 2026-02-13  
Status: Proposed (implementation-ready)  
Scope: Address limitations #2-#5 from request:

1. Maintainability: Context bloat / token drift
2. Functionality: Distributed-system blind spots (multi-repo + network tracing)
3. Lifelike behavior: Intuition layer (background reflection + proactive documentation)
4. Reliability: Loop-of-death prevention (reasoning reset + confidence gating)

---

## 1) Executive Summary

CursorClaw currently has strong foundations (plugin host, runtime observation store, decision journal, capability approvals, failure-loop guard, checkpoint rollback), but still has four key strategic gaps:

- **Context sharpness is heuristic**, not semantic. Prompt context is compressed by simple truncation and recent-record heuristics (`slice(-10)` / `slice(-8)`), which risks token drift in long sessions.
- **Workspace scope is single-root** (`process.cwd()` in `src/index.ts`), creating tunnel vision in multi-repo/service systems.
- **Intuition behavior is event-driven only** (`advisor.file_change`), with no idle-time reflective learning or speculative flakiness detection.
- **Reliability escalation detects repetition**, but does not force broad assumption invalidation across recently touched config/files; no confidence score gate exists for human hint handoff.

This spec defines a phased implementation plan to close those gaps while preserving high quality, strong security, and regression resistance.

---

## 2) Current-State Analysis (Codebase Evidence)

### 2.1 Context assembly and token control (current)

Relevant code:
- `src/runtime.ts`:
  - prompt plugin pipeline in `buildPromptMessages`
  - system budget cap via `applySystemPromptBudget`
- `src/plugins/builtins.ts`:
  - `MemoryCollectorPlugin` returns all per-session memory, then analyzer slices to latest 10
  - `ObservationCollectorPlugin` returns latest 8 observations
  - no semantic ranking or embedding retrieval
- `src/memory.ts`:
  - markdown append + full-file read + session filter
  - no vector index

Current limitation:
- Compression is mostly recency-based and size-based, not semantic relevance-based.
- No "semantic summary cache" keyed by module/chunk and no Top-K embedding retrieval.

### 2.2 Distributed / multi-repo awareness (current)

Relevant code:
- `src/index.ts` sets `workspaceDir = process.cwd()` and builds single `MemoryStore`.
- No workspace catalog or multi-root collector.
- `RuntimeObservationStore` (`src/runtime-observation.ts`) stores arbitrary observations, but ingestion is app-internal; no network trace collector exists.

Current limitation:
- Repo A / Repo B cross-causality is not modeled.
- No request/response traffic capture pipeline for localhost debugging.

### 2.3 Intuition layer behavior (current)

Relevant code:
- `src/proactive-suggestions.ts`: path-based static suggestion heuristics + per-channel cooldown.
- `src/gateway.ts`: `advisor.file_change` RPC to trigger suggestions.
- `src/index.ts`: queues proactive intents through orchestrator callback.

Current limitation:
- Suggestions are explicit-trigger based; no idle background reflection loop.
- No speculative test execution or flaky-test surfacing.
- No autonomous “function explanation” generation based on user struggle signals.

### 2.4 Loop-of-death prevention (current)

Relevant code:
- `src/reliability/failure-loop.ts`: signature repetition threshold.
- `src/runtime.ts`: multi-path prompt instruction when threshold reached.
- `src/reliability/git-checkpoint.ts`: checkpoint + rollback.

Current limitation:
- No forced “assumption invalidation deep scan” of recently touched files.
- No confidence score attached to actions.
- No automatic human-hint request when confidence falls below threshold.

---

## 3) Design Principles for This Work

1. **Semantic relevance over recency heuristics** for prompt context.
2. **Workspace graph awareness** over single-root assumptions.
3. **Background autonomy with bounded budgets**, never noisy by default.
4. **Reliability through explicit uncertainty handling** (confidence-aware handoff).
5. **Strict guardrails and measurable SLOs** before feature enablement.

---

## 4) Workstream A: Hierarchical Context Compression (Context Bloat + Token Drift)

## A.1 Target Architecture

Add a multi-layer context model:

- **L0 (Hot Context):** current turn messages + current file/diff snippets
- **L1 (Semantic Summary Cache):** per-module summaries and update timestamps
- **L2 (Vector Retrieval):** local embedding index with Top-K retrieval
- **L3 (Cold Archive):** full memory/docs fallback (rarely injected directly)

### New components
- `src/context/summary-cache.ts`
- `src/context/embedding-index.ts`
- `src/context/retriever.ts`
- `src/plugins/semantic-context.collector.ts`

### Recommended local vector backend
- Preferred: **LanceDB** (embedded, local-first)
- Alternative: **ChromaDB local mode**
- Abstraction required so backend can be swapped without runtime changes.

---

## A.2 Phase A1 - Semantic Summary Cache

### Step-by-step
1. Define `SemanticSummaryRecord`:
   - `id`, `workspace`, `repo`, `modulePath`, `summary`, `symbols`, `updatedAt`, `version`
2. Build summary generator job:
   - file changed -> summary recompute
   - function/class-level summarization
3. Persist summary cache in local store (`tmp/context-summary.json` or sqlite-backed store).
4. Add cache invalidation on file hash changes.

### Success criteria
- [ ] Updated modules always have fresh summaries after change events.
- [ ] Summary cache retrieval by module path is O(1)-ish and deterministic.
- [ ] Summary versions are migration-safe.

### Guardrails
- [ ] Summary generation failures never block normal runtime turns.
- [ ] Cache corruption recovery test (fallback to source chunks).
- [ ] No secret-bearing raw strings are written to summary cache.

---

## A.3 Phase A2 - Local Embedding Index + Top-K Retrieval

### Step-by-step
1. Define chunking strategy:
   - AST/symbol-aware chunk boundaries where possible
   - fallback line-window chunking with overlap
2. Store embeddings + metadata:
   - workspace/repo/module/symbol/language/sensitivity
3. Implement retrieval API:
   - query text -> Top-K chunks + score
   - filters by workspace, repo, session, sensitivity
4. Integrate with plugin pipeline before prompt synthesis.

### Success criteria
- [ ] Prompt context uses Top-K semantic chunks instead of full module dumps.
- [ ] Retrieval includes score and provenance metadata.
- [ ] End-to-end prompt token usage decreases for large repos.

### Guardrails
- [ ] Retrieval failures fallback to existing context path safely.
- [ ] Sensitivity filtering is enforced in retrieval path.
- [ ] Prompt-injection wrappers persist around untrusted retrieved text.

---

## A.4 Phase A3 - Token Drift Controls

### Step-by-step
1. Add context freshness weighting:
   - boost current file state/diffs over stale messages
2. Add contradiction detector:
   - if old instruction conflicts with current repo state, annotate/penalize old context.
3. Add context eviction policy:
   - semantic redundancy and staleness decay.

### Success criteria
- [ ] Old irrelevant instructions are deprioritized automatically.
- [ ] Context freshness score available in runtime diagnostics.

### Guardrails
- [ ] Regression tests for long-running conversation drift scenarios.
- [ ] No hard prompt overrun after adding weighting metadata.

---

## 5) Workstream B: Workspace-Aware Agency + Network Tracing

## B.1 Target Architecture

Add multi-workspace indexing and distributed trace observability:

- **Workspace Catalog**: multiple roots and repo aliases.
- **Cross-Repo Graph**: dependency and API-caller map.
- **Network Trace Collector**: localhost proxy/harvester ingestion into observation store.

### New components
- `src/workspaces/catalog.ts`
- `src/workspaces/multi-root-indexer.ts`
- `src/workspaces/cross-repo-graph.ts`
- `src/network/trace-collector.ts`
- `src/network/trace-linker.ts`

---

## B.2 Phase B1 - Multi-Workspace Catalog

### Step-by-step
1. Add config:
   - `workspaces.roots[]`, optional labels/priority.
2. Build root scanner and health checker.
3. Update collectors to iterate active roots.
4. Add workspace tags to all context artifacts.

### Success criteria
- [ ] Agent can index/search across multiple configured roots.
- [ ] Context artifacts include workspace and repo provenance.

### Guardrails
- [ ] Root traversal obeys ignore/security policies.
- [ ] Large multi-root indexing remains bounded by CPU/memory budget.

---

## B.3 Phase B2 - Cross-Repo Dependency/API Mapping

### Step-by-step
1. Parse import/package/API references per repo.
2. Build graph edges:
   - caller -> callee (repo/module/service contract).
3. Expose resolver for “bug in A possibly caused by B” hypothesis generation.
4. Integrate resolver into analyzer plugin stage.

### Success criteria
- [ ] Cross-repo suspects are surfaced in debugging plans.
- [ ] Runtime plan includes referenced repo/module links when relevant.

### Guardrails
- [ ] False-link suppression threshold with confidence scoring.
- [ ] Graph build failures do not block normal single-repo behavior.

---

## B.4 Phase B3 - Localhost Traffic Tracing

### Step-by-step
1. Implement trace collector modes:
   - passive log ingestion
   - optional proxy capture for localhost HTTP traffic
2. Normalize trace events:
   - route, method, status, latency, request/response payload samples
3. Scrub secrets from payloads before persistence.
4. Ingest into `RuntimeObservationStore` with source=`net-trace`.

### Success criteria
- [ ] Agent can retrieve real JSON payload evidence during web debugging.
- [ ] Trace events can be correlated to source modules/routes.

### Guardrails
- [ ] Explicit opt-in required for traffic capture.
- [ ] Body-size caps and PII scrubbing are mandatory.
- [ ] No private external network interception beyond configured localhost targets.

---

## 6) Workstream C: Intuition Layer (Background Reflection + Proactive Docs)

## C.1 Target Architecture

Add low-noise autonomy jobs:

- **Idle Reflection Scheduler**
- **Speculative Flaky-Test Detector**
- **Proactive Function Explainer**

### New components
- `src/reflection/idle-scheduler.ts`
- `src/reflection/speculative-test-runner.ts`
- `src/reflection/flaky-score.ts`
- `src/reflection/function-explainer.ts`

---

## C.2 Phase C1 - Idle Reflection Scheduling

### Step-by-step
1. Define “idle” windows from channel/gateway activity.
2. Schedule bounded reflection tasks during idle windows.
3. Store findings in decision journal + observation store.
4. Queue actionable suggestions via orchestrator with budgets.

### Success criteria
- [ ] Reflection runs only during idle windows and within CPU budget.
- [ ] Findings are persisted and surfaced on user return.

### Guardrails
- [ ] Reflection tasks auto-cancel on user activity spike.
- [ ] Strict max-runtime per reflection job.

---

## C.3 Phase C2 - Speculative Flakiness Detection

### Step-by-step
1. Select candidate tests based on recent changes and historical failures.
2. Run repeated, low-priority test passes to estimate flakiness score.
3. Persist flaky candidates with confidence and suggested next actions.
4. Present concise queued recommendation (not noisy stream).

### Success criteria
- [ ] Flaky tests are detected and ranked with evidence.
- [ ] Suggestions are actionable and linked to changed modules.

### Guardrails
- [ ] Reflection test runs never block primary user turns.
- [ ] Resource throttling prevents background starvation.

---

## C.4 Phase C3 - Proactive Documentation / Function Explainability

### Step-by-step
1. Detect struggle signals:
   - repeated opens/jumps on same function
   - repeated errors in same symbol
2. Generate function explainer:
   - purpose, side effects, callers, change history summary
3. Deliver via low-noise proactive intent with cooldown.

### Success criteria
- [ ] Complex function explanations can be surfaced autonomously.
- [ ] Explanations include side effects + historical context.

### Guardrails
- [ ] Cooldown enforcement to prevent spam.
- [ ] Explanations must include provenance links and confidence labels.

---

## 7) Workstream D: Reasoning Reset Trigger + Confidence Scoring

## D.1 Target Architecture

Extend current failure-loop logic into assumption-reset pipeline:

- Iteration counter per task
- Forced deep scan of recently touched files
- Confidence score attached to each major action
- Human hint request gate below threshold

### New components
- `src/reliability/reasoning-reset.ts`
- `src/reliability/deep-scan.ts`
- `src/reliability/confidence-model.ts`
- `src/reliability/action-envelope.ts`

---

## D.2 Phase D1 - Reasoning Reset Trigger

### Step-by-step
1. Add task iteration tracking (not only identical signature loops).
2. Trigger reset at configurable threshold (default 3 iterations).
3. On reset:
   - invalidate stale hypotheses
   - require updated root-cause candidates
4. Log reset events to decision journal.

### Success criteria
- [ ] After 3 failed iterations, stale assumptions are invalidated automatically.
- [ ] Reset events are visible in runtime diagnostics and journal.

### Guardrails
- [ ] Reset logic cannot trigger recursively in tight loop.
- [ ] Existing successful fast-path fixes remain unaffected.

---

## D.3 Phase D2 - 24h Deep Scan of Touched Files

### Step-by-step
1. Build touched-file set from:
   - git history (last 24h)
   - runtime tool/edit events
2. Expand scan scope to include config/env/build files.
3. Inject scan findings as high-priority context for next iteration.

### Success criteria
- [ ] Reset includes files previously considered irrelevant.
- [ ] Config/environment root causes are surfaced in candidate set.

### Guardrails
- [ ] Deep scan bounded by file-count and time budget.
- [ ] Ignore lists and secret-file protections still enforced.

---

## D.4 Phase D3 - Confidence Score + Human Hint Gate

### Step-by-step
1. Define confidence model inputs:
   - evidence quality
   - test pass/fail trend
   - hypothesis divergence
   - edit impact radius
2. Attach `confidenceScore` (0-100) to each action envelope.
3. If score < 60:
   - pause autonomous fix loop
   - issue structured hint request to human

### Success criteria
- [ ] Every major action emits a confidence score.
- [ ] Low-confidence actions trigger human-hint pause instead of token burn loops.

### Guardrails
- [ ] Confidence score must include rationale payload (not opaque number).
- [ ] Low-confidence bypass attempts are denied by policy.

---

## 8) Quality, Security, and Reliability Guardrail Matrix

### 8.1 Required test suites (new/expanded)
- [ ] Context drift long-session regression tests
- [ ] Semantic retrieval precision/recall golden tests
- [ ] Multi-workspace indexing integration tests
- [ ] Network trace scrubbing and payload cap tests
- [ ] Idle reflection resource-throttling tests
- [ ] Confidence-gate / hint-request workflow tests

### 8.2 Security guardrails
- [ ] Secret scrubbing applies to embeddings, summaries, and trace payloads.
- [ ] Workspace traversal obeys deny lists and permission boundaries.
- [ ] Trace capture is explicit opt-in and localhost-limited by policy.
- [ ] MCP/workspace tools retain capability approval enforcement.

### 8.3 Reliability guardrails
- [ ] Deep scan and reset flows are bounded and idempotent.
- [ ] Background reflection cannot starve foreground turns.
- [ ] Checkpoint rollback remains available for risky multi-file operations.

---

## 9) Delivery Plan (Recommended Sequence)

1. **A1-A3** (context compression + semantic retrieval)  
2. **B1-B3** (multi-repo + tracing)  
3. **C1-C3** (intuition/background reflection)  
4. **D1-D3** (reasoning reset + confidence gate)  
5. **Hardening pass** (security/perf/SLO validation)

This order prioritizes prompt correctness and distributed observability before increasing autonomous behavior.

---

## 10) Exit Criteria (Program-Level)

The initiative is complete when all are true:

- [ ] Prompt context is semantic Top-K driven with measurable token drift reduction.
- [ ] Cross-repo root-cause hypotheses are generated and validated in multi-root workspaces.
- [ ] Localhost trace evidence is available for debugging with strict privacy controls.
- [ ] Idle-time reflection produces useful low-noise suggestions and flaky-test detections.
- [ ] After 3 failed iterations, assumption reset + deep scan reliably broadens diagnosis.
- [ ] All major actions include confidence score and low-confidence hint handoff behavior.
- [ ] Full build/test/security gates remain green with no critical regressions.

