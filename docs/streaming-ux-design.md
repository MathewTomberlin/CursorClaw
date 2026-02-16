# Streaming UX: Replace-Then-Append Design

## User-facing design (what the user sees)

When the user sends a message or a heartbeat occurs, the agent runs a **thread of actions**. Each action may include:

- **Thinking** (depending on model)
- **Tool calls** or **formatted code** (depending on model)
- **Unformatted text or message**

Actions can chain (e.g. tool calls lead to further actions). Eventually a **Complete** signal is sent; then the **user-facing message** is output and shown in the message box.

**Visibility rules:**

| Content | Visible to user? |
|--------|-------------------|
| Thinking (any form) | **No** — never shown. |
| Tool calls, formatted code, and their tags | **No** — never shown. |
| Tags for thinking, tool calls, or code | **No** — never shown. |
| Text/message from actions **other than the final** | **Yes** — one at a time as a **streaming update that overwrites** the previous one. |
| When the **final** action of the thread completes | The streaming update area is **cleared**. |
| Message/text of the **final** action | **Yes** — displayed in the message box as the assistant reply (unless another signal sets the final user message for the thread, e.g. for certain models/CLIs). |

So from the user’s perspective: they see a single line of status or a single streaming reply that gets overwritten by the next, until the run completes; then the streaming area is cleared and only the final message remains in the thread. No thinking, no tool calls, no code blocks or tags.

---

## Goal

- **Thinking / pre-final phase:** Each new streaming or thinking event **replaces** the previous one so the user sees only the **latest** chunk (no accumulation). **User-facing:** thinking and tool/code are not shown at all; only a generic status or the latest reply text is shown.
- **Final message phase:** When the agent is streaming the **final** reply, content is **appended** so the user sees the message being written.
- **On completion:** Clear all streaming/thinking UI and show **only the final message** in the thread.

## Current Problem

- Streaming/thinking events are effectively accumulated or not clearly phased: the UI can show growing thinking text or mixed thinking + assistant without a clear transition.
- There is no explicit “final message started” signal, so the UI cannot switch from “replace-only” to “append” behavior.

## Event Semantics

| Phase | Event | Payload | UI behavior |
|-------|--------|---------|-------------|
| Pre-final | `thinking` | `{ content: string }` (delta only) | Replace `streamedThinkingContent` with `content` (show only latest chunk). |
| Transition | `final_message_start` | (none) | Clear `streamedThinkingContent`; switch to showing assistant stream only. |
| Final | `assistant` | `{ content: string, replace?: boolean }` | Set `streamedContent` to `content` (accumulated). Message grows as backend sends full content. |
| Done | `completed` | (optional payload) | Clear `streamedContent` and `streamedThinkingContent`; show only the final message in the thread. |

## Backend (Runtime)

1. **Thinking: delta-only**
   - Track `previousThinkingContent` (string) for the current turn.
   - On each `thinking_delta`: compute delta = if adapter sends accumulated, use `content.startsWith(previousThinkingContent) ? content.slice(previousThinkingContent.length) : content`; otherwise treat `content` as the new chunk (adapter may send per-chunk).
   - Emit `thinking` with `{ content: delta }`.
   - Update `previousThinkingContent` to the full content received (so next time we can compute the next delta). If the adapter sends only deltas, treat the received content as the “new chunk” and do not accumulate it into `previousThinkingContent` for length comparison—emit as-is and set `previousThinkingContent = ""` for next chunk so we don’t strip. Simpler: always compute “delta” as: if `content.startsWith(previousThinkingContent)`, then `delta = content.slice(previousThinkingContent.length)`; else `delta = content`. Then set `previousThinkingContent = content`. So if adapter sends "A", "AB", "ABC" we send "A", "B", "C". If adapter sends "A", "B", "C" we send "A", "B", "C" (content doesn’t start with previous so delta = content; then previous = "A", "B", "C" in turn—so next "B".startsWith("A") is false, delta = "B". Good.)

2. **Final message start**
   - Introduce a flag `finalMessageStartEmitted = false` at the start of the adapter stream loop.
   - On the **first** `assistant_delta` (when entering the `assistant_delta` branch), if `!finalMessageStartEmitted`, emit `final_message_start` (no payload), then set `finalMessageStartEmitted = true`.
   - No change to existing `assistant` emission logic: continue sending accumulated content with `replace: true` or full content as today.

3. **Types**
   - Add `"final_message_start"` to `RuntimeEventType` in `src/runtime.ts`.
   - Optionally add to `LifecycleEventType` in `src/types.ts` if the gateway/UI rely on it (UI will handle the new type by name).

## Gateway

- No change: the gateway forwards every lifecycle event from the runtime to the client. New event type `final_message_start` is sent as-is.

## Frontend (UI)

1. **ChatContext**
   - On SSE event with `type === "final_message_start"`: call `setStreamedThinkingContent("")` so the thinking block is cleared when we transition to the final message phase.
   - On `completed` (and in the existing `finally` that runs when the turn ends): ensure `streamedContent` and `streamedThinkingContent` are cleared (already done in `runTurn` cleanup).
   - No change to assistant handling: continue setting `streamedContent` to `payload.content` on `assistant` events (backend sends accumulated content, so the message grows).

2. **Chat.tsx**
   - No structural change: per user-facing design we do not show thinking; loading bubble shows only status (e.g. "Working…") or streaming reply (when `streamedThinkingContent` is set) or status; when `streamedContent` is set we show the streaming assistant bubble. Clearing thinking on `final_message_start` ensures we don’t clearing on `final_message_start` and `completed` as above.
   - Add `final_message_start` to `STATUS_EVENT_TYPES` and to `formatStreamEventLabel` (e.g. "Writing reply…") so the status line updates as soon as we transition to the final-message phase.

## Step-by-Step Implementation

1. **Runtime**
   - Add `"final_message_start"` to `RuntimeEventType`.
   - Before the adapter stream loop: `let previousThinkingContent = ""` and `let finalMessageStartEmitted = false`.
   - In `thinking_delta` handler: compute `delta` from `content` and `previousThinkingContent`; emit `thinking` with `{ content: delta }`; set `previousThinkingContent = content`.
   - At the start of `assistant_delta` handler: if `!finalMessageStartEmitted`, emit `final_message_start`, then set `finalMessageStartEmitted = true`. Then run existing assistant_delta logic.

2. **Types (if shared)**
   - In `src/types.ts`, add `"final_message_start"` to `LifecycleEventType` so it’s part of the shared contract.

3. **UI**
   - In the SSE message handler in `ChatContext.tsx`, add a branch: when `data.type === "final_message_start"`, call `setStreamedThinkingContent("")`.
   - Confirm that on turn completion (e.g. in `runTurn`’s `finally` or equivalent), `setStreamedContent("")` and `setStreamedThinkingContent("")` are called (already present).

4. **Manual verification**
   - With Cursor-Agent CLI: send a message; observe thinking updates in place (only latest chunk); when assistant starts, thinking clears and reply streams and grows; on completion only the final message remains.
   - With Ollama/Qwen (if thinking is present): same behavior.

## Success Criteria

- [ ] **SC1** During a run, each new `thinking` event shows only the latest chunk (no concatenation of previous thinking chunks in the thinking block).
- [ ] **SC2** When the first assistant content arrives, the thinking block is cleared and the user sees only the streaming assistant message.
- [ ] **SC3** The final reply appears to “type out” (append) during streaming; no duplicate or repeated segments.
- [ ] **SC4** When the run completes, the streaming/thinking UI is cleared and only the final assistant message is shown in the thread.
- [ ] **SC5** No regression: existing flows (no thinking, or CLI full-message-only) still complete and show the final message correctly.

## Final message (multi-round / tool use)

- **Last round only:** The value returned in the turn result (and shown in the message box) is **only the last round's reply**. The runtime resets `assistantText` at the **start of each** agent-loop round (top of `while (true)`). So when there are multiple rounds (e.g. tool calls and follow-up), only the final round's assistant content is kept; prior rounds' text is not accumulated into the final message.
- **Streaming during run:** Non-final rounds may show as streaming updates that overwrite each other; the stream is cleared on `completed`, and only the final message remains in the thread.
- **Extension point:** If a model or CLI later supports an explicit "this is the final user message" (e.g. a field or lifecycle event), the runtime can prefer that over "last round's assistant content" when building the turn result.

### Final-message-only: success criteria

- **SC1 (multi-round):** A run with one or more tool-call rounds ends with a final message that contains only the last round's reply (e.g. "Here's a concise analysis…"). It must not contain prior-round thinking/reply text (e.g. "Reading the key streaming components…", "Checking how the runtime…").
- **SC2 (single-round):** A run with no tool calls still shows the full reply as the final message; no regression.
- **SC3 (streaming):** During the run, non-final content can appear in the streaming bubble and be replaced by later content; on completion the bubble is cleared and only the final message remains in the thread.
- **SC4 (thinking/tags):** Thinking and known thinking/tool/code tags do not appear in the final message or in the streaming text (existing `stripThinkingTags` behavior preserved; extend stripping for new tags only when they appear in adapter/model output).
- **SC5 (early exit):** Hint-request and other early-return paths still set and return the intended message; no change in behavior.

### Final-message-only: guardrails

- **G1:** Do not reset `assistantText` on the early-exit path (hint-request, etc.); only at the top of the `while (true)` body.
- **G2:** Within a round, keep existing logic that updates `assistantText` and `thisRoundContent` from `assistant_delta` (so tool-follow-up messages and streaming remain correct).
- **G3:** Keep all post-loop cleanup (`stripThinkingTags`, dedup, etc.) so the last-round-only string is still normalized before return.
- **G4:** Do not change the contract of assistant events or the UI's handling of `streamedContent` / `streamedThinkingContent` beyond what's already there; overwrite and clear-on-complete behavior stays as-is.
- **G5:** If adding tool/code tag stripping, do it in a single place (e.g. shared helper) and apply consistently to the same content that is shown in stream and final message.

### Tags (thinking / tool / code)

- **Thinking:** Already stripped via `stripThinkingTags` (`<think>...</think>`, `<thinking>...</thinking>`). Keep as-is.
- **Tool/code tags:** If the adapter or model later emits explicit tags for tool calls or code (e.g. `<tool_call>`, `<code>`), extend the stripping helper (or add a shared "strip non-user-visible tags" step) and apply it to content used for assistant events and to `assistantText` before post-loop cleanup. Only add stripping for tags that are actually present in the CLI/model output; if none are found, document "extend stripping if new tag formats appear" and skip implementation until a concrete format exists.

## Guardrails (Regression Prevention)

- **G1** Do not remove or weaken the existing logic that clears `streamedContent` and `streamedThinkingContent` when the turn ends (e.g. in `runTurn`’s `finally`).
- **G2** Keep `final_message_start` emission once per turn (guard with `finalMessageStartEmitted`).
- **G3** Thinking delta: if the adapter sends only deltas, `content` will not start with `previousThinkingContent` (or we’ll have empty previous), so we emit the chunk as-is; do not drop or double chunks.
- **G4** Backend continues to send `assistant` with accumulated content (and optional `replace: true` where applicable); UI continues to set `streamedContent` to that value so the bubble grows.
- **G5** Optional: add a simple test or script that asserts lifecycle event order for a mock run (e.g. `streaming` → optional `thinking`* → `final_message_start` → `assistant`* → `completed`).
- **G6** Do not reset `assistantText` on early-exit paths (e.g. hint-request); only at the top of the `while (true)` body so only the last round's content becomes the final message.
