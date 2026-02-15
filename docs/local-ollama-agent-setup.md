# Local Ollama agent — end-to-end setup

This guide walks through running CursorClaw with a **local Ollama** model as the primary or fallback inference provider. For hardware constraints, validation behavior, and graceful degradation, see [PMR — Provider and Model Resilience](PMR-provider-model-resilience.md) §8.

---

## 1. Prerequisites

- **Ollama** installed and running (e.g. `ollama serve` or the Ollama app). Default API: `http://localhost:11434`.
- **Model pulled:** e.g. `ollama pull llama3.2`, `ollama pull granite3.2` (or another model that fits your RAM/VRAM). For **tool use and reasoning**, prefer a model that supports tools—e.g. **Granite 3.2** (`granite3.2` / `ibm-granite3.2`) or others; see [Ollama tool-call support](Ollama-tool-call-support.md).

---

## 2. Add an Ollama model to config

In `openclaw.json` (or via the Config UI):

1. **Add a model entry** under `config.models` with:
   - `provider: "ollama"`
   - `ollamaModelName`: the name used with `ollama pull` (e.g. `llama3.2`)
   - Optional `baseURL`: if Ollama is not on `http://localhost:11434`
   - Optional `timeoutMs`, `authProfiles`, `enabled` as needed

2. **Set usage:**
   - **Primary:** set `config.defaultModel` to this model’s id, or assign the model to a profile and use that profile.
   - **Fallback:** add this model’s id to another model’s `fallbackModels` array.

Example (Ollama as default, with a fallback):

```json
{
  "defaultModel": "ollama-local",
  "models": {
    "ollama-local": {
      "provider": "ollama",
      "ollamaModelName": "llama3.2",
      "baseURL": "http://localhost:11434",
      "timeoutMs": 120000,
      "authProfiles": ["default"],
      "fallbackModels": ["fallback-default"],
      "enabled": true
    },
    "fallback-default": {
      "provider": "cursor-agent-cli",
      "timeoutMs": 120000,
      "authProfiles": ["default"],
      "fallbackModels": [],
      "enabled": true
    }
  }
}
```

Omit `baseURL` to use `http://localhost:11434`. For more examples, see [RUNBOOK.md](../RUNBOOK.md) Step 7.

---

## 3. Validate the model (recommended)

Before relying on the local model in the fallback chain (or with `useOnlyValidatedFallbacks`), run the minimum-capability suite:

```bash
npm run validate-model -- --modelId=ollama-local --fullSuite
```

- **Pass:** The validation store records the model as validated; it can be used when `providerModelResilience.useOnlyValidatedFallbacks` is `true`.
- **Fail:** Fix model/version or network; re-run. Until it passes, the model will not be used when only validated fallbacks are allowed (unless you use `allowOneUnvalidatedAttempt` for the first try).

See [PMR Phase 2](PMR-provider-model-resilience.md) and [configuration-reference](configuration-reference.md) §4.15 for `providerModelResilience` options.

---

## 4. Optional: use only validated fallbacks

To restrict fallbacks to models that have passed validation:

- Set `providerModelResilience.useOnlyValidatedFallbacks: true` in config.
- Ensure at least one model in your chain (default or fallbacks) has passed `validate-model --fullSuite` (e.g. your Ollama model).

If no validated model is available, the adapter fails with a clear error. You can enable `providerModelResilience.allowOneUnvalidatedAttempt` so the first attempt is allowed before requiring validation (see [PMR allow-one-unvalidated](PMR-allow-one-unvalidated.md) and [configuration-reference](configuration-reference.md) §4.15.1).

---

## 5. Run the agent

- **Web UI:** Open Chat, select the profile that uses the Ollama model (or the default profile if `defaultModel` is set), and send a message.
- **RPC:** Use `agent.run` / `agent.wait` as usual; inference will use your local Ollama model when it is the selected or active fallback.

Restart CursorClaw after config changes so the new model and settings are loaded.

---

## 6. Operator-driven run (Ollama-only)

To run the agent using **only** your local Ollama model for a single session:

- **Chat UI:** Open Chat, choose the profile that has the Ollama model as primary (or use the default profile if `defaultModel` is your Ollama model), and send messages. All turns use that model.
- **RPC:** Call `agent.run` / `agent.wait` with the session bound to that profile (or the default). No fallback is used unless you configure one; with only the Ollama model in the chain, every turn goes to Ollama.

So “Ollama-only” means: either set that model as the sole model for the profile (no `fallbackModels`), or set it as default and use no other models in config for that run.

---

## 7. Success criteria

- Ollama is running and the chosen model is pulled.
- Config contains a model with `provider: "ollama"`, `ollamaModelName`, and optional `baseURL`.
- `defaultModel` or a profile’s model points to that Ollama model (or it appears in `fallbackModels`).
- Optional: `npm run validate-model -- --modelId=<id> --fullSuite` passes; optional `useOnlyValidatedFallbacks: true` is set if desired.
- The agent completes at least one turn using the local Ollama model (Chat or RPC).

---

## 8. Tool use and tool-call validation

The Ollama provider supports **tool-call** flow: it sends tools to the Ollama API and parses tool-call responses into adapter events. When your model and Ollama version support tools:

- **`validate-model --fullSuite`** includes the tool-call check for Ollama models; use it to confirm tool capability before relying on it in the fallback chain.
- **Runtime tool use** works: the agent receives `tool_call` events and can execute tools and continue the loop.

If the model or Ollama does not support tools, the agent still runs for text-only turns. See [Ollama-tool-call-support.md](Ollama-tool-call-support.md) and [PMR](PMR-provider-model-resilience.md) §8 for version/model requirements and best-effort behavior.

**Granite 3.2:** For strong tool use and reasoning with a single model, consider **Granite 3.2** (e.g. `ollama pull granite3.2`). Configure it with `ollamaModelName: "granite3.2"` (or the exact name shown by `ollama list`). Run `npm run validate-model -- --modelId=<your-granite-model-id> --fullSuite` to confirm tool-call and reasoning checks pass.
