# TU.3 — Priority-aware truncation (implementation guide)

**Status:** Implemented. Optional config `truncationPriority` on model config; see `docs/configuration-reference.md` and `src/max-context-tokens.ts`.

**Goal:** When trimming messages for `maxContextTokens` (TU.2), prefer dropping lower-priority content so that high-priority messages (e.g. latest user message, critical system instructions) are retained when possible, instead of strictly oldest-first.

## Success criteria

- When applying the context cap, the trim order is **priority-aware**: drop lowest-priority messages first, then next-lowest, while still respecting "last message always kept" (TU.2 guardrail).
- Priority is configurable or follows a documented default (e.g. `system` > `user` > `assistant` by recency, or keep "first system" + "last N user/assistant").
- Behavior remains backward compatible: if no priority config is set, fall back to current oldest-first trim (TU.2 behavior).
- No new required dependencies; works with existing token estimation in `src/max-context-tokens.ts`.

## Guardrails

- Always keep the **last** message (same as TU.2).
- Do not reorder messages; only choose which messages to drop when under the cap.
- Prefer trimming from the **oldest** within each priority tier so recent context is preserved.
- Document the default priority order and any config knobs (e.g. `truncationPriority?: ('system'|'user'|'assistant')[]` or keep-first-system: boolean).

## Where to implement

1. **Config** (optional): In `ModelProviderConfig` or a shared truncation section, add optional `truncationPriority?: string[]` (e.g. `['system','user','assistant']` meaning drop assistant first, then user, then system when trimming). Default: oldest-first (current TU.2 behavior).

2. **`src/max-context-tokens.ts`**: Extend `applyMaxContextTokens` (or add `applyMaxContextTokensWithPriority`) to accept an optional priority: either a role order for "drop in this order when over cap" or a predicate "keep(message, index)". Core algorithm: compute which messages to keep so that (a) last message always kept, (b) among the rest, drop in priority order (lowest first) until estimated tokens ≤ cap.

3. **Runtime** (`src/runtime.ts`): When calling the trim function, pass the resolved model's truncation priority if set; otherwise use oldest-first.

4. **Docs**: Document `truncationPriority` (or chosen knob) in `docs/configuration-reference.md` and in this guide.

## Testing

- Unit tests: (1) With no priority, behavior matches TU.2 (oldest-first). (2) With priority e.g. drop assistant first, assert that assistant messages are removed before user/system when over cap. (3) Last message always retained regardless of role.
- No change to TU.2 tests unless we change default behavior; add new tests for priority-aware paths.

## Optional refinements

- "Keep first system message" as a separate rule so the model always sees at least one system block.
- Per-role minimum counts (e.g. keep at least last 2 user messages) as future extension.
