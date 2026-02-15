# IG.2 — Learned-lessons memory (implementation guide)

## Status

**Implementation guide ready.** Optional feature: allow the agent to store "learned lessons" (patterns, corrections, how-to) in long-term memory under a dedicated category so they can be recalled and reused.

## Goal

When the agent infers a lesson from feedback, a mistake, or a repeated pattern (e.g. "always run tests before pushing", "Operator prefers summaries in bullet form"), it should be able to store it in MEMORY.md under a category such as `learned`. This reuses the existing `remember_this` flow and MemoryStore; the only change is to recognize and document the `learned` category and nudge the agent to use it when appropriate.

## Success criteria

- [ ] **Category**: Memory records with category `learned` are accepted and stored like other categories (no schema change; category is already a free-form string in `MemoryRecord`).
- [ ] **Tool**: `remember_this` tool schema and description mention `learned` as an optional category (e.g. "E.g. note, user-preference, decision, learned").
- [ ] **Substrate / prompt**: Substrate or system instructions include a short guideline: when the agent infers a lesson (from correction, feedback, or pattern), it may use `remember_this` with category `learned` to persist it.
- [ ] **Recall**: When `recall_memory` is enabled, queries can return `learned` entries like any other category (no code change needed; category is already on records).
- [ ] **Rolling window**: If rolling window is enabled, `learned` entries are trimmed by age/position like other records unless we add a future "protect category" option (out of scope for IG.2).

## Implementation summary

1. **Tool schema** (`src/tools.ts` — `createRememberThisTool`): In the `category` property description, add `learned` to the examples: e.g. "Optional category (default: note). E.g. note, user-preference, decision, learned". No validation change; category remains a string.
2. **Tool description** (optional): Extend the tool description by one phrase, e.g. "Use category 'learned' when storing a lesson inferred from feedback or a repeated pattern."
3. **Substrate** (`src/substrate/defaults.ts` or profile substrate): Add one line to the memory/behavior section, e.g. "When you infer a lesson from feedback or a repeated pattern (e.g. how the operator likes things done), you may store it with remember_this and category 'learned'."
4. **Docs**: Update `docs/memory.md` section 6 (or categories list) to mention `learned` among example categories.

No new APIs, no new config, no change to MemoryStore or rolling-window logic. Optional: in a future tick, consider a config or rolling-window option to "never trim category learned" (not part of IG.2).

## Guardrails

- **No auto-labeling**: The agent decides when to use `learned`; we do not automatically tag any record as learned. This keeps the change minimal and avoids misclassification.
- **Same sensitivity and provenance**: `learned` entries use the same sensitivity and provenance as other `remember_this` entries; operator can mark sensitivity as usual.
- **No extra retention**: Unless we add a later "protect learned" option, rolling window and trimming treat `learned` like any other category. If the operator wants certain lessons to survive trimming, they can move them to USER.md or a note in substrate.

## Out of scope

- Automatic extraction of "lessons" from turn content.
- Separate file or section for learned items (everything stays in MEMORY.md).
- IG.3 (decision journal replay count) or IG.4 (SOUL/IDENTITY evolution).

## Verification

- Run existing tests: `npm test` (memory, recall, remember_this flows).
- Manually: In main session, call `remember_this` with `category: "learned"` and confirm the record appears in MEMORY.md with that category and is returned by `readAll` / session injection; if embeddings enabled, `recall_memory` returns it for a matching query.
