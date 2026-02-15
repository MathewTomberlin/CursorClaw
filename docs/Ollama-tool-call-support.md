# Ollama tool-call support (Implementation Guide)

**Scope:** Extend the Ollama provider (`src/providers/ollama.ts`) so it can send tools to the Ollama API and parse tool-call responses into adapter `tool_call` events. This enables the PMR `validate-model --fullSuite` tool-call check and runtime tool use when an Ollama model is in the fallback chain.

**Status:** Implementation guide only. Use this doc when implementing on a feature branch. Best-effort per PMR §8; no parity guarantee with Cursor Auto.

---

## 1. Goals and success criteria

### Goals

- **Request:** When `tools` are passed to `sendTurn`, include them in the Ollama `/api/chat` request in the format the Ollama API expects (e.g. OpenAI-style `tools` array if supported).
- **Response:** Parse the streaming (or final) response for tool-call content and emit adapter events `{ type: "tool_call", data: { name: string, args: unknown } }` so the adapter contract is satisfied.
- **Compatibility:** If the Ollama server or model does not support tools, or the response contains no tool calls, behavior remains backward compatible: only `assistant_delta`, `usage`, and `done` are emitted.

### Success criteria

- [ ] With an Ollama model that supports tool use and when tools are provided: the request body includes a `tools` (or equivalent) field in the format required by the Ollama API version in use.
- [ ] Stream parsing detects tool-call content (exact shape depends on Ollama API: e.g. `message.tool_calls`, `delta.tool_calls`, or tool call in the final `message` when `done`). Emit one `tool_call` event per call with `name` and `args`; args may be accumulated from streamed JSON parts if the API streams per-call deltas.
- [ ] `npm run validate-model -- --modelId=<ollama-model-id> --fullSuite` passes the **toolCall** check when the model and Ollama version support tool use.
- [ ] At runtime, when the user sends a turn that triggers tool use, the agent receives `tool_call` events and can execute tools and continue the loop.
- [ ] When no tools are passed, or the model returns no tool calls, behavior is unchanged (no regression): only text deltas and `done` as today.
- [ ] No new required config; existing `provider: "ollama"`, `ollamaModelName`, and optional `baseURL` remain sufficient. Optional: document any Ollama version or model requirements (e.g. “tool use supported in Ollama 0.3+” or “model must support tools”) in configuration-reference or this guide.

---

## 2. Current state

- **File:** `src/providers/ollama.ts`
- **Behavior:** Sends `model`, `messages`, and `stream: true` to `POST ${baseURL}/api/chat`. Does **not** pass `tools`. Reads stream lines; only handles `message.content` (→ `assistant_delta`) and `done` / `eval_count` (→ `usage` then `done`). Does not parse or emit `tool_call` events.
- **Adapter contract:** The model adapter and PMR probe expect events of type `tool_call` with `data: { name: string; args: unknown }` (see `src/types.ts`, `src/provider-model-resilience/probe.ts`, `src/runtime.ts`).

---

## 3. Ollama API (research required)

Ollama’s API and tool support evolve. Before implementing:

1. **Confirm request format:** Check the official Ollama API docs (e.g. [ollama/ollama docs](https://github.com/ollama/ollama/tree/main/docs)) for the exact `/api/chat` request shape when tools are used (e.g. `tools` array, schema format).
2. **Confirm response format:** Determine how tool calls appear in the stream or in the final message (e.g. `message.tool_calls[]`, streaming deltas per tool call, or a single blob in the last chunk). Implement parsing accordingly.
3. **Version and model:** Note the minimum Ollama version and any model requirements (e.g. “must use a model that supports tool/function calling”). Document in this guide or in `docs/configuration-reference.md` under the Ollama provider section.

If the deployed Ollama version does not support tools, or uses a different endpoint (e.g. OpenAI-compatible endpoint), the guide can be updated to describe that path (e.g. use `openai-compatible` provider with Ollama’s OpenAI-compatible base URL instead of extending the `ollama` provider). Implementation should still degrade gracefully: no tools in request and no `tool_call` in response → no tool_call events.

---

## 4. Implementation steps

1. **Map tools to Ollama request format**  
   In `sendTurn`, when `tools.length > 0`, map `ToolDefinition[]` to the structure Ollama expects (name, description, parameters schema). Omit or leave empty when `tools.length === 0`.

2. **Include tools in the request body**  
   Add the mapped `tools` (or equivalent key) to the JSON body of `POST ${baseURL}/api/chat`. Keep `stream: true` and existing `model`, `messages`.

3. **Parse stream for tool calls**  
   In the stream loop, for each parsed line:
   - If the API streams tool-call deltas (e.g. per-call index and `delta` with `function.name` / `function.arguments`), accumulate by call index and emit a `tool_call` event when a call is complete (e.g. when arguments are complete).
   - If the API sends tool calls only in the final `message` when `done: true`, parse that message and emit one `tool_call` event per entry in `message.tool_calls` (or equivalent).
   - Emit `{ type: "tool_call", data: { name, args } }` with `args` parsed from JSON when needed (e.g. `function.arguments` string → object).

4. **Text and tool interleaving**  
   Preserve order: emit `assistant_delta` and `tool_call` in the order they appear in the stream so the runtime sees the correct sequence.

5. **Tests**  
   - **Unit:** Mock `fetch` and a response body stream that simulates Ollama chunks containing one or more tool calls; assert that the provider yields the corresponding `tool_call` events and then `usage`/`done`. Add a case with no tool calls to ensure no regression.
   - **Integration (optional):** If the repo has or can use a local Ollama instance with a tool-capable model, add an optional integration test that runs `validate-model` for an Ollama model and asserts toolCall check passes (or skip when Ollama is unavailable).

6. **Docs**  
   - Update this guide with the exact request/response shapes used once implemented.
   - In `docs/configuration-reference.md` (or provider section), add a short note: Ollama tool use requires Ollama version X+ and a model that supports tool calling; link to this guide. PMR §8 (local models) can reference this guide for Ollama tool-call behavior.

---

## 5. Guardrails

- **Best-effort:** If the Ollama API does not support tools or uses a different format than assumed, log or document and do not emit `tool_call`; do not throw so that non–tool-use flows still work.
- **Security:** Do not log or echo raw tool arguments that might contain secrets; same policy as other providers.
- **Backward compatibility:** Existing configs and runs that use Ollama without tools must behave exactly as today (only assistant content and done).

---

## 6. Completion

When implementation is done: add a brief “Implemented” section at the top of this guide with the branch name and PR number, and update HEARTBEAT.md to move “Ollama tool-call support” from Open to Completed.
