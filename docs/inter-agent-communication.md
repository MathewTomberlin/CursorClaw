# Inter-agent profile communication — implementation guide (stub)

*Context: STUDY_GOALS — Inter-agent profile communication. Enable agent profiles running in different heartbeats to communicate and work together.*

## Scope

- **Goal**: Allow two or more CursorClaw profiles (e.g. default and Fun) to exchange messages, share state, or hand off work when running in separate heartbeat/scheduler ticks.
- **Out of scope (for now)**: Same-process single-thread coordination; that is already implicit. Focus on cross-tick / cross-profile communication.

## Patterns (from research notes)

- **Message-passing**: Pub/sub (broadcast or topic-based), RPC (request–response between profiles), or shared mailbox (queue per profile or shared).
- **Handoff protocols**: Explicit handoff token, state snapshot transfer, or rendezvous point (shared endpoint; one profile publishes state, the other consumes when ready).

## Chosen pattern: file-based mailbox per profile

- **Rationale**: No new process or gateway dependency; works across ticks and restarts; each profile has a well-known path under its profile root; easy to inspect and debug.
- **Layout**: Under profile root, e.g. `profiles/<profileId>/mailbox/inbox/` for incoming messages and optionally `mailbox/outbox/` for sent (or outbox omitted if not needed). Sender writes into the **recipient profile’s** inbox directory (one file per message or one append-only file; see envelope below).
- **Lifecycle**: Writer creates a message file (or appends); reader (receiving profile’s runtime) reads and processes at start of its tick, then deletes or moves to `processed/` to avoid re-delivery. Retention: optional max age or max count per inbox; oldest or oldest-by-file deleted when over limit.

## Message envelope (format and retention)

- **Envelope** (JSON, one file per message recommended for simple FIFO and safe concurrent read/delete):
  - `id`: string (UUID or unique id).
  - `from`: string (sender profile id or "system").
  - `to`: string (recipient profile id).
  - `at`: string (ISO 8601 timestamp).
  - `type`: string (e.g. `note`, `handoff`, `request`, `response`).
  - `payload`: object (opaque; schema by `type` if needed).
  - Optional: `replyTo`: string (message id) for request/response correlation.
- **Storage**: One file per message under `profiles/<to>/mailbox/inbox/<id>.json` (or `<at>-<id>.json` for sort order). Retention: configurable max files in inbox and/or max age; trim oldest when over limit.

## Success criteria

- [x] Chosen pattern(s) documented with data format and lifecycle.
- [x] Mechanism for profile A to send a message or state to profile B that runs in a different tick (file-based mailbox; sendMessage writes to recipient inbox; receiveMessages runs at start of recipient's heartbeat and injects pending messages into content).
- [x] No regression to existing single-profile behavior; optional feature behind config (`heartbeat.interAgentMailbox`, default false).

## Implementation checklist (for step 3)

When implementing send/receive and heartbeat wiring:

1. **Mailbox dirs**: Ensure `profiles/<id>/mailbox/inbox/` (and optionally `processed/`) exist when profile loads or on first send to that profile.
2. **Send**: `sendMessage(recipientProfileId, envelope)` — write envelope as JSON to `profiles/<recipientProfileId>/mailbox/inbox/<id>.json` (or `<at>-<id>.json`); enforce retention (max files or max age) when writing or in a separate trim step.
3. **Receive**: At start of receiving profile’s tick, `receiveMessages(profileId)` — list inbox dir, read each file, return envelopes, then move files to `processed/` or delete to avoid re-delivery.
4. **Wire to scheduler/heartbeat**: Before building the turn payload for the profile, call `receiveMessages(profileId)` and inject pending messages into substrate or system prompt (e.g. “Pending inter-agent messages: …”) so the agent can act on them.
5. **Config**: Feature flag or config key (e.g. `interAgentMailbox: true`) so single-profile behavior is unchanged when disabled.

### API surface (for implementers)

- **Types**: `Envelope`: `{ id: string; from: string; to: string; at: string; type: string; payload: unknown; replyTo?: string }`.
- **Send**: `sendMessage(recipientProfileId: string, envelope: Envelope): Promise<void>` — write envelope as JSON to recipient’s inbox; ensure mailbox dirs exist; optionally enforce retention (trim oldest) after write.
- **Receive**: `receiveMessages(profileId: string): Promise<Envelope[]>` — list inbox, read each file, return envelopes, then move to `processed/` or delete so they are not delivered again. Caller (scheduler/heartbeat) is responsible for injecting returned envelopes into the turn content.

### Where to wire (scheduler/heartbeat)

- **File**: `src/index.ts`.
- **Function**: The async function that runs one heartbeat turn (the block that builds `instructionBody` and `content` for the heartbeat user message).
- **Injection point**: After the final `content` string is built (including BIRTH and interrupted prefixes) and before `runtime.runTurn({ ... messages: [{ role: "user", content }] })`.
- **Logic**: If config allows inter-agent mailbox (e.g. `interAgentMailbox: true`), call `receiveMessages(profileId)`. If the returned list is non-empty, append to `content` a section such as:  
  `\n\n**Pending inter-agent messages:**\n` plus a short, readable summary of each message (e.g. `from`, `type`, `payload` or a one-line summary). Then pass the updated `content` into `runTurn`. The agent will see pending messages in the same user message as the HEARTBEAT instructions and can act on them (reply, hand off, or acknowledge).

## Runbook: enabling and using inter-agent mailbox

- **Enable:** Set `heartbeat.interAgentMailbox: true` in config (or profile overrides). Default is `false` so single-profile behavior is unchanged.
- **Paths:** Each profile’s mailbox lives under its profile root: `profiles/<profileId>/mailbox/inbox/` (incoming) and `mailbox/processed/` (after read).
- **Sending (programmatic):** Use `sendMessage(recipientProfileRoot, envelope)` from `src/mailbox.ts`. The recipient is the **profile root path** (e.g. `profiles/Fun`). Envelope must include `id`, `from`, `to`, `at`, `type`, `payload`.
- **Receiving:** At each heartbeat tick, when inter-agent mailbox is enabled, the runtime calls `receiveMessages(profileRoot)`, injects pending messages into the user content, then the agent can act on them. Messages are moved to `processed/` so they are not delivered again.
- **Optional tool:** To let the agent send to other profiles from within a turn, expose `sendMessage` as a tool (e.g. `inter_agent_send`) that accepts recipient profile id and envelope fields; the runner resolves profile id to profile root and calls `sendMessage`.

## Next steps

1. ~~Choose primary pattern (e.g. file-based mailbox under profile root, or gateway RPC).~~
2. ~~Define message envelope and storage (path, format, retention).~~
3. ~~Implement send/receive in runtime or gateway; wire to scheduler/heartbeat~~ — done: `src/mailbox.ts` (receiveMessages, sendMessage, Envelope), `heartbeat.interAgentMailbox` in config, wiring in `src/index.ts` before runTurn.
4. ~~Add tests and update runbook.~~ — done: `tests/mailbox.test.ts` (receive empty, send/receive/move, invalid files, retention, multi); runbook above.

## References

- STUDY_GOALS.md — Inter-agent profile communication (research note).
- ROADMAP.md — Optional backlog for multi-profile work.
