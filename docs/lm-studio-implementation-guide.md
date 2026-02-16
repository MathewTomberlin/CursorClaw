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

**Status:** No adapter or registry entry yet. Success criteria for implementation:

1. **Doc in `docs/`** — This file; expand with setup, config shape, validation, and PMR §8 alignment (see below).
2. **Setup** — How to install/run LM Studio, expose the local server (e.g. OpenAI-compatible API on localhost), and which models to load.
3. **Config shape** — Model entry in `config.models`: provider id (e.g. `lm-studio` or reuse `openai-compatible` with `baseURL`), required/optional fields, example `openclaw.json` snippet.
4. **Validation** — Use existing `npm run validate-model -- --modelId=<id> --fullSuite` if the adapter is OpenAI-compatible; otherwise document any provider-specific validation steps.
5. **PMR §8 alignment** — Hardware/constraints (see PMR §8.1), validation store and fallback behavior (§8.2), graceful degradation (§8.3). Sync [provider-model-support.md](provider-model-support.md) and [configuration-reference.md](configuration-reference.md) §4.15 when the provider is added.

**Reference:** [Local Ollama agent setup](local-ollama-agent-setup.md) is the template for local-provider setup, validation, and docs. [Configuration Reference §4.15](configuration-reference.md#415-models-and-defaultmodel) lists existing providers and config shape.

When implementation starts: create a branch, implement adapter/registry and config, add tests and docs, push, and open a PR for review.
