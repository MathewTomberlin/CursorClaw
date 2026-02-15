# PM.4 Optional vector recall — implementation note

**Status:** PM.4 is satisfied by the existing implementation. No code changes required.

## What PM.4 asked for

Optional vector recall: the ability to retrieve memory by semantic similarity (e.g. natural-language query) without loading the full MEMORY.md, and to keep the vector index consistent when memory is trimmed (rolling window).

## How it is satisfied

1. **Config:** `continuity.memoryEmbeddingsEnabled` (default `false`) turns on the memory embedding index and the `recall_memory` tool for the main session.

2. **Index:** When enabled, a **memory embedding index** is maintained at `tmp/memory-embeddings.json` (under the profile). It stores hash-based vectors over record text; size is capped by `continuity.memoryEmbeddingsMaxRecords` (default 3000).

3. **Tool:** The **recall_memory** tool is available in the main session only. The agent can query by natural language and receive top-k relevant memory entries by similarity. Records are synced into the index when recall runs; no separate background sync is required.

4. **Rolling-window re-sync:** When a rolling window is configured (`continuity.memoryMaxRecords` or `continuity.memoryMaxChars`), MEMORY.md is trimmed after append. The store invokes `onTrim` after a trim; the runtime uses it to re-sync the memory embedding index so the index stays consistent with the trimmed MEMORY.md.

## References

- **docs/memory.md** §2 (rolling window and re-sync), §5 (optional vector recall), §7 (rolling window config).
- **Config:** `continuity.memoryEmbeddingsEnabled`, `continuity.memoryEmbeddingsMaxRecords`.
- **Code:** `src/continuity/memory-embedding-index.ts`, `src/tools.ts` (`recall_memory`), `src/index.ts` (onTrim → re-sync), `src/memory.ts` (RollingWindowOptions.onTrim).
