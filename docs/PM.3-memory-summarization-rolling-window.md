# PM.3 — Optional summarization or rolling window for MEMORY.md

**Status:** Open (implementation guide).  
**Goal:** Keep MEMORY.md bounded so session-start injection stays effective without losing important long-term facts (optionally with vector recall as backup).

## Context

- MEMORY.md is append-only; see `src/memory.ts` and `docs/memory.md`.
- Session-start injection caps total size (`continuity.sessionMemoryCap`); excess is truncated ("dumb zone"). `getMemorySubstrateSize` and the heartbeat checklist already warn when near/over cap and suggest summarization or compaction.
- When `continuity.memoryEmbeddingsEnabled` is true, `recall_memory` can still find old content even when MEMORY.md is truncated.

## Success criteria

1. **Configurable policy:** At least one of (a) rolling-window max lines/bytes for MEMORY.md, or (b) optional summarization trigger when size exceeds a threshold. Default: off (current append-only behavior).
2. **Rolling window (if implemented):** When enabled, oldest records are dropped or moved (e.g. to an archive file or compacted block) so MEMORY.md stays under a configured limit. Preserve line format and IDs for records that remain; document archive location/format if used.
3. **Summarization (if implemented):** When enabled and over threshold, agent or background job can replace a range of old records with a single compaction/summary record (category e.g. `compaction`), keeping recent and high-value records (e.g. `note`, `user-preference`) intact. No mandatory LLM call in hot path; optional tool or cron for agent to run.
4. **Guardrails:** No automatic deletion of records without config opt-in. If embeddings are enabled, consider re-indexing or pruning `tmp/memory-embeddings.json` when MEMORY.md is rewritten.
5. **Tests:** Unit or integration tests for the new behavior; existing memory tests and session-memory injection tests still pass.

## Implementation options (pick one or combine)

- **A. Rolling window:** Config `continuity.memoryMaxRecords` or `memoryMaxChars`. On append (or a periodic task), if over limit, trim oldest lines from MEMORY.md (and optionally append them to `memory/archive/` or a single `MEMORY-archive.md`). Update daily files only for current day; do not rewrite old daily files.
- **B. Summarization trigger:** Config `continuity.memorySummarizeOverChars`. When heartbeat or a tool detects size > threshold, expose a tool (e.g. `compact_memory`) that the agent can call to summarize old turn-summary lines into one or more compaction records, then rewrite MEMORY.md with recent + summary. Embedding index should be refreshed after rewrite.
- **C. Hybrid:** Rolling window for hard cap + optional agent-triggered summarization for middle-aged content.

## Guardrails

- Do not change `readAll()` / `append()` contract for callers that assume append-only unless we explicitly version the store.
- Keep `flushPreCompaction` and integrity scan behavior consistent (e.g. compaction records remain valid).
- Document new config in `docs/configuration-reference.md` and `docs/memory.md`.

## Files to touch (likely)

- `src/config.ts` — new options (e.g. `memoryMaxRecords`, `memorySummarizeOverChars`), default off.
- `src/memory.ts` — optional trim/summarization logic or call into a new `src/continuity/memory-compaction.ts`.
- `src/continuity/memory-embedding-index.ts` — re-sync or prune when MEMORY.md is rewritten.
- Gateway/RPC: if a `compact_memory` tool is added, wire it main-session only and require confirmation or config.
- Tests: new file e.g. `tests/memory-compaction.test.ts` or extend `tests/session-memory.test.ts`.
