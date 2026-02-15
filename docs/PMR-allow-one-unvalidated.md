# PMR — Allow One Unvalidated Attempt (Implementation Guide)

**Scope:** When `useOnlyValidatedFallbacks` is true and the filtered fallback chain is empty (no validated models), optionally allow a single attempt using the unfiltered chain, with a clear log warning; if that attempt errors, fail with the existing "all model attempts failed" behavior.

**Status:** Implementation guide only. Use this doc when implementing the feature.

---

## 1. Goals and success criteria

### Goals

- Give operators a way to allow one "last chance" run when no model has been validated yet (e.g. fresh install or new model added), without disabling `useOnlyValidatedFallbacks` entirely.
- Keep behavior explicit: one unvalidated attempt, then fail if it errors (no silent fallback to unvalidated models on every turn).

### Success criteria

- **Config:** New option (e.g. `providerModelResilience.allowOneUnvalidatedAttempt: boolean`, default `false`) is documented in configuration-reference and typed in `config.ts` and adapter config.
- **Adapter:** When `useOnlyValidatedFallbacks` is true and the validated filter yields an empty chain:
  - If `allowOneUnvalidatedAttempt` is `true`: log a single clear warning (e.g. "no validated models; allowing one unvalidated attempt per PMR allowOneUnvalidatedAttempt"), use the **original unfiltered** chain for this turn; if all attempts in that chain fail, throw as today ("all model attempts failed").
  - If `allowOneUnvalidatedAttempt` is `false` or unset: keep current behavior — throw "no validated model available; run 'npm run validate-model' …".
- **Tests:** Unit tests cover: (1) empty validated chain + allowOneUnvalidatedAttempt true → unfiltered chain used, warning logged; (2) empty validated chain + allowOneUnvalidatedAttempt false → throw "no validated model available"; (3) empty validated chain + allowOneUnvalidatedAttempt true + unfiltered attempt fails → throw "all model attempts failed".
- **Docs:** Configuration reference §4.15.1 updated; PMR guide §Phase 3 or "Optional" updated to mention this option.

---

## 2. Implementation notes

### Config

- **config.ts:** Add to `ProviderModelResilienceConfig`:
  - `allowOneUnvalidatedAttempt?: boolean` (default `false`).
- **model-adapter.ts:** Add to `AdapterProviderModelResilienceConfig` and pass through from app config (same as `useOnlyValidatedFallbacks`).

### Adapter (src/model-adapter.ts)

- In `sendTurn`, when `useOnlyValidatedFallbacks` is true and `validated.length === 0`:
  - If `this.config.providerModelResilience?.allowOneUnvalidatedAttempt === true`:
    - Log one warning (reuse `pushAdapterEventLog` or equivalent; avoid secrets).
    - Do **not** overwrite `modelChain` with validated (leave `modelChain` as the original `[session.model, ...fallbackModels]`).
  - Else:
    - Throw the existing error: "no validated model available; run 'npm run validate-model' …".

### Guardrails

- `allowOneUnvalidatedAttempt` has no effect when `useOnlyValidatedFallbacks` is false (no change to current behavior).
- Only one attempt cycle is allowed: we do not retry with unvalidated on every turn; we allow one use of the unfiltered chain for this turn only. Subsequent turns again filter by validated; if still empty, again allow one unvalidated only if the flag is set.

### Tests (e.g. tests/provider-model-resilience.test.ts)

- Extend "useOnlyValidatedFallbacks policy" describe block or add a nested describe "allowOneUnvalidatedAttempt":
  - Empty store (no validated models), `useOnlyValidatedFallbacks: true`, `allowOneUnvalidatedAttempt: true` → adapter uses unfiltered chain; assert log contains warning and that a successful provider call completes.
  - Same config, but provider fails → assert throw "all model attempts failed" (or equivalent).
  - Empty store, `useOnlyValidatedFallbacks: true`, `allowOneUnvalidatedAttempt: false` (or unset) → assert throw "no validated model available".

---

## 3. Files to touch

| Area        | File(s) |
|------------|---------|
| Config type| `src/config.ts` |
| Adapter    | `src/model-adapter.ts` (interface + sendTurn branch when validated.length === 0) |
| Index      | `src/index.ts` (pass new option into adapter config if needed) |
| Config ref | `docs/configuration-reference.md` §4.15.1 |
| PMR guide  | `docs/PMR-provider-model-resilience.md` (Phase 3 or optional line) |
| Tests      | `tests/provider-model-resilience.test.ts` |

---

## 4. Optional: future work

- Metric or log counter for "unvalidated attempt used" to aid operator awareness.
