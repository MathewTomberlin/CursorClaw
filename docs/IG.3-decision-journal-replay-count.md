# IG.3 — Configurable decision journal replay count

## Summary

The decision journal is replayed into the system prompt so the agent maintains rationale continuity. The number of recent entries replayed is currently hardcoded to **5** in `src/runtime.ts`. This item makes that value configurable via `continuity.decisionJournalReplayCount`.

## Success criteria

- [ ] Config option `continuity.decisionJournalReplayCount` exists and is applied when building the decision-journal system block.
- [ ] Default is **5** so current behavior is unchanged when the option is omitted.
- [ ] Replay count is clamped to a safe range (e.g. 1–100) so misconfiguration cannot blow context or break behavior.
- [ ] Existing tests that assert decision journal injection still pass; at least one test or example config demonstrates the new option.

## Guardrails

- **Min:** 1 (at least one entry can be replayed).
- **Max:** 100 (align with `DecisionJournal.readRecent` internal cap of 1_000; 100 is enough for continuity without consuming excessive context).
- **Default:** 5 (current behavior).
- **Config surface:** Add under `continuity` only; no new env vars required unless operator prefers env override later.

## Implementation steps

1. **Config**
   - In `src/config.ts`:
     - Add to `ContinuityConfig`: `decisionJournalReplayCount?: number;`
     - In `DEFAULT_CONFIG.continuity`, add `decisionJournalReplayCount: 5` (or leave undefined and apply default 5 at use site).
   - No change to `PATCHABLE_CONFIG_KEYS` (continuity is already patchable).

2. **Runtime**
   - In `src/runtime.ts`, in the block that builds the “Recent decision journal context” system message (around line 885–886):
     - Compute limit:  
       `const limit = Math.min(100, Math.max(1, this.options.config.continuity?.decisionJournalReplayCount ?? 5));`
     - Call: `await this.options.decisionJournal.readRecent(limit);`
   - No new runtime options are required; `AgentRuntime` already receives `config`.

3. **Tests**
   - `tests/failure-loop-runtime.test.ts`: Already asserts that decision journal context is injected; ensure it still passes (default 5).
   - Optional: Add a test that passes a custom config with `decisionJournalReplayCount: 2` (or 10) and asserts the injected block contains the expected number of lines / entries (or that `readRecent` was called with the right limit via a spy if desired).
   - `tests/reliability-continuity.test.ts`: Uses `DecisionJournal` directly; no change required unless you add an integration test that uses config.

4. **Docs**
   - In `docs/continuity.md`, document the new option in the “Decision journal” section (e.g. “The number of recent entries replayed is configurable via `continuity.decisionJournalReplayCount` (default 5, clamped 1–100).”).

## Files to touch

| File | Change |
|------|--------|
| `src/config.ts` | Add `decisionJournalReplayCount?: number` to `ContinuityConfig`; add default 5 in `DEFAULT_CONFIG.continuity`. |
| `src/runtime.ts` | Replace hardcoded `readRecent(5)` with config-driven limit (clamped 1–100). |
| `docs/continuity.md` | Document `continuity.decisionJournalReplayCount`. |
| Tests | Keep existing tests green; optionally add one test for custom replay count. |

## Out of scope

- “Since last session” or time-based replay (future optional work).
- Changing `DecisionJournal.readRecent` default parameter (30); the runtime is the only caller that needs the small default for prompt injection; config only affects the runtime call.
