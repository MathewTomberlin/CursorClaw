# Provider and model support

At-a-glance summary of CursorClaw’s built-in inference providers: what they are, what they support, and where to read more.

## Providers

| Provider | Tool-call | Validation | Local vs hosted | Where to read more |
|----------|-----------|------------|-----------------|--------------------|
| **cursor-agent-cli** | Yes (via Cursor CLI) | Yes | Hosted (Cursor Auto) | [Configuration Reference §4.15](./configuration-reference.md#415-models-and-defaultmodel) |
| **fallback-model** | — | — | Placeholder only (no inference) | [Configuration Reference §4.15](./configuration-reference.md#415-models-and-defaultmodel) |
| **ollama** | Yes (when model supports it) | Yes (`validate-model --fullSuite`) | Local (or remote Ollama server) | [Local Ollama setup](./local-ollama-agent-setup.md), [Ollama tool-call](./Ollama-tool-call-support.md), [PMR §8](./PMR-provider-model-resilience.md#8-local-and-optional-providers-ollama) |
| **openai-compatible** | Depends on endpoint | Yes | Hosted or self-hosted | [Configuration Reference §4.15](./configuration-reference.md#415-models-and-defaultmodel) |
| **lm-studio** | Depends on endpoint | Yes (same as openai-compatible) | Local (default localhost:1234) | [LM Studio implementation guide](./lm-studio-implementation-guide.md), [Configuration Reference §4.15](./configuration-reference.md#415-models-and-defaultmodel), [PMR §8](./PMR-provider-model-resilience.md#8-phase-4--optional-local-models-eg-16gb-vram) |

- **Tool-call:** Whether the provider can send tools and parse tool-call responses in the adapter. Required for full agent flows (e.g. PMR capability suite).
- **Validation:** `npm run validate-model -- --modelId=<id>` (and `--fullSuite` for tool-call + reasoning). Results stored in the PMR validation store; use `providerModelResilience.useOnlyValidatedFallbacks` to restrict fallbacks to validated models.
- **Local vs hosted:** “Local” = runs on your machine (e.g. Ollama); “hosted” = external API. `openai-compatible` can be either depending on `baseURL`.

## Config and resilience

- **Model config (required/optional fields per provider):** [Configuration Reference §4.15](./configuration-reference.md#415-models-and-defaultmodel) — table and examples for all five providers.
- **Validation store and policies:** [Configuration Reference §4.15.1](./configuration-reference.md#4151-providermodelresilience-optional) and [PMR](./PMR-provider-model-resilience.md).
- **Local Ollama (hardware, setup, troubleshooting):** [Local Ollama agent setup](./local-ollama-agent-setup.md) and [PMR §8](PMR-provider-model-resilience.md#8-local-and-optional-providers-ollama).
- **Ollama tool-call (format, models, Granite 3.2):** [Ollama tool-call support](./Ollama-tool-call-support.md).

## Adding or changing providers

New providers follow the implementation-guide-first approach; see [PMR §8](PMR-provider-model-resilience.md#8-local-and-optional-providers-ollama) for the “optional local provider” pattern and implementation-guide-first approach.
