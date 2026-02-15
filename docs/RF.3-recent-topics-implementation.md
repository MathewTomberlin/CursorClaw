# RF.3 — Recent topics with this user (implementation guide)

## Status

**Implemented.** Optional "recent topics" injection is available. Enable with `continuity.includeRecentTopics: true` in config. Storage: `{profileRoot}/tmp/recent-topics.json`; prompt block "Recent topics (with this user):" in main-session system prompt when enabled.

## Success criteria

- When enabled, the main-session system prompt includes a small "Recent topics (with this user):" block listing the last N conversation starters (e.g. first user message per session or per thread), truncated.
- Storage is per-profile, under profile root (e.g. `tmp/recent-topics.json`). No new config paths; optional feature flag in config.
- Backward compatible: off by default; when disabled, no file I/O and no prompt injection.
- Privacy: only content the user already sent in this workspace is shown; cap length and count to avoid token blow-up.

## Implementation summary

1. **Recent-topics store** (new module, e.g. `src/continuity/recent-topics.ts`):
   - File: `{profileRoot}/tmp/recent-topics.json`. Structure: `{ entries: Array<{ sessionId: string; topic: string; at: string }> }`.
   - `appendTopic(profileRoot, sessionId, topic)` — push entry (topic = first 80–100 chars of first user message, trimmed); keep last 10 entries; persist.
   - `loadRecentTopicsContext(profileRoot, options?: { maxEntries?: number; maxChars?: number })` — return formatted string for prompt (e.g. "1. …\n2. …") or `undefined` if empty. Cap total chars (e.g. 800).

2. **When to record a topic:** In the runtime or gateway, when the first user message in a session is processed, call `appendTopic(profileRoot, sessionId, firstUserMessageContent.slice(0, 100).trim())`. Optionally dedupe by sessionId (update existing entry for this session instead of appending a duplicate).

3. **Runtime** (`src/runtime.ts`):
   - New option: `getRecentTopicsContext?: (profileRoot: string) => Promise<string | undefined>`.
   - In the system-prompt build (main session only), after session memory, if `getRecentTopicsContext` is set and config has the feature enabled, call it and append a system message: `Recent topics (with this user):\n\n${content}` (scrub if needed).

4. **Config** (`src/config.ts`):
   - Add optional `memory?.includeRecentTopics?: boolean` (default `false`). When `true`, wire `getRecentTopicsContext` in index to the new loader.

5. **Wiring** (`src/index.ts`):
   - When building profile context, if `config.memory?.includeRecentTopics === true`, pass `getRecentTopicsContext: (profileRoot) => loadRecentTopicsContext(profileRoot)` into the runtime. Ensure profile root is available (same as session memory).

6. **First-user-message detection:** The runtime sees each request; the first user message for a given `sessionId` can be detected by tracking "we've already recorded a topic for this session" (e.g. in-memory set or by checking if current thread has exactly one user message when we're about to add the second). Simplest: when building the turn, if the thread has messages and the last user message is the first in the thread, call `appendTopic` once (idempotent per session: overwrite or skip if that sessionId already has an entry in the last 10).

## Guardrails

- Topic text is scrubbed with the same scope as other user content if needed.
- File under `tmp/` so it's clear it's ephemeral/cache; exclude from backups if desired.
- No cross-profile leakage: key by profileRoot.

## Optional follow-ups

- Limit to "sessions started in the last 7 days" to avoid stale topics.
- Allow config: `maxRecentTopics: number` and `maxRecentTopicsChars: number`.

## Completed

Implemented 2026-02-15: `src/continuity/recent-topics.ts`, config `continuity.includeRecentTopics`, runtime injection and first-user-message recording. Removed from HEARTBEAT.md optional list.
