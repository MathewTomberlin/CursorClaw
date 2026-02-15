# TU.2 — Per-model maxContextTokens (implementation guide)

**Status:** Guide complete; implementation optional.

**Goal:** Allow an optional per-model context token cap so operators can avoid overloading models with small context windows (e.g. some Ollama models) or control cost/latency on token-priced APIs.

## Success criteria

- Config: each entry in `config.models` may specify an optional `maxContextTokens?: number`.
- Runtime: when building the prompt message list for a turn, if the resolved model has `maxContextTokens` set, the combined system + user messages are trimmed (oldest first) so the estimated token count does not exceed the cap.
- No change in behavior when `maxContextTokens` is unset (backward compatible).
- Truncation is best-effort (e.g. character-based token estimate); no required dependency on a full tokenizer.

## Guardrails

- Only trim from the **oldest** messages so the most recent user message and recent context stay intact.
- Prefer trimming system-prompt content before user messages when applying the cap.
- Do not expose raw tokenizer or model internals in config; keep the contract as a single number per model.
- If the last user message alone exceeds the cap, still send it (trim from system/older only); document that very long single messages may exceed cap.

## Where to implement

1. **Config** (`src/config.ts`): Add `maxContextTokens?: number` to `ModelProviderConfig`. No default in schema; omit in defaults so existing configs are unchanged.

2. **Resolution**: Model for a turn is already resolved via `resolveModelIdForProfile(config, profile)` (or equivalent). Runtime has access to `config.models[modelId]` and thus to `maxContextTokens` when building the prompt.

3. **Runtime** (`src/runtime.ts`): After building `boundedSystemMessages` and `userMessages` (and the final `messages` array), if `config.models[modelId].maxContextTokens` is set:
   - Estimate token count for the full array (e.g. `sum over messages of ceil(content.length / 4)` or use a small fixed ratio).
   - If over cap: remove or trim from the **start** of the array (oldest messages) until estimated tokens ≤ maxContextTokens. Prefer trimming system messages first, then oldest user messages.
   - Pass the trimmed array to the adapter.

4. **Adapter**: No change; adapter receives the same message list shape. Token limiting is entirely in runtime.

5. **Docs**: Add `maxContextTokens` to `docs/configuration-reference.md` under the models section (optional, per-model).

## Token estimation

- Simple: `estimatedTokens = Math.ceil(text.length / 4)` (or 3–4 chars per token heuristic). No new dependencies.
- Optional later: use a small tokenizer (e.g. cl100k base) for the active model family if we add it; for TU.2, character-based estimate is sufficient.

## Testing

- Unit test: given a model config with `maxContextTokens: 100`, and a prompt that would exceed 100 estimated tokens, assert the message list passed to the adapter is under the cap and oldest content is trimmed.
- Integration: run a turn with a model that has `maxContextTokens` set and confirm no regression and that responses still succeed.

## Completed

- [x] Implement config field and docs
- [x] Implement runtime trimming with char-based estimate (`src/max-context-tokens.ts`, used in `src/runtime.ts`)
- [x] Add unit test (`tests/max-context-tokens.test.ts`); full test suite and build pass
