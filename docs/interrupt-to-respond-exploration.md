# Interrupt-to-respond: user messages vs heartbeats

Exploration of how user messages are received, how heartbeats run, and where we could add “interrupt to respond” so the agent can prioritize replying to the user over an in-flight heartbeat.

## 1. How user messages are received

1. **UI** (`ui/src/contexts/ChatContext.tsx`, `ui/src/pages/Chat.tsx`)
   - User types in chat and submits → `runTurn(text)` builds `apiMessages` and calls RPC `agent.run` with `{ session: { sessionId, channelId, channelKind, profileId }, messages }`.
   - Session IDs are typically something like `"demo-session"` (from `ChatContext` state).

2. **Gateway** (`src/gateway.ts`)
   - `POST /rpc` with `method === "agent.run"`:
     - Parses session and messages, optionally writes thread via `threadStore.setThread`.
     - Calls **`deps.runtime.startTurn({ session, messages })`**.
     - Returns `{ runId }` immediately; client then polls or waits via `agent.wait` with that `runId`.

3. **Runtime** (`src/runtime.ts`)
   - `startTurn(request)` creates a `runId`, builds a `PendingTurn` with `execute` (the full turn logic), and **enqueues by `request.session.sessionId`**.
   - `SessionQueue`: per-session queue; **one turn runs per session at a time**; additional turns for the same session wait in the backend queue until the previous finishes.
   - The turn calls `adapter.sendTurn(..., { turnId: runId, ... })`; the adapter can be cancelled via `adapter.cancel(turnId)` (e.g. `openai-compatible.ts`, `cursor-agent-cli.ts` use `turnId` / AbortController or stdin cancel).

So: **user message path = gateway `agent.run` → runtime `startTurn` → queue keyed by chat `sessionId` (e.g. `"demo-session"`).**

---

## 2. How heartbeats interact

1. **Orchestrator** (`src/orchestrator.ts`)
   - On a timer (`scheduleHeartbeat`), calls **`runHeartbeat()`** which calls `heartbeat.runOnce({ ..., turn: () => onHeartbeatTurn(heartbeatChannelId), bypassBudget: true })`.
   - No cancellation API: the heartbeat turn runs to completion (or throws); the next heartbeat is scheduled in `runHeartbeat().finally(() => scheduleHeartbeat(0))`.

2. **Heartbeat turn** (`src/index.ts` `onHeartbeatTurn`)
   - Builds a synthetic user message from `HEARTBEAT.md` (and optionally BIRTH), then calls **`runtime.runTurn({ session: { sessionId: "heartbeat:main", channelId: "heartbeat:main", ... }, messages: [{ role: "user", content }] })`**.
   - `runTurn` is `startTurn` + awaiting the promise, so the heartbeat is just another turn from the runtime’s perspective.

3. **Runtime queue key**
   - Queue key is **`request.session.sessionId`**.
   - User chat uses e.g. `sessionId: "demo-session"`.
   - Heartbeat uses **`sessionId: "heartbeat:main"`**.

So: **heartbeat and user chat use different session IDs → different queues → they can run concurrently.** There is no built-in “only one of these at a time” or “user message interrupts heartbeat.”

---

## 3. Summary table

| Path            | Entry point              | Queue key (sessionId) | Concurrency              |
|----------------|--------------------------|------------------------|---------------------------|
| User message   | Gateway `agent.run`      | e.g. `"demo-session"`  | One turn at a time per session |
| Heartbeat      | Orchestrator → `onHeartbeatTurn` | `"heartbeat:main"`     | Can run in parallel with user turns |

---

## 4. Options for interrupt-to-respond

Goal: when a user sends a message, the system should be able to “interrupt” to respond to them (e.g. not block behind a long heartbeat, or pause/cancel heartbeat so the user turn can start or be prioritized).

### A. Cancel in-flight heartbeat when user runs (true interrupt)

- **Idea:** On `agent.run` for the “main” or relevant session, signal the orchestrator to cancel the current heartbeat turn (if any) and optionally reschedule the next heartbeat.
- **Mechanics:**
  - Orchestrator (or a small wrapper) keeps a reference to the **current heartbeat runId** (or a promise that resolves to it). When starting a heartbeat turn, we need to go through something that records the runId (e.g. use `runtime.startTurn` in index and pass runId back, or have runtime expose “current runIds by sessionId”).
  - Gateway or a shared service, when handling `agent.run` for the main session, calls e.g. `orchestrator.cancelHeartbeatIfRunning()` which:
    - Resolves the current heartbeat runId (if any),
    - Calls **`runtime.getAdapter()?.cancel(runId)`** or a dedicated `runtime.cancelTurn(runId)` that forwards to the adapter.
  - Adapters already support `cancel(turnId)`; runtime uses `turnId: runId`, so cancelling by runId is consistent.
- **Caveats:** Need a way to get “current heartbeat runId” from the orchestrator/index into the gateway (e.g. dependency or callback). RunStore/orchestrator don’t currently expose “active heartbeat runId.”

### B. Shared “main” queue (no concurrency)

- **Idea:** Run both user turns and heartbeat on the **same** logical session so only one runs at a time (e.g. user and heartbeat both use `sessionId: "main"` or a dedicated `"main-session"`).
- **Effect:** User message and heartbeat would be serialized: user turn would wait for heartbeat to finish (or we combine with A so user message cancels heartbeat and then starts).
- **Change:** In `index.ts`, heartbeat already uses `sessionId: "heartbeat:main"`. To share with chat we’d either:
  - Use the same sessionId for the default chat session (e.g. `"main"`) so both hit the same queue, or
  - Introduce a single “global” or “main-channel” queue used by both and have heartbeat and user chat both target it (would require a small queue-key abstraction so “main” chat and “heartbeat” map to the same key).

### C. Priority queue: user before heartbeat

- **Idea:** Keep separate sessions but give user turns higher priority: when a user turn is enqueued, either (1) defer starting a heartbeat until the user queue is empty, or (2) use a priority queue so “user” turns are drained before “heartbeat” turns.
- **Mechanics:**
  - Option (1): Orchestrator, before calling `onHeartbeatTurn`, asks runtime (or gateway) “is there any pending or running turn for the main chat session?” If yes, skip this tick and reschedule (short delay); when no user turn is active, run heartbeat.
  - Option (2): Runtime would need a notion of “session groups” or priority (e.g. “main” vs “heartbeat”) and drain high-priority sessions first; larger change to `SessionQueue` and backend.

### D. Defer next heartbeat when user just ran

- **Idea:** Don’t cancel the current heartbeat, but when a user message has just been handled, push the next heartbeat further out so the user’s reply is “fresh” and we don’t immediately send a proactive heartbeat.
- **Mechanics:** Gateway (or runtime) notifies orchestrator “user turn completed for session X.” Orchestrator calls `scheduleHeartbeat(0)` with a longer delay (e.g. 2× interval) when the completed session is the main one. Easiest as an additive behavior on top of A or B.

---

## 5. Recommended direction (for implementation)

- **Short term:** **A (cancel in-flight heartbeat)** gives clear “interrupt to respond” semantics: as soon as the user sends a message, any running heartbeat is cancelled and the user turn can start (and if they share a queue, the user turn runs next).
- **Implementation steps:**
  1. **Record active heartbeat runId:** In `index.ts`, when starting the heartbeat turn, use `runtime.startTurn` instead of `runtime.runTurn`, and store the returned `runId` in a ref or object that the gateway (or a small “run coordinator”) can read. Optionally expose `getActiveHeartbeatRunId(): string | null` and `clearActiveHeartbeatRunId()`.
  2. **Gateway calls cancel on user run:** When handling `agent.run` for the main/default session, gateway (or deps) calls something like `cancelHeartbeatIfRunning()`. That function gets the active heartbeat runId (if any), calls `runtime.cancelTurn(runId)` (or adapter.cancel), then clears the ref. Add `runtime.cancelTurn(runId)` that finds the in-flight turn and calls `this.options.adapter.cancel(runId)` (and optionally rejects the turn’s promise so the orchestrator doesn’t treat it as a normal completion).
  3. **Orchestrator:** Either orchestrator holds the “active heartbeat runId” and a way to cancel (injected from index), or index holds it and gateway receives a `getDeps()` that includes `cancelHeartbeatIfRunning`. Keep scheduling as today: after `runHeartbeat().finally(...)` the next heartbeat is scheduled; if the turn was cancelled, the promise rejects and we still schedule the next one.

- **Optional:** Combine with **B** (same queue for main session and heartbeat) so that after cancelling the heartbeat, the user turn is the only one in the “main” queue and runs immediately. That requires the default chat session to use a sessionId that matches the heartbeat’s logical session (e.g. `"main"`) or a shared queue key.

---

## 6. Files to touch (for approach A)

| File | Change |
|------|--------|
| `src/index.ts` | Heartbeat uses `startTurn` and records `runId` in a ref; expose or pass `cancelHeartbeatIfRunning` to gateway deps. |
| `src/gateway.ts` | On `agent.run` (for main session), call `cancelHeartbeatIfRunning()` before or after `runtime.startTurn`. |
| `src/runtime.ts` | Add `cancelTurn(runId): Promise<void>` that calls `adapter.cancel(runId)` and optionally rejects/marks the pending turn (so queue can continue). |
| `src/orchestrator.ts` | Optional: accept `onBeforeHeartbeat` / `getActiveHeartbeatRunId` so orchestrator can skip or cancel; or keep all cancel logic in index/gateway. |

This keeps the exploration in one place and gives a clear path to add interrupt-to-respond behavior.
