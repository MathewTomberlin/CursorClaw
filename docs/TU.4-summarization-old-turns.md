# TU.4 — Summarization of old turns (implementation guide)

**Status:** Not implemented. Optional.

**Goal:** When reducing context for `maxContextTokens` (TU.2/TU.3), optionally **summarize** a prefix of old messages into one short message instead of (or before) dropping them, so the model retains semantic context of earlier conversation while staying under the token cap.

## Success criteria

- When over the cap and summarization is enabled, the implementation may replace a contiguous **prefix** of old messages (excluding the last message) with a single `assistant` or `system` summary message (e.g. "Earlier: user asked X; assistant suggested Y; …").
- Summarization is **optional** and off by default; no change to current truncation behavior when disabled.
- Summary length is bounded (e.g. max tokens or max chars) so it does not itself blow the cap.
- Works with existing TU.2/TU.3: can run **before** priority-aware trim (summarize old prefix, then apply cap/priority) or as an alternative strategy when over cap.

## Guardrails

- Always keep the **last** message unchanged (same as TU.2/TU.3).
- Do not reorder messages; summarization only replaces a prefix with one summary block.
- Summary must be clearly marked (e.g. role `system` with content prefixed by "Summary of earlier turns:") so the model does not treat it as new user/assistant content.
- No required LLM call for summarization in v1: use a simple extractive or rule-based summary (e.g. first sentence of each turn, or truncate concatenation) to avoid extra latency and cost. Optional future: optional LLM-based summarization behind a config flag.

## Where to implement

1. **Config**: In `ModelProviderConfig` or truncation section, add optional `summarizeOldTurns?: boolean` (default `false`) and optionally `summarizeOldTurnsMaxTokens?: number` (default e.g. 200). If enabled, when over cap we may replace the oldest N messages (N chosen so summary + rest ≤ cap) with one summary message.

2. **`src/max-context-tokens.ts`**: Add `summarizePrefix(messages, maxSummaryTokens): { summaryMessage, remainingMessages }` (or inline in a new `applyMaxContextTokensWithSummarization` path). Rule-based summary: e.g. concatenate "User: … Assistant: …" for each turn, then truncate to `maxSummaryTokens` (by `estimateTokens`). Return a single message like `{ role: 'system', content: 'Summary of earlier turns:\n' + truncatedText }` and `remainingMessages` = messages after the summarized range. No LLM call.

3. **Runtime** (`src/runtime.ts`): When `modelConfig.summarizeOldTurns === true` and estimated tokens > cap, (1) build summary from oldest messages and replace prefix with that one message, (2) then run existing `applyMaxContextTokens` (with optional priority) on the result so total ≤ cap. If summarization is off, behavior unchanged.

4. **Docs**: Document `summarizeOldTurns` and `summarizeOldTurnsMaxTokens` in `docs/configuration-reference.md`.

## Testing

- Unit tests: (1) With summarization off, behavior unchanged (existing TU.2/TU.3 tests). (2) With summarization on and over cap, oldest messages are replaced by one summary message; last message unchanged; estimated tokens after summarization ≤ cap (or then trimmed by existing logic). (3) Summary length never exceeds `summarizeOldTurnsMaxTokens`.
- No change to TU.2/TU.3 tests unless default behavior changes.

## Optional refinements

- LLM-based summarization behind a flag (separate model or same model, one short turn) for higher quality at extra cost/latency.
- Per-role handling in summary (e.g. "User asked … Assistant replied …" structure).
- Minimum number of messages before summarization kicks in (e.g. only if ≥ 10 messages).
