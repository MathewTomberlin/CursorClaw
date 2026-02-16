/**
 * List models from a provider (Ollama, OpenAI-compatible, or config-only for cursor-agent-cli).
 * Used by provider.models.list RPC for discovery; never logs API keys.
 */

import type { CursorClawConfig, ModelProviderConfig } from "../config.js";
import { resolveApiKeyAsync } from "../security/credential-resolver.js";

export interface ProviderModel {
  id: string;
  name?: string;
}

export type ListProviderModelsResult =
  | { ok: true; models: ProviderModel[] }
  | { ok: false; error: { code: string; message: string } };

function getFirstModelConfigForProvider(
  config: CursorClawConfig,
  providerId: string
): ModelProviderConfig | undefined {
  for (const entry of Object.entries(config.models)) {
    if (entry[1].provider === providerId) return entry[1];
  }
  return undefined;
}

/**
 * List models for the given provider. Returns a result object (success or structured error).
 * Never logs API keys or credential data.
 */
export async function listProviderModels(
  providerId: string,
  config: CursorClawConfig,
  profileRoot: string | undefined
): Promise<ListProviderModelsResult> {
  const trimmed = providerId.trim();
  if (!trimmed) {
    return { ok: false, error: { code: "BAD_REQUEST", message: "providerId is required" } };
  }

  if (trimmed === "cursor-agent-cli") {
    const models: ProviderModel[] = [];
    for (const [id, modelConfig] of Object.entries(config.models)) {
      if (modelConfig.provider === "cursor-agent-cli") {
        models.push({ id, name: id });
      }
    }
    return { ok: true, models };
  }

  if (trimmed === "ollama") {
    const modelConfig = getFirstModelConfigForProvider(config, "ollama");
    const baseURL = (modelConfig?.baseURL ?? "http://localhost:11434").replace(/\/$/, "");
    try {
      const res = await fetch(`${baseURL}/api/tags`, { method: "GET" });
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          error: {
            code: "PROVIDER_ERROR",
            message: `Ollama /api/tags failed: ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`
          }
        };
      }
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      const list = data?.models ?? [];
      const models: ProviderModel[] = list.map((m) => {
        const id = typeof m.name === "string" && m.name ? m.name : String(m.name ?? "");
        const name = typeof m.name === "string" && m.name ? m.name : undefined;
        return name !== undefined ? { id, name } : { id };
      });
      return { ok: true, models };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: "NETWORK_ERROR", message } };
    }
  }

  if (trimmed === "openai-compatible") {
    const modelConfig = getFirstModelConfigForProvider(config, "openai-compatible");
    const baseURL = (modelConfig?.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKey = await resolveApiKeyAsync(modelConfig?.apiKeyRef, profileRoot);
    if (!apiKey) {
      return {
        ok: false,
        error: {
          code: "NO_CREDENTIAL",
          message: "OpenAI-compatible provider requires apiKeyRef (env or profile) to be set"
        }
      };
    }
    try {
      const res = await fetch(`${baseURL}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) {
        if (res.status === 401) {
          return { ok: false, error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } };
        }
        const text = await res.text();
        return {
          ok: false,
          error: {
            code: "PROVIDER_ERROR",
            message: `OpenAI /v1/models failed: ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`
          }
        };
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const list = data?.data ?? [];
      const models: ProviderModel[] = list.map((m) => {
        const id = typeof m.id === "string" && m.id ? m.id : String(m.id ?? "");
        const name = typeof m.id === "string" && m.id ? m.id : undefined;
        return name !== undefined ? { id, name } : { id };
      });
      return { ok: true, models };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: "NETWORK_ERROR", message } };
    }
  }

  if (trimmed === "lm-studio") {
    const modelConfig = getFirstModelConfigForProvider(config, "lm-studio");
    const baseURL = (modelConfig?.baseURL ?? "http://localhost:1234/v1").replace(/\/$/, "");
    let apiKey = await resolveApiKeyAsync(modelConfig?.apiKeyRef, profileRoot);
    if (!apiKey) apiKey = " ";
    try {
      const res = await fetch(`${baseURL}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) {
        if (res.status === 401) {
          return { ok: false, error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } };
        }
        const text = await res.text();
        return {
          ok: false,
          error: {
            code: "PROVIDER_ERROR",
            message: `LM Studio /v1/models failed: ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`
          }
        };
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const list = data?.data ?? [];
      const models: ProviderModel[] = list.map((m) => {
        const id = typeof m.id === "string" && m.id ? m.id : String(m.id ?? "");
        const name = typeof m.id === "string" && m.id ? m.id : undefined;
        return name !== undefined ? { id, name } : { id };
      });
      return { ok: true, models };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: "NETWORK_ERROR", message } };
    }
  }

  return {
    ok: false,
    error: { code: "UNKNOWN_PROVIDER", message: `Provider ${trimmed} does not support model listing` }
  };
}
