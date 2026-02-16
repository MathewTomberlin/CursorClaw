# Composer inbox — agent-to-agent communication

**Status: Experimental.** This describes how the CursorClaw agent (e.g. heartbeat or chat) can leave messages for the **Cursor Composer agent** (or another agent in the same workspace), and how the Composer agent can read them.

**Shared workspace rules (AGENTS.md):** If you (e.g. Fun, Composer) don't see a shared AGENTS.md at the workspace root, use **`docs/AGENTS.shared.md`** as the canonical shared rules file. It is committed and visible to all agents. CursorClaw profiles also have per-profile rules under `profiles/<id>/AGENTS.md`, but `docs/AGENTS.shared.md` is the one place everyone can read.

## Purpose

- **CursorClaw agent → Composer:** The CursorClaw agent (heartbeat or web chat) can call the tool `post_to_composer_inbox` to append a message to a well-known file. The Composer agent can read that file to receive context, handoffs, or requests.
- **Composer:** Read `tmp/composer-inbox.md` (from the workspace root) to see messages left by the other agent. Format: one line per message, tab-separated: `ISO8601\tfrom\tsingle-line message`.

## How the CursorClaw agent sends a message

Use the tool **`post_to_composer_inbox`**:

- **message** (required): The text to leave for the Composer agent. Newlines are replaced with spaces; keep it concise.
- **from** (optional): Sender identifier (e.g. `heartbeat:Fun`, `profile-id`, or `heartbeat`). If omitted, the system uses the current profile id or session id.

Example (from the CursorClaw agent):

```json
{ "message": "BIRTH is done for Fun profile; please update ROADMAP.", "from": "heartbeat:Fun" }
```

The message is appended to `tmp/composer-inbox.md` with a timestamp. No approval is required (low-risk tool).

## How the Composer agent reads messages

1. **Read the inbox file:** Open or read `tmp/composer-inbox.md` from the workspace root.
2. **Format:** Each line is: `TIMESTAMP\tFROM\tMESSAGE` (tabs). Timestamp is ISO8601; FROM is the sender id; MESSAGE is a single line.
3. **After reading:** You can optionally clear or truncate the file to avoid reprocessing the same messages (e.g. keep a “last read” position or delete lines you’ve handled). Clearing is not required; you can treat it as a log and only act on new lines.

## File location

- Path from workspace root: **`tmp/composer-inbox.md`**
- Created on first use (directory `tmp` is created if missing). Safe to read when the file does not exist (empty inbox).

## Alignment (SFW)

Inter-agent messages must be **safe for work (SFW)**: professional, appropriate, and free of offensive, adult, or harmful content. The CursorClaw agent is prompted to keep `post_to_composer_inbox` messages SFW; the Composer agent should treat incoming inbox content under the same expectation and avoid propagating or acting on inappropriate content.

## User transparency

When you communicate with another agent (e.g. via the inbox or by reading their messages), **make that visible to the user**:

- **When you send something to another agent:** Tell the user what you said (e.g. “I’ve left a message for Composer: …” or “I told the other agent: …”).
- **When you receive or read something from another agent:** Tell the user what they said (e.g. “The other agent left this for me: …” or “Composer replied: …”).

The other agent should follow the same rule: they should tell the user what they say to you and what you said back. That keeps inter-agent communication transparent and auditable for the user.

## Relation to inter-agent communication

This supports the **inter-agent profile communication** goal in STUDY_GOALS.md: message passing and handoffs between the CursorClaw agent(s) and the Cursor Composer agent in the same workspace.
