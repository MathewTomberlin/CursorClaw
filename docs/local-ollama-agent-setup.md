# Local Ollama agent — end-to-end setup

This guide walks through running CursorClaw with a **local Ollama** model as the primary or fallback inference provider. For hardware constraints, validation behavior, and graceful degradation, see [PMR — Provider and Model Resilience](PMR-provider-model-resilience.md) §8.

---

## 1. Prerequisites

- **Ollama** installed and running (e.g. `ollama serve` or the Ollama app). Default API: `http://localhost:11434`.
- **Model pulled:** e.g. `ollama pull qwen3:8b`, `ollama pull granite3.2` (or another model that fits your RAM/VRAM). For **tool use and reasoning**, prefer **Qwen3 8B** (`qwen3:8b`) or **Granite 3.2** (`granite3.2`); see [Ollama tool-call support](Ollama-tool-call-support.md).

### 1.1 Hardware and model size (optional)

For minimum hardware and model-size guidance (VRAM, RAM, OS), see [PMR §8.1](PMR-provider-model-resilience.md#81-minimum-hardware-and-model-size-constraints). In short: **16GB VRAM** or **32GB RAM** (CPU) is a practical minimum for tool-capable models (e.g. 7B–13B); use `npm run validate-model -- --modelId=<id> --fullSuite` to confirm your setup passes before relying on it in the fallback chain.

---

## 2. Add an Ollama model to config

In `openclaw.json` (or via the Config UI):

1. **Add a model entry** under `config.models` with:
   - `provider: "ollama"`
   - `ollamaModelName`: the name used with `ollama pull` (e.g. `qwen3:8b`, `llama3.2`)
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
      "ollamaModelName": "qwen3:8b",
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

Omit `baseURL` to use `http://localhost:11434`. For more examples, see [RUNBOOK.md](../RUNBOOK.md) Step 7. If you see connection or model-not-found errors, see [§9 Troubleshooting](#9-troubleshooting).

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
- **Ollama-specific prompt:** When the active model is Ollama, the runtime injects an extra system message that explicitly requires the model to use tools to read or update substrate and files (e.g. exec with cat/type for reads, sed/echo for edits). This helps capable models like **Qwen3 8B** and Granite 3.2 actually call tools instead of answering from context.

If the model or Ollama does not support tools, the agent still runs for text-only turns. See [Ollama-tool-call-support.md](Ollama-tool-call-support.md) and [PMR](PMR-provider-model-resilience.md) §8 for version/model requirements and best-effort behavior.

**Qwen3 8B (recommended):** For strong tool use and reasoning with a single model, use **Qwen3 8B** (e.g. `ollama pull qwen3:8b`). Configure it with `ollamaModelName: "qwen3:8b"` (or the exact name from `ollama list`). Run `npm run validate-model -- --modelId=<your-qwen-model-id> --fullSuite` to confirm tool-call and reasoning checks pass. Optional **`ollamaOptions`** (e.g. `{ "temperature": 0.2, "num_ctx": 16384 }`) tunes the request; when omitted, the provider uses defaults (temperature 0.3, num_ctx 8192) when tools are sent. See [Ollama-tool-call-support.md](Ollama-tool-call-support.md) §7 (Qwen3 8B and tuning). **Granite 3.2** is also supported as an alternative.

**Context mode (minimal vs richer):** Use **`toolTurnContext: "minimal"`** and **`ollamaMinimalSystem: true`** when you want the model to always use minimal, tool-focused context (best for reliable tool calls). To let the runtime **choose per turn**—minimal when the user asks for file/substrate/workspace actions and richer when the user asks for explanations, summaries, or chat—set **`ollamaContextMode: "auto"`** on the model instead. Manual override: `ollamaContextMode: "minimal"` or `"full"` to force one behavior. See [context-aware-system-behavior.md](context-aware-system-behavior.md).

---

## 9. Troubleshooting

- **Connection refused / ECONNREFUSED:** Ollama is not running or not reachable at `baseURL`. Start Ollama (`ollama serve` or the Ollama app) and ensure the URL and port match your config.
- **Model not found / 404:** The `ollamaModelName` in config must match the name from `ollama list`. Pull the model first: `ollama pull <name>`.
- **Timeout / slow inference:** Local models (especially on CPU or limited VRAM) can be slow. Increase the model’s `timeoutMs` in config if requests often time out. See [PMR §8](PMR-provider-model-resilience.md#8-local-and-optional-providers-ollama) for graceful degradation and fallback behavior.
- **Out of memory or very slow inference:** Use a smaller model or reduce context size (e.g. `maxContextTokens` in config). See [PMR §8.1](PMR-provider-model-resilience.md#81-minimum-hardware-and-model-size-constraints) for hardware guidance and the configuration reference for model/config options.
- **Validation fails:** Run `npm run validate-model -- --modelId=<id> --fullSuite` and fix any reported errors (e.g. timeout, tool-call unsupported). See [PMR §8](PMR-provider-model-resilience.md#8-local-and-optional-providers-ollama) and [Ollama tool-call support](Ollama-tool-call-support.md) for version and model requirements.
- **Model never calls tools (e.g. Qwen3 8B answers without reading files):** The runtime injects an Ollama-specific system prompt that instructs the model to use tools for reads/edits. Ensure you are on a recent CursorClaw version and that the active profile uses the Ollama model (not a fallback). If it still does not call tools, run `validate-model --fullSuite` to confirm the model passes the tool-call check; see [Ollama-tool-call-support.md](Ollama-tool-call-support.md) §7 (Qwen3 8B and tuning).

---

## See also

- [Provider and model support](provider-model-support.md) — at-a-glance table of all providers (Ollama, cursor-agent-cli, openai-compatible, etc.).
- [Configuration Reference §4.15](configuration-reference.md#415-models-and-defaultmodel) — full model config fields and examples.
- [LM Studio implementation guide](lm-studio-implementation-guide.md) — optional local provider when you prefer LM Studio over Ollama (placeholder until implemented).
