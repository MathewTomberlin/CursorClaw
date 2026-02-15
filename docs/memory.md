# CursorClaw memory

How persistent memory and session-start context work.

## 1. Storage

- **MEMORY.md** (workspace root): Primary long-term memory file. Append-only list of `MemoryRecord` lines (JSON per line, prefixed with `- `). Created on first use if missing.
- **memory/YYYY-MM-DD.md**: Daily logs in the same line format. One file per calendar day; created when a record is appended that day.

Records have: `id`, `sessionId`, `category`, `text`, `provenance` (sourceChannel, confidence, timestamp, sensitivity). Categories include `turn-summary`, `compaction`, `note`, `heartbeat`, etc.

## 2. MemoryStore (runtime)

- **append(record)**: Writes the record to both MEMORY.md and today’s daily file.
- **readAll()**: Returns all records from MEMORY.md (parsed lines).
- **retrieveForSession({ sessionId, allowSecret })**: Filters readAll by session and optionally excludes `sensitivity: "secret"`.
- **flushPreCompaction(sessionId)**: Appends a compaction checkpoint before compaction runs.
- **integrityScan()**: Detects contradictions (same session+category, different text) and 120-day staleness; returns findings, does not auto-fix.

Memory grows append-only unless you edit or compact MEMORY.md manually. Optionally, when `continuity.memoryEmbeddingsEnabled` is true, a separate **memory embedding index** is maintained under `tmp/memory-embeddings.json` (hash-based vectors over record text), and the main session can use the **recall_memory** tool to query by semantic similarity without loading the full MEMORY.md. The code-context embedding index remains separate (for workspace/repo chunks only).

## 3. Session-start injection (main session only)

For the **main session** (direct chat with the human), the runtime can inject memory into the system prompt at the start of each turn:

- **Sources**: MEMORY.md plus `memory/YYYY-MM-DD.md` for **today** and **yesterday**.
- **Implementation**: `src/continuity/session-memory.ts` — `loadSessionMemoryContext(profileRoot, options?)`. Wired via runtime option `getSessionMemoryContext` and used in `buildMessages` when `isMainSession` and `profileRoot` are set.
- **Cap**: Total combined size is capped (default 32k characters); excess is truncated with a note.
- **When**: Only when the runtime is built with `getSessionMemoryContext` and `getProfileRoot`; main session only. Not injected in shared or other channels.
- **Config**: `continuity.sessionMemoryEnabled` (default `true`) — set to `false` to disable injection. `continuity.sessionMemoryCap` (default `32000`) — max characters injected; only used when session memory is enabled.

So the agent “sees” MEMORY.md and recent daily logs at session start without being told to “read the file.” Cap and enable/disable are configurable via `continuity.sessionMemoryCap` and `continuity.sessionMemoryEnabled`.

## 4. Gateway (UI)

The gateway exposes RPCs to read/write memory files so the UI can show and edit them. Allowed paths: `MEMORY.md` and `memory/YYYY-MM-DD.md`. Other paths are rejected.

## 5. Optional vector recall

When **continuity.memoryEmbeddingsEnabled** is true:

- A **memory embedding index** is kept under the profile at `tmp/memory-embeddings.json` (hash-based vectors over record text; max records set by `continuity.memoryEmbeddingsMaxRecords`, default 3000).
- The **recall_memory** tool is available in the main session only: the agent can query by natural language and receive top-k relevant memory entries by similarity. Records are synced into the index on each recall; no separate background sync.

See config reference for `continuity.memoryEmbeddingsEnabled` and `continuity.memoryEmbeddingsMaxRecords`.

## 6. Relationship and preferences

Relationship and preference context is **not** stored in a dedicated structured store. It lives in:

- **USER.md** (substrate): Who the human is, what to call them, timezone, pronouns, notes. Manually edited; loaded every turn in the main session.
- **MEMORY.md and memory/YYYY-MM-DD.md**: Turn summaries, notes, and any agent- or user-initiated “remember this” style content. For example, “Operator prefers X” in a turn summary or a memory record with category `note` or `user-preference` (if such categories are used) persists for future sessions.

The agent learns about the user only via manual USER.md edits and whatever gets appended to memory (e.g. preferences mentioned in turn summaries). There is no automatic dossier-building; scope is limited to what the user or agent explicitly records. Optional “remember this about me” flows (tool or prompt guidance) would write MemoryRecords; existing MemoryStore.append suffices for that.

## 7. Possible future improvements

- **Summarization / rolling window**: Keep MEMORY.md bounded (e.g. summarization or time-based window) instead of unbounded append.
- **Explicit remember flow**: Tool or prompt guidance for writing specific memories (retrieval is supported via recall_memory when vector index is enabled).
