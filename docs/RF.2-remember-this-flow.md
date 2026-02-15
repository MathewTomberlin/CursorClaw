# RF.2 — "Remember this" flow (implementation guide)

## Status

**Implemented.** The agent has a main-session-only tool `remember_this` that appends a structured record to long-term memory (MEMORY.md + daily file) via `MemoryStore.append`.

## Success criteria

- [x] When the user says "remember this: X" or "remember that I prefer Y", the agent can persist it without manual file edits.
- [x] Storage uses the existing MemoryStore (MEMORY.md + memory/YYYY-MM-DD.md) so records are available to session-start injection and (when enabled) to `recall_memory`.
- [x] Tool is restricted to the main web session; other channels get a clear error.
- [x] Optional category and sensitivity; defaults: `note`, `private-user`.

## Implementation summary

1. **ToolExecuteContext** (`src/types.ts`): Added optional `sessionId` so profile-scoped tools can tag records with the current session.
2. **Runtime** (`src/runtime.ts`): Passes `request.session.sessionId` into `toolContext` when executing tools.
3. **createRememberThisTool** (`src/tools.ts`): New tool that accepts `text` (required), optional `category` (default `note`), optional `sensitivity` (default `private-user`). Calls an injected `appendRecord` callback that maps to `MemoryStore.append`. Only runs when `channelKind === "web"` and `profileRoot` and `sessionId` are set.
4. **Registration** (`src/index.ts`): Registers `createRememberThisTool({ appendRecord: (record) => memory.append(record) })` so the single profile MemoryStore is used.

## Guardrails

- Tool is low-risk; no approval workflow beyond the existing tool-call path.
- Sensitivity is validated to one of `public`, `private-user`, `secret`, `operational`.
- No secrets or PII are specially handled beyond what the agent chooses to put in `text`; operator is responsible for not asking to remember secrets in plain text (substrate already says "Skip secrets unless asked to keep them").

## Optional follow-ups

- **Prompt nudging**: In substrate (e.g. AGENTS.md or Memory section), add a line: "When the user says 'remember this' or 'remember that', use the remember_this tool to store it."
- **UI**: Optional "Remember this" button or shortcut in the chat UI that pre-fills a prompt or triggers a tool call (out of scope for RF.2).

## Completed

RF.2 is done. Remove this file from the roadmap "open" list and add to "Completed" in ROADMAP.md.
