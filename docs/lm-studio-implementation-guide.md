# LM Studio — implementation guide (when needed)

This doc is a **placeholder** for adding **LM Studio** (or a similar local OpenAI-compatible server) as an optional provider. Use it when the operator wants LM Studio support. For the general pattern (local provider, validation, PMR), see [PMR §8](PMR-provider-model-resilience.md#8-phase-4--optional-local-models-eg-16gb-vram).

## When to use

- You want a local UI (LM Studio) to load and manage models, with CursorClaw talking to the same models via the OpenAI-compatible API.
- You prefer LM Studio’s workflow over Ollama’s CLI/server model, or you already use LM Studio for other tools.
- You don’t need a dedicated adapter yet: if LM Studio exposes an OpenAI-compatible endpoint, you can use the existing **openai-compatible** provider with `baseURL` pointing at LM Studio (see [Configuration Reference §4.15](configuration-reference.md#415-models-and-defaultmodel)). This guide becomes relevant when we add a first-class `lm-studio` provider (e.g. display name, validation, or provider-specific behavior).

## Prerequisites

- LM Studio installed and running, with at least one model loaded.
- Local server started in LM Studio (OpenAI-compatible API on localhost; port and base URL documented in LM Studio).
- Same machine as CursorClaw (or reachable network if you expose the server; local use is the typical case per PMR §8).

---

**Status:** Implemented. The `lm-studio` provider is in the registry; it uses the same adapter as `openai-compatible` with default baseURL `http://localhost:1234/v1` and optional `apiKeyRef` for local. Config reference §4.15 and provider-model-support.md are updated. Success criteria (reference):

1. **Doc in `docs/`** — This file (done: config shape, validation, PMR §8 below).
2. **Setup** — How to install/run LM Studio, expose the local server (e.g. OpenAI-compatible API on localhost), and which models to load.
3. **Config shape** — See § Config shape below (current: `openai-compatible`; future: optional `lm-studio` provider).
4. **Validation** — See § Validation flow below.
5. **PMR §8 alignment** — See § PMR §8 alignment below. Sync [provider-model-support.md](provider-model-support.md) and [configuration-reference.md](configuration-reference.md) §4.15 when the provider is added.

**Reference:** [Local Ollama agent setup](local-ollama-agent-setup.md) is the template for local-provider setup, validation, and docs. [Configuration Reference §4.15](configuration-reference.md#415-models-and-defaultmodel) lists existing providers and config shape.

When implementation starts: create a branch, implement adapter/registry and config, add tests and docs, push, and open a PR for review.

---

## Config shape

Two options: use the existing **openai-compatible** provider (no code change), or add a first-class **lm-studio** provider (adapter + registry).

### Option A — Current: `openai-compatible` (no new adapter)

LM Studio exposes an OpenAI-compatible API. Use the existing **openai-compatible** provider with `baseURL` set to LM Studio’s server (e.g. `http://localhost:1234/v1` — check LM Studio’s Local Server UI for the exact port and path).

**Required:** `provider`, `openaiModelId` (use the model name shown in LM Studio, e.g. `local-model` or the ID LM Studio reports).  
**Optional:** `baseURL` (default OpenAI URL is not suitable; set to LM Studio’s base URL), `apiKeyRef` (optional for local; LM Studio often allows no key for localhost), `timeoutMs`, `authProfiles`, `fallbackModels`, `enabled`, `maxContextTokens`, `paidApi: false` (local, so validation is allowed without `runValidationAgainstPaidApis`).

Example `openclaw.json` snippet (LM Studio on port 1234, model id `my-lm-studio-model`):

```json
"my-lm-studio": {
  "provider": "openai-compatible",
  "openaiModelId": "my-lm-studio-model",
  "baseURL": "http://localhost:1234/v1",
  "timeoutMs": 120000,
  "authProfiles": ["default"],
  "fallbackModels": [],
  "enabled": true
}
```

No change to `src/providers/registry.ts` or config schema; add this model to `config.models` and set `defaultModel` or `fallbackModels` as needed.

### Option B — first-class `lm-studio` provider (implemented)

The **lm-studio** provider is in the registry; it uses the openai-compatible adapter with default baseURL `http://localhost:1234/v1` and optional `apiKeyRef` for local. When adding or changing provider-specific behavior (e.g. for display name, default base URL, or provider-specific behavior):

- **Registry:** Add `lm-studio` to `src/providers/registry.ts` and implement an adapter (e.g. extend or wrap the OpenAI-compatible adapter with a default `baseURL` and optional LM Studio–specific options).
- **Config shape (proposed):**
  - **Required:** `provider: "lm-studio"`, `openaiModelId` (or a dedicated `lmStudioModelId` if we want to distinguish; reusing `openaiModelId` keeps config consistent with openai-compatible).
  - **Optional:** `baseURL` (default e.g. `http://localhost:1234/v1`), `apiKeyRef`, plus common model fields (`timeoutMs`, `authProfiles`, `fallbackModels`, `enabled`, `maxContextTokens`, etc.).
- **Config reference:** Add a row for `lm-studio` in [configuration-reference.md](configuration-reference.md) §4.15 (provider table and example). Update [provider-model-support.md](provider-model-support.md) to replace the “Future (e.g. LM Studio)” row with the real provider and link to this guide.

---

## Validation flow

- **Option A (openai-compatible):** Use the existing validation probe. No provider-specific logic. Run:
  - `npm run validate-model -- --modelId=my-lm-studio --fullSuite`
  Ensure the model id exists in `config.models` and LM Studio is running with that model loaded. Results are written to the validation store per [PMR](PMR-provider-model-resilience.md) (Phase 2); local models do not require `runValidationAgainstPaidApis`.
- **Option B (lm-studio provider):** Same as Option A (adapter is a thin wrapper around the same OpenAI-compatible API): `npm run validate-model -- --modelId=<id> --fullSuite`. If the adapter adds custom behavior (e.g. different endpoint path or request shape), document any provider-specific validation steps and ensure the probe can resolve the model via the new provider and run the same capability checks (tool call + reasoning). No separate validation script is required unless we introduce a non–OpenAI-compatible path.

---

## PMR §8 alignment

When LM Studio is used as a local provider (Option A or B), align with [PMR §8](PMR-provider-model-resilience.md#8-phase-4--optional-local-models-eg-16gb-vram) as follows.

| PMR subsection | Alignment |
|----------------|-----------|
| **§8.1 Minimum hardware and model size constraints** | Same as Ollama/local: document 16GB VRAM or 32GB RAM as practical minimum for tool-capable models; point to PMR §8.1 and to this guide for “LM Studio” in the setup section. In this doc, add a short “Hardware” note under Setup: refer to [PMR §8.1](PMR-provider-model-resilience.md#81-minimum-hardware-and-model-size-constraints) for VRAM/RAM/OS and model-size vs capability. |
| **§8.2 Optional local provider in the validation suite** | Add the LM Studio model to `config.models`; run `npm run validate-model -- --modelId=<id> --fullSuite`. Results go to the same validation store; if the model passes, it can be used when `useOnlyValidatedFallbacks` is true. Local inference has no per-token cost; `runValidationAgainstPaidApis` does not apply. |
| **§8.3 Graceful degradation** | No parity guarantee with Cursor Auto. Adapter treats LM Studio like any other fallback: try in order, respect validation state, surface clear errors if no validated model is available. If the LM Studio server is absent or unreachable, the app must not crash; the fallback chain skips or fails over to the next candidate (same as Ollama). When adding the `lm-studio` provider, ensure the adapter handles connection errors and timeouts without throwing uncaught; document timeout and “server not running” in a short Troubleshooting subsection. |

**Doc sync when adding the provider:** Update [provider-model-support.md](provider-model-support.md) (replace Future row with LM Studio row; tool-call/validation/local as applicable). Update [configuration-reference.md](configuration-reference.md) §4.15 (provider list, table row, example). Add a “See also” or link from [local-ollama-agent-setup.md](local-ollama-agent-setup.md) to this guide for operators who prefer LM Studio over Ollama.
