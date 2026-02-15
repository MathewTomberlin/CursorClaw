import type { ModelProvider } from "./types.js";
import type { CursorClawConfig } from "../config.js";
import { CursorAgentCliProvider } from "./cursor-agent-cli.js";
import { FallbackModelProvider } from "./fallback.js";

/** Config slice needed to create providers (models + defaultModel). */
export type ProviderRegistryConfig = Pick<CursorClawConfig, "models" | "defaultModel">;

export type ProviderFactory = (config: ProviderRegistryConfig) => ModelProvider;

const builtin: Record<string, ProviderFactory> = {
  "cursor-agent-cli": (config) => new CursorAgentCliProvider(),
  "fallback-model": () => new FallbackModelProvider()
};

const cache = new Map<string, ModelProvider>();

/**
 * Get a model provider by id. Uses built-in registry (cursor-agent-cli, fallback-model).
 * Instances are cached per provider id so metrics/logs can be read from the same instance.
 */
export function getProvider(providerId: string, config: ProviderRegistryConfig): ModelProvider {
  let provider = cache.get(providerId);
  if (!provider) {
    const factory = builtin[providerId];
    if (!factory) {
      throw new Error(`unknown model provider: ${providerId}`);
    }
    provider = factory(config);
    cache.set(providerId, provider);
  }
  return provider;
}

/**
 * Register a custom provider (e.g. for tests or future ollama/openai).
 * Clears the cache for that id so the next getProvider returns a new instance.
 */
export function registerProvider(providerId: string, factory: ProviderFactory): void {
  (builtin as Record<string, ProviderFactory>)[providerId] = factory;
  cache.delete(providerId);
}

/**
 * Clear provider cache. Useful in tests.
 */
export function clearProviderCache(): void {
  cache.clear();
}
