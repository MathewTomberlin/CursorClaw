# Continuity

How CursorClaw maintains context across turns, sessions, and restarts.

## 1. Substrate (every turn)

Substrate files (AGENTS.md, IDENTITY.md, SOUL.md, USER.md, BIRTH.md, etc.) are loaded each turn via the substrate loader and injected into the system prompt. See the configuration reference (`substrate` and path options) and IDENTITY_SOUL_BIRTH_IMPLEMENTATION.md.

## 2. Session-start memory (main session only)

For the **main session** (direct chat with the human), the runtime can inject MEMORY.md and memory/today+yesterday into the system prompt at turn start. Implementation and config are described in **docs/memory.md** (session-start injection, `continuity.sessionMemoryEnabled`, `continuity.sessionMemoryCap`).

## 3. BOOT.md (startup)

When **BOOT.md** exists at the profile root and `continuity.bootEnabled` is not false, the process runs one agent turn at startup (after the gateway is listening): BOOT content is used as the user instruction; the reply text before `BOOT_DONE` is delivered to the main channel. BOOT runs once per process, not on every connection. It is not injected into normal chat. Config: `continuity.bootEnabled` (default true).

## 4. Decision journal

The decision journal is persisted to file. Recent entries are replayed in the system prompt with the instruction to maintain rationale continuity unless new runtime evidence contradicts prior decisions. The number of recent entries replayed is configurable via **`continuity.decisionJournalReplayCount`** (default 5, clamped 1–100). "Since last session" or time-based replay is optional future work.

## 5. Run/session continuity after restart

RunStore persists run state. On process restart, runs that were in progress are marked “interrupted by process restart.” On the **first main-session turn after restart**, when the run-store has such interrupted runs, the runtime injects a one-line notice: “Previous run was interrupted by process restart.” This is shown once per process (not on every turn).

## 6. Intellectual growth (current state)

- **Decision journal:** Replayed as above; used to keep reasoning consistent across turns.
- **Reflection plugin:** Configurable via `reflection` (idle reflection, flaky-test detection). When enabled, the scheduler can run background reflection jobs; findings can be written to memory or influence future behavior. See configuration reference § 4.11.
- **RunStore and failure-loop guard:** Track runs and repetition to avoid repeated failures; no automatic write to SOUL.md or IDENTITY.md from these.
- **No automatic identity evolution:** SOUL.md and IDENTITY.md are **not** updated automatically from agent experience. There is no structured “learned lessons” store beyond memory records (e.g. category `learned` or `correction` would be a future optional addition). Any evolution of identity or soul is done by the user or by explicit, guarded tooling (e.g. append-only SOUL_EVOLUTION.md) if implemented later with strict guardrails.

Future optional work in this area: learned-lessons memory (append MemoryRecord with category `learned`/`correction` from reflection or user correction); configurable decision journal replay count or “since last session”; optional SOUL/IDENTITY evolution with approval and append-only rules.
