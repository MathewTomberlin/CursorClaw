# Other local OpenAI-compatible provider — implementation guide

This doc is the **implementation guide** for adding **another local OpenAI-compatible** server or UI (e.g. Open WebUI, Jan, or any local service that exposes an OpenAI-compatible API) as an optional provider. For the general pattern (local provider, validation, PMR), see [PMR §8](PMR-provider-model-resilience.md#8-phase-4--optional-local-models-eg-16gb-vram). For a completed example, see [LM Studio implementation guide](lm-studio-implementation-guide.md).

## Scope and success criteria

**Scope:**

- Support one additional local provider that exposes an **OpenAI-compatible** HTTP API (e.g. Open WebUI backend, Jan, or similar). The provider is “local” in the PMR sense: runs on the operator’s machine or a reachable server; no parity guarantee with Cursor Auto.
- Operator can configure the provider via `config.models` (either using existing `openai-compatible` with `baseURL`, or a new first-class provider id if we add one).
- Validation uses the same minimum-capability suite (`npm run validate-model -- --modelId=<id> --fullSuite`); results go to the existing validation store. Local models do not require `runValidationAgainstPaidApis`.
- Config reference, runbook, and [provider-model-support.md](provider-model-support.md) stay in sync with this guide and PMR §8.

**Success criteria:**

1. **Implementation guide in `docs/`** — This file: when to use, config shape (Option A/B), validation flow, PMR §8 alignment.
2. **Option A (no code change):** Document how to use existing `openai-compatible` with `baseURL` and optional `apiKeyRef` for the chosen local server; example config snippet; how to run validation.
3. **Option B (first-class provider):** If adding a named provider (e.g. `open-webui`): (a) add to `src/providers/registry.ts` and extend or reuse the OpenAI-compatible adapter with a default `baseURL`; (b) update config schema and [configuration-reference.md](configuration-reference.md) §4.15; (c) update [provider-model-support.md](provider-model-support.md); (d) document setup (install, start server, which models) and troubleshooting; (e) validation runs via same probe, no separate script.
4. **PMR §8 alignment:** Hardware/model constraints (point to PMR §8.1); validation in suite (§8.2); graceful degradation and no crash when server absent (§8.3).

---

## When to use

- You want a **local** inference server or UI (other than Ollama or LM Studio) that exposes an **OpenAI-compatible** API, with CursorClaw talking to it via the same adapter pattern.
- Examples: Open WebUI (local backend), Jan, or any local service that implements the OpenAI chat/completions and tool-call contract.
- You don’t need a dedicated adapter for discovery: if the server is OpenAI-compatible, you can use the existing **openai-compatible** provider with `baseURL` (Option A). A first-class provider (Option B) is useful when we want a fixed display name, default base URL, or provider-specific docs/runbook.

## Prerequisites

- The local server or UI installed and running, with at least one model loaded.
- The server exposes an OpenAI-compatible API (e.g. `/v1/chat/completions`, tool-call format). Base URL and port are documented by the server (e.g. `http://localhost:8080/v1`).
- Same machine as CursorClaw or reachable network; local use is the typical case per PMR §8.

---

## Config shape

### Option A — Use existing `openai-compatible` (no new adapter)

Any OpenAI-compatible local server can be used with the existing **openai-compatible** provider by setting `baseURL` to the server’s API root.

**Required:** `provider: "openai-compatible"`, `openaiModelId` (use the model name/id the server reports).  
**Optional:** `baseURL` (must point at the local server’s API root, e.g. `http://localhost:8080/v1`), `apiKeyRef` (if the server requires a key; many local servers allow no key for localhost), `timeoutMs`, `authProfiles`, `fallbackModels`, `enabled`, `maxContextTokens`, `paidApi: false` (local, so validation is allowed without `runValidationAgainstPaidApis`).

Example (generic local server on port 8080, model id `my-local-model`):

```json
"my-local-model": {
  "provider": "openai-compatible",
  "openaiModelId": "my-local-model",
  "baseURL": "http://localhost:8080/v1",
  "timeoutMs": 120000,
  "authProfiles": ["default"],
  "fallbackModels": [],
  "enabled": true
}
```

No change to `src/providers/registry.ts` or config schema; add this entry to `config.models` and set `defaultModel` or `fallbackModels` as needed.

#### Example: Open WebUI (Option A)

[Open WebUI](https://github.com/open-webui/open-webui) is a local web UI that can connect to Ollama (or other backends) and exposes an OpenAI-compatible API. Use Option A when you want CursorClaw to talk to Open WebUI’s API instead of Ollama directly.

- **Default API root:** Open WebUI’s API is typically at `http://localhost:8080/v1` (configurable; see Open WebUI docs).
- **Model id:** Use the exact model id that Open WebUI exposes (e.g. the Ollama model name Open WebUI is configured to use, or the id shown in Open WebUI’s model list / API). You can list models from the server or check Open WebUI’s UI.
- **Hardware:** For local inference behind Open WebUI, see [PMR §8.1](PMR-provider-model-resilience.md#81-minimum-hardware-and-model-size-constraints) for minimum hardware and model-size constraints.

Example config (model id `llama3.2` as exposed by Open WebUI):

```json
"open-webui-llama": {
  "provider": "openai-compatible",
  "openaiModelId": "llama3.2",
  "baseURL": "http://localhost:8080/v1",
  "timeoutMs": 120000,
  "authProfiles": ["default"],
  "fallbackModels": [],
  "enabled": true
}
```

If Open WebUI requires an API key (e.g. for remote or secured setups), set `apiKeyRef` (e.g. `env:OPEN_WEBUI_API_KEY`). Many local installs allow no key for localhost.

**Validation:** With the server running and the model loaded in Open WebUI, run:

```bash
npm run validate-model -- --modelId=open-webui-llama --fullSuite
```

Results are written to the validation store; no `runValidationAgainstPaidApis` needed for local use.

### Option B — First-class provider (e.g. `open-webui` or similar)

When we want a **named** provider (e.g. for docs, default base URL, or display in UI):

- **Registry:** Add the provider id (e.g. `open-webui`) to `src/providers/registry.ts` and wire it to the OpenAI-compatible adapter (same as `lm-studio`: reuse `OpenAICompatibleProvider` with a default `baseURL` and optional provider-specific options).
- **Config shape:** Same as LM Studio pattern: **required** `provider: "<new-id>"`, `openaiModelId`; **optional** `baseURL` (default per server docs), `apiKeyRef`, plus common fields (`timeoutMs`, `authProfiles`, `fallbackModels`, `enabled`, `maxContextTokens`, etc.).
- **Config reference:** Add a row in [configuration-reference.md](configuration-reference.md) §4.15 and update [provider-model-support.md](provider-model-support.md) with the new provider and link to this guide (or a provider-specific subsection).
- **Adapter:** In `src/providers/openai-compatible.ts`, extend the provider check to include the new id (e.g. `c.provider === "open-webui"`) and set default `baseURL` when `provider === "open-webui"` (see `lm-studio` implementation).

---

## Validation flow

- **Option A:** Use the existing validation probe. Ensure the model id exists in `config.models` and the local server is running with that model. Run:
  - `npm run validate-model -- --modelId=<id> --fullSuite`
  Results are written to the validation store; local models do not require `runValidationAgainstPaidApis`.
- **Option B:** Same as Option A: the adapter is a thin wrapper around the same OpenAI-compatible API. No separate validation script; document any provider-specific quirks (e.g. different path or headers) and ensure the probe can resolve the model via the new provider.

---

## PMR §8 alignment

| PMR subsection | Alignment |
|----------------|-----------|
| **§8.1 Minimum hardware and model size constraints** | Same as Ollama/LM Studio: point to [PMR §8.1](PMR-provider-model-resilience.md#81-minimum-hardware-and-model-size-constraints) for VRAM/RAM/OS and model-size vs capability. In this doc or the provider-specific setup section, add a short “Hardware” note referring to PMR §8.1. |
| **§8.2 Optional local provider in the validation suite** | Add the model to `config.models`; run `npm run validate-model -- --modelId=<id> --fullSuite`. Results go to the same validation store; if the model passes, it can be used when `useOnlyValidatedFallbacks` is true. Local inference has no per-token cost; `runValidationAgainstPaidApis` does not apply. |
| **§8.3 Graceful degradation** | No parity guarantee with Cursor Auto. Adapter treats the provider like any other fallback: try in order, respect validation state, surface clear errors if no validated model is available. If the local server is absent or unreachable, the app must not crash; the fallback chain skips or fails over to the next candidate. Document timeout and “server not running” in a short Troubleshooting subsection when adding Option B. |

**Doc sync when adding a first-class provider (Option B):** Update [provider-model-support.md](provider-model-support.md) (add row for the new provider; tool-call/validation/local as applicable). Update [configuration-reference.md](configuration-reference.md) §4.15 (provider list, table row, example). Optionally add a “See also” from [local-ollama-agent-setup.md](local-ollama-agent-setup.md) or [lm-studio-implementation-guide.md](lm-studio-implementation-guide.md) for operators who prefer this UI.

---

## Next steps (for implementer)

1. **If Option A is enough:** Document the chosen local server (name, default port, how to get model id) in a short subsection or runbook; no code change.
2. **If Option B (first-class provider):** Create a branch; add the provider id to the registry and openai-compatible adapter (default baseURL); update config reference and provider-model-support.md; add a Setup and Troubleshooting section for the chosen server; run validation and open a PR.
