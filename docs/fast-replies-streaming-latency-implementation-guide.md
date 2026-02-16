# Fast Replies: streaming and latency (implementation guide)

**Scope:** Define how to add **streaming responses** and **latency optimizations** so the agent can deliver progressive output and reduce time-to-first-byte. Complements existing interrupt-to-respond, delivery pacing, typing indicators, and greeting policy.

**Status:** Draft. Implementation guide only; implement when prioritized.

**References:** [docs/memory.md](memory.md) §8 (fast memory patterns); STUDY_GOALS Fast Replies (research notes: SSE/WebSocket, chunked delivery, round-trip reduction, smaller context, early partial reply).

---

## 1. Goals

- **Streaming:** Deliver tokens to the UI incrementally (SSE or WebSocket) so the user sees progress instead of waiting for the full response.
- **Latency:** Reduce round-trips and time-to-first-byte via context compression for simple queries, batched tool calls where possible, and optional early "thinking" or partial reply before full tool results.

---

## 2. Success criteria

- **Streaming:** Backend supports a streaming API (e.g. OpenAI-style `stream: true`); gateway or adapter exposes an event stream; UI consumes the stream and renders incrementally. No regression to existing non-streaming behavior when streaming is disabled.
- **Latency:** For simple or repeated queries, measurable improvement in time-to-first-byte (e.g. smaller/focused context when tools are not needed, or early partial reply). Guardrails: no dropping of required context for correctness; tool-call batching only when safe (no ordering dependencies).

---

## 3. Guardrails

- Do not break existing non-streaming and single-round behavior; make streaming and latency features opt-in or backward-compatible.
- Do not reduce context in a way that causes wrong answers or missed tool use; use heuristics (e.g. context-aware behavior) to decide when to trim context.
- Preserve interrupt-to-respond: streaming must support cancellation when the user sends a new message.

---

## 4. Implementation outline

### Streaming

- **Provider/API:** Use provider streaming when available (OpenAI-compatible `stream: true`; Ollama/LM Studio streaming). In `src/` (gateway or runtime), forward streamed chunks and expose as SSE or WebSocket to the UI.
- **UI:** Consume event stream and append tokens to the current message; keep typing indicator and delivery pacing consistent with streamed output.
- **Config:** Add optional `streamResponses: boolean` (or per-model) and document in configuration-reference.

### Latency

- **Context:** Reuse or extend context-aware behavior (see [context-aware-system-behavior.md](context-aware-system-behavior.md)) to use smaller/focused context for clearly non-tool turns when streaming or low-latency mode is on.
- **Batching:** Where the orchestration layer issues multiple tool calls, batch them when the model supports it and order does not matter; document limits and safety.
- **Early reply:** Optional: send an initial "thinking" or short partial reply before all tool results are in, when the spec allows and UX is clear.

---

## 5. Next steps

When implementing: (1) Add streaming support in gateway/runtime and UI; (2) Add config and tests; (3) Add latency optimizations (context + batching) per guardrails; (4) Validate with existing tests and manual E2E.
