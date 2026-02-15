# PMR — Provider and Model Resilience (Implementation Guide)

**Scope:** Prepare the framework for the eventual expiry or unavailability of the Operator's primary inference subscription (e.g. Cursor Auto). The system should be able to discover, validate, and switch to alternative providers and models that meet minimum requirements (tool use, reasoning, coding, planning) at sustainable cost (ideally free or low-cost), with safe handling of API keys and no crashes from switching to an unusable model.

**Status:** Implementation guide only; no code implementation yet. Use this doc when implementing the feature. Builds on existing `config.models`, `defaultModel`, and `fallbackModels` in the model adapter.

---

## 1. Goals and success criteria

### Goals

- **Discovery:** The framework can enumerate candidate providers and models (from config, env, or a safe discovery mechanism) that we have API keys for or that can be obtained in a controlled way.
- **Validation:** Before a model is used (or before it is added to the fallback chain), the framework can run a **minimum-capability check** so that switching to it does not crash the system (e.g. the model can complete a simple tool-calling and reasoning probe).
- **Mapping storage:** Results of validation (per model id, provider, optional cost/quality metadata) are stored so that at runtime the system knows which models are **known good** and can be safely used or tried in order.
- **Switching:** When the primary model is unavailable (or as policy), the system can switch to a validated fallback mid-stream (action, heartbeat, or recovery) without assuming the fallback is untested.
- **Security and cost:** No API keys in prompts or logs; validation runs are cost-bounded and optional; autonomous key acquisition (if ever in scope) is strictly gated and auditable.

### Success criteria (phased)

**Phase 1 — Discovery and mapping (no fuzz yet)**

- [ ] Operator can configure multiple models in `config.models` with `fallbackModels`; existing adapter already tries the chain on failure (see `src/model-adapter.ts`).
- [ ] A **validation result store** (e.g. file or DB) records, per model id: last run date, pass/fail of a minimal capability probe, optional error message. Format and path documented; no secrets stored.
- [ ] A **probe** (script or tool) runs a single turn against a model: system prompt + one user message that asks for a trivial tool call (e.g. echo); assert response contains a valid tool call and completion. Run manually or via a dedicated npm script; not yet automatic on heartbeat.

**Phase 2 — Validation and “fuzz” (safe, cheap)**

- [x] **Minimum-capability suite** is defined: (1) tool call in response, (2) simple reasoning (e.g. 2+2). Run with `npm run validate-model -- --modelId=<id> --fullSuite`. Optional code-snippet or plan step can be added later. Short prompts keep cost low.
- [x] Validation runs on-demand; results update the validation store (per-check: toolCall, reasoning). Failed models are not removed from config but are **deprioritized** or skipped in the fallback chain when a “use only validated” policy is enabled.
- [x] **Cost/safety:** No validation against paid APIs without explicit operator opt-in (e.g. `providerModelResilience.runValidationAgainstPaidApis: true`); or validation only for models with a “free tier” or local. Rate limits and max spend (if applicable) documented.

**Phase 3 — Switching policy and mid-stream use**

- [x] Config or policy flag (e.g. `providerModelResilience.useOnlyValidatedFallbacks: boolean`) ensures that when falling back, only models that have **passed** the minimum-capability check in the store are tried (and in a defined order, e.g. by last success time or explicit priority).
- [x] If all validated fallbacks are exhausted, fail with a clear error (“no validated model available”) ; optional **allow one unvalidated attempt** is implemented via `providerModelResilience.allowOneUnvalidatedAttempt` (see configuration-reference §4.15.1 and `docs/PMR-allow-one-unvalidated.md`).
- [x] Docs: operator knows how to run validation, how to add new providers/models, and how to interpret the validation store (see configuration-reference §4.15.1).

**Phase 4 — Optional and stretch**

- [x] **Local models (e.g. 16GB VRAM):** Document minimum hardware and model size constraints; optional support for a “local” provider (e.g. Ollama or similar) in the validation suite. No requirement for parity with Cursor Auto; “best effort” and graceful degradation. See §8 below.
- [ ] **Autonomous API key acquisition:** Out of scope for initial implementation; if introduced later, must be behind a strict capability gate, audit log, and operator approval; no keys in prompts or logs.

---

## 2. Minimum requirements for a “usable” model

A model is **usable** for this project if it can:

1. **Tool use:** Respond with a valid tool call (name + args) when the prompt requests it (e.g. “call tool X with Y”).
2. **Reasoning:** Produce coherent short reasoning (e.g. answer a simple math or logic question in one turn).
3. **Coding/planning:** Optional for Phase 1; in Phase 2 can be a simple “write a one-line code snippet” or “list two plan steps.”

The existing adapter contract (see `docs/cursor-agent-adapter.md`) already implies tool-call and stream shapes. The probe should use the same adapter or a minimal harness that sends one turn and asserts on events (e.g. at least one `tool_call` and `done`).

---

## 3. Validation store and probe

### Store (Phase 1)

- **Location:** e.g. `run/store/provider-model-validation.json` or under `tmp/` (if tmp is gitignored). Prefer a path under `run/` if the project already uses it for persistent runtime data.
- **Shape (conceptual):**

```json
{
  "lastUpdated": "ISO8601",
  "results": {
    "model-id-1": {
      "passed": true,
      "lastRun": "ISO8601",
      "checks": { "toolCall": true, "reasoning": true },
      "error": null
    },
    "model-id-2": {
      "passed": false,
      "lastRun": "ISO8601",
      "checks": { "toolCall": false, "reasoning": true },
      "error": "timeout"
    }
  }
}
```

- **No secrets:** Do not store API keys or tokens in this file. Only model id, pass/fail, and optional non-sensitive error reason.

### Probe (Phase 1)

- **Input:** Model id (must exist in `config.models`), config path.
- **Steps:** Load config → resolve model config → create a one-off session → send one turn with a fixed system prompt (“You are a test. When asked to call a tool, respond with exactly one tool call.”) and user message (“Call the tool named echo with argument hello.”) with a single tool `echo` in the tool list → read stream for `tool_call` and `done` (or equivalent) within a timeout.
- **Output:** Update the validation store for that model id (passed/failed, lastRun, optional error). Exit code 0 if passed, non-zero if failed or error.

---

## 4. Scope and out of scope

### In scope (by phase)

| Phase | In scope |
|-------|----------|
| 1     | Validation store, minimal probe script/tool, documentation |
| 2     | Minimum-capability suite, optional scheduled validation, cost/safety guardrails, deprioritize unvalidated |
| 3     | “Use only validated fallbacks” policy, clear failure when no validated model available |
| 4     | Optional local-model support, documentation of 16GB/local constraints; no parity guarantee with Cursor Auto |

### Out of scope (initial)

- **Autonomous API key acquisition** by the agent (no self-provisioning of keys without explicit, gated, auditable design).
- **Full fuzz testing** of all provider APIs (only minimal capability checks; no stress or adversarial fuzz).
- **Guaranteeing** that a “validated” model matches Cursor Auto in quality or capability; validation only ensures “does not crash and can do basic tool use + reasoning.”

---

## 5. Implementation steps (for implementer)

### Step 1: Validation store and path

- Add a small module (e.g. `src/provider-model-resilience/validation-store.ts`) that reads/writes the validation result file. Path from config (e.g. `providerModelResilience.validationStorePath`) or default `run/provider-model-validation.json`. Ensure directory exists; do not commit secrets.
- Document the schema and path in configuration reference and in this doc.

### Step 2: Minimal probe

- Implement a **probe** that: (1) loads config and model config for a given model id, (2) uses the existing adapter (or a minimal clone) to send one turn with the echo tool, (3) asserts tool_call + done within timeout, (4) writes result to the validation store.
- Expose via npm script (e.g. `npm run validate-model -- --modelId=fallback-default`) or a small CLI. No key in args or logs.

### Step 3: Config and policy (Phase 3)

- Add optional config section `providerModelResilience`: `validationStorePath`, `useOnlyValidatedFallbacks` (default false), `runValidationAgainstPaidApis` (default false for Phase 2).
- In the model adapter, when building the fallback chain: if `useOnlyValidatedFallbacks` is true, filter the chain to only models that have `passed: true` in the store (and optionally sort by lastRun or priority). If the filtered chain is empty, either fail fast with a clear error or (configurable) allow one unvalidated attempt with a log warning.

### Step 4: Capability suite (Phase 2)

- Extend the probe to run multiple checks: tool call, reasoning, optional code/plan. Run in sequence; short prompts and low max_tokens. Store per-check results in the validation store. Only mark `passed` if all required checks pass.
- Document how to run the suite (npm script or CLI) and how to interpret results.

### Step 5: Operator documentation

- Configuration reference: new section for `providerModelResilience` (path, useOnlyValidatedFallbacks, runValidationAgainstPaidApis).
- Operator README or runbook: how to add a new model, run validation, and enable “use only validated” for resilience. Note that validation is optional and does not replace operator judgment for production model choice.

### Step 6: Tests

- Unit tests: validation store read/write; probe with a mock adapter (expect pass when tool_call + done, fail when timeout or no tool call). Filtering of fallback chain when useOnlyValidatedFallbacks is true (only validated models used; empty chain behavior).

---

## 6. Guardrails

- **Secrets:** Never log or store API keys, tokens, or credentials in the validation store or probe output. Use existing redaction and env-based key loading (see `docs/GH.1-read-only-github-integration.md`, `docs/GH-CLI-SECURE-IMPLEMENTATION.md`).
- **Cost:** Validation against paid APIs only with explicit opt-in; use minimal tokens and short prompts; document rate limits and optional max spend.
- **Safety:** Probe runs in the same process/sandbox as the rest of the app; no arbitrary code execution from probe input. Model id must exist in config; no dynamic provider loading from untrusted sources without a separate design.
- **Switching:** When useOnlyValidatedFallbacks is true, do not switch to an unvalidated model unless the policy explicitly allows one last attempt with warning. Prefer “fail with clear error” over silent use of an untested model.

---

## 7. References

- `src/model-adapter.ts` — Fallback chain (session.model + fallbackModels), recoverable vs non-recoverable errors.
- `src/config.ts` — `models`, `defaultModel`, model config shape.
- `docs/configuration-reference.md` — §4.15 `models` and `defaultModel`.
- `docs/cursor-agent-adapter.md` — Turn contract, tool_call and event shapes.
- `docs/GH-CLI-SECURE-IMPLEMENTATION.md` — Secrets, capabilities, intent.

---

## 8. Phase 4 — Optional local models (e.g. 16GB VRAM)

This section documents how to use **local** inference (e.g. Ollama, LM Studio, or similar) as an optional fallback. Support is **best effort**; there is no guarantee of parity with Cursor Auto or other hosted providers. The validation suite can optionally include a local provider so that validated fallbacks may include local models.

### 8.1 Minimum hardware and model size constraints

- **VRAM:** For GPU-based local inference, **16GB VRAM** is a practical minimum for models that can do tool use and reasoning (e.g. 7B–13B parameter models with quantization). Smaller GPUs (8GB) may run smaller or heavily quantized models with reduced quality; 24GB+ allows larger models (e.g. 34B at Q4) or higher precision.
- **RAM:** If running on CPU or with CPU offload, **32GB system RAM** is recommended for 7B–13B models; larger models need more. Swap can help but will slow inference.
- **OS:** Typical setups are Linux or Windows with CUDA (NVIDIA) or ROCm (AMD), or macOS with Metal. Ollama and similar run on all three; check provider docs for exact support.
- **Model size vs capability:** Smaller local models (7B, 8B) often support tool use and short reasoning; quality and long-context behavior vary. Use `npm run validate-model -- --modelId=<local-model-id> --fullSuite` to confirm a local model passes the minimum-capability checks before relying on it in the fallback chain.

### 8.2 Optional local provider in the validation suite

- **Adding a local model:** Configure the local provider (e.g. Ollama) and add a model entry in `config.models` with the same shape as other providers (provider type, model id, endpoint if needed). Ensure the adapter or provider layer can route requests to the local endpoint (implementation-dependent).
- **Validation:** Run the same probe/suite against the local model id: `npm run validate-model -- --modelId=<id> --fullSuite`. Results are written to the validation store; if the model passes, it can be used when `useOnlyValidatedFallbacks` is true.
- **Cost/safety:** Local inference typically has no per-token API cost; `runValidationAgainstPaidApis` does not apply. Rate limits are hardware-bound; no extra guardrails required for local-only validation.

### 8.3 Graceful degradation

- **No parity guarantee:** Local models may be slower, have shorter effective context, or differ in tool-call format. The adapter should treat local providers like any other fallback: try in order, respect validation state, and surface clear errors if no validated model is available.
- **Best effort:** If the project adds explicit support for a "local" provider (e.g. Ollama), it should be optional: absence of the local daemon or failure to reach it should not crash the app; the fallback chain simply skips or fails over to the next candidate.
