# Long-Term Memory Compaction, LONGMEMORY.md, and Vector Experience Store — Implementation Guide

**Status:** Implemented.  
**Goal:** Limit MEMORY.md growth without truncation-only; maintain rich long-term memory via intelligent summarization, a LONGMEMORY.md summary file, and a local vector experience store that can be queried (manually and automatically) for richer context and relationship-building.

**Implementation note:** The experience store uses a file-based, hash-based vector store (same approach as the memory embedding index) for portability. Chroma can be integrated later as an optional backend when a local Chroma server or embedded bindings are used.

---

## 1. Context (current behavior)

- **MEMORY.md**: Append-only; optional rolling window trims oldest by count/chars; session-start injection caps at `sessionMemoryCap` (truncation = "dumb zone").
- **Session memory**: `loadSessionMemoryContext()` loads MEMORY.md + memory/today + memory/yesterday; capped; injected into main-session system prompt.
- **Memory embedding index**: Hash-based vectors in `tmp/memory-embeddings.json`; `recall_memory` tool for semantic recall; re-synced after trim.
- **No LONGMEMORY.md**: No dedicated long-term summary file.
- **No Chroma**: No local vector DB for experiences; no experience-uniqueness or relationship-style retrieval.

---

## 2. Requirements (from user)

1. **Scheduled compaction/summarization**: MEMORY.md automatically summarized/compacted on a schedule, using an agent/job that **does not block** running agent-profile agents (heartbeat, user turns).
2. **Size control**: Keep memory within a target size while maintaining **rich long-term memory** (no truncation-only).
3. **LONGMEMORY.md**: Optional file holding summary/summaries from MEMORY for long-term retention.
4. **Chroma vector DB**: Local Chroma store for **experiences** and memories.
5. **Scheduled experience extraction**: On a schedule (e.g. same as compaction), add **key experiences that are relatively unique** among stored vector DB experiences to Chroma.
6. **Query and auto-injection**: (a) Agent can **manually query** the vector DB via a tool; (b) **Automatically** query (substrate-style) to enhance agent memory/experiences, possibly for relationship patterns or graphs.
7. **Guardrails**: No regressions; limit broken code or feature failures.

---

## 3. Step-by-step implementation plan

### Phase A: Configuration and compaction trigger

| Step | Description |
|------|-------------|
| A.1 | Add config under `continuity`: `memoryCompactionEnabled` (boolean, default false), `memoryCompactionScheduleCron` (optional cron, e.g. `0 3 * * *` for 3am daily) or `memoryCompactionIntervalMs` (fallback interval), `memoryCompactionMaxRecords` / `memoryCompactionMaxChars` (target caps for MEMORY.md after compaction), `longMemoryPath` (e.g. `LONGMEMORY.md`), `memoryCompactionMinAgeDays` (only compact records older than N days). |
| A.2 | Document new keys in `docs/configuration-reference.md` and `docs/memory.md`. |

### Phase B: Non-blocking scheduled compaction and LONGMEMORY.md

| Step | Description |
|------|-------------|
| B.1 | Add **compaction job** that runs on schedule (cron or interval). Job must **not** use the main turn queue or block heartbeat/user sessions: run in a `setTimeout`/`setInterval` (or cron tick) callback; use a **lock file** (`tmp/memory-compaction.lock`) so only one compaction runs at a time; if lock is held, skip and log. |
| B.2 | Compaction logic (new module e.g. `src/continuity/memory-compaction.ts`): (1) Check config enabled and threshold (e.g. record count or chars over limit). (2) Acquire lock; (2b) `flushPreCompaction` if configured. (3) Read MEMORY.md; parse records; split into "to compact" (e.g. turn-summary, note older than `memoryCompactionMinAgeDays`) and "keep as-is" (recent, high-value categories like learned, user-preference). (4) Produce one or more **compaction records** (category `compaction`, text = summarized or merged content). (5) **Rule-based summarization first**: merge old turn-summary lines into a single compaction block (no LLM required for MVP). (6) Write new MEMORY.md = header + compaction record(s) + kept records. (7) **LONGMEMORY.md**: Append or write a "Long-term summary" section (e.g. the compaction summary text) so LONGMEMORY.md holds historical summaries; cap LONGMEMORY.md size (e.g. max chars) by trimming oldest summary blocks if needed. (8) Optionally append trimmed records to archive if `memoryArchivePath` set. (9) Release lock; re-sync memory embedding index if enabled. |
| B.3 | Wire compaction job in `src/index.ts`: start scheduler when `memoryCompactionEnabled` and schedule present; pass profile roots and getMemoryStore so compaction runs per-profile (each profile has its own MEMORY.md and LONGMEMORY.md). |
| B.4 | **Session memory injection**: Extend `loadSessionMemoryContext()` to optionally prepend **LONGMEMORY.md** content (capped) so the agent sees "Long-term summary" first, then MEMORY.md + daily. Config: e.g. `continuity.includeLongMemoryInSession` (default true when LONGMEMORY exists). |

### Phase C: Chroma vector database for experiences

| Step | Description |
|------|-------------|
| C.1 | Add dependency: `chromadb` (Node client for Chroma). Add to `package.json`; ensure Chroma runs locally (persist to profile dir, e.g. `tmp/chroma` or configurable path). |
| C.2 | Create **experience store** module (e.g. `src/continuity/experience-store.ts`): (1) Initialize Chroma collection per profile (e.g. collection name `cursorclaw_experiences_{profileId}` or single default). (2) **Add experience**: id, text, metadata (category, sessionId, timestamp, recordId). (3) **Query**: semantic search by text/query; return top-k with scores. (4) **Uniqueness check**: before adding, query existing by embedding similarity; add only if similarity to nearest neighbor is below a threshold (e.g. 0.85) so "relatively unique" experiences are stored. (5) Persist Chroma DB under profile `tmp/chroma` (or config path). |
| C.3 | Config: `continuity.experienceStoreEnabled` (default false), `continuity.experienceStorePath` (optional, default `tmp/chroma`), `continuity.experienceUniquenessThreshold` (max similarity to consider "unique", default 0.85), `continuity.experienceMaxCount` (max experiences in Chroma per profile, default 5000). |

### Phase D: Scheduled experience extraction and tools

| Step | Description |
|------|-------------|
| D.1 | **Scheduled extraction**: Run on same schedule as compaction (or separate config). For each profile: (1) Read recent MEMORY records (e.g. since last run or last N). (2) For each candidate record (e.g. note, learned, turn-summary with sufficient length), compute embedding and check uniqueness against Chroma. (3) If unique enough, add to Chroma. (4) Enforce `experienceMaxCount` by evicting oldest or lowest-score if over cap. |
| D.2 | **Tool** `query_experiences`: Agent can call with `query` (string) and `topK` (number); returns top-k experiences from Chroma for the profile. Register only when `experienceStoreEnabled`; main session (and optionally heartbeat). |
| D.3 | **Auto-query (substrate-style)**: When `experienceStoreEnabled` and optional `continuity.injectExperienceContext` (default true), at main-session turn start: (1) Build a short "current focus" from last user message or recent topic. (2) Query Chroma with that focus for top-k (e.g. 5–10). (3) Inject a system block "Relevant past experiences:" with the results. This enhances memory without loading full MEMORY.md. |

### Phase E: Relationship patterns (optional for MVP)

| Step | Description |
|------|-------------|
| E.1 | Store metadata with each experience: sessionId, category, timestamp. Optional: entity hints (e.g. from simple regex or future NER). |
| E.2 | Tool or injection can group by category or session for "relationship" style summary (e.g. "Experiences about preferences: …"). Defer graph construction to a later iteration if needed. |

---

## 4. Success criteria checklist

- [x] **SC1** Config keys added and documented; compaction and experience store can be enabled/disabled without code change.
- [x] **SC2** Compaction job runs on schedule and does **not** block user turns or heartbeat (runs in background; lock file prevents concurrent compaction).
- [x] **SC3** After compaction: MEMORY.md is under target size; LONGMEMORY.md exists and contains at least one summary block; no recent or high-value records removed; memory embedding index re-synced when enabled.
- [x] **SC4** Session memory injection includes LONGMEMORY.md (when present and config enabled) before MEMORY.md + daily, within existing cap.
- [x] **SC5** Experience store: add, query, and uniqueness check work; experiences persist across process restarts (JSON under profile tmp).
- [x] **SC6** Scheduled experience extraction adds only relatively unique experiences; `query_experiences` tool returns relevant results for main/heartbeat session.
- [x] **SC7** Optional auto-injection: main-session system prompt includes "Relevant past experiences" when enabled.
- [x] **SC8** All existing memory tests pass; new tests for compaction (lock, no block), LONGMEMORY inclusion, and experience store (add/query/uniqueness).

---

## 5. Guardrails

1. **No blocking**: Compaction and experience extraction must never run in the same queue as user/heartbeat turns. Use background timers and lock file only.
2. **Lock file**: Always release `tmp/memory-compaction.lock` in a `finally` block so crash does not leave lock held.
3. **MEMORY.md integrity**: Before rewriting MEMORY.md, write to a temp file and rename; on failure, restore from backup if available.
4. **Scope**: Compaction rewrites **MEMORY.md only**; do not modify `memory/YYYY-MM-DD.md` daily files.
5. **Profile scope**: Compaction and Chroma are per-profile (each profile has its own MEMORY, LONGMEMORY, and Chroma collection/path).
6. **Backward compatibility**: When compaction or experience store is disabled, behavior matches current code (no new files created; session memory unchanged).
7. **Config defaults**: All new features default **off** (compaction, experience store, LONGMEMORY injection) so existing deployments are unchanged.
8. **Tests**: Existing tests (memory rolling window, session memory, recall_memory, heartbeat) must remain passing; add tests for new code paths.
9. **Documentation**: Update `docs/memory.md`, `docs/configuration-reference.md`, and any runbook that references memory.

---

## 6. Files to touch (summary)

| Area | Files |
|------|--------|
| Config | `src/config.ts` (new continuity options) |
| Compaction | `src/continuity/memory-compaction.ts` (new), `src/continuity/session-memory.ts` (LONGMEMORY in loadSessionMemoryContext) |
| Scheduler | `src/scheduler.ts` or new `src/continuity/compaction-scheduler.ts`; `src/index.ts` (wire job, pass stores) |
| Chroma | `src/continuity/experience-store.ts` (new), `package.json` (chromadb) |
| Tools | `src/tools.ts` (query_experiences), `src/index.ts` (register tool, optional auto-inject) |
| Runtime | `src/runtime.ts` or index (getSessionMemoryContext already loads memory; ensure LONGMEMORY is part of that load) |
| Docs | `docs/configuration-reference.md`, `docs/memory.md` |
| Tests | `tests/memory-compaction.test.ts`, `tests/experience-store.test.ts`, `tests/session-memory.test.ts` (extend for LONGMEMORY) |

---

## 7. Implementation order

1. **Config + compaction module + lock + LONGMEMORY write** (Phases A, B.1–B.3, B.4 for write only).
2. **Session memory load LONGMEMORY** (Phase B.4).
3. **Chroma experience store** (Phase C).
4. **Scheduled extraction + query_experiences tool + auto-inject** (Phase D).
5. **Tests and docs** (Phase E optional; success criteria and guardrails throughout).

Once this document is complete, implement in the order above and validate against the success criteria and guardrails.
