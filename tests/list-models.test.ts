import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listProviderModels } from "../src/providers/list-models.js";
import type { CursorClawConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";

describe("listProviderModels", () => {
  const baseConfig = loadConfig({
    defaultModel: "cursor-auto",
    models: {
      "cursor-auto": {
        provider: "cursor-agent-cli",
        timeoutMs: 60_000,
        authProfiles: ["default"],
        fallbackModels: [],
        enabled: true
      },
      fallback: {
        provider: "fallback-model",
        timeoutMs: 10_000,
        authProfiles: ["default"],
        fallbackModels: [],
        enabled: true
      }
    }
  }) as CursorClawConfig;

  it("returns config-only model ids for cursor-agent-cli", async () => {
    const result = await listProviderModels("cursor-agent-cli", baseConfig, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toContainEqual({ id: "cursor-auto", name: "cursor-auto" });
      expect(result.models.length).toBe(1);
    }
  });

  it("returns empty list for cursor-agent-cli when no such provider in config", async () => {
    const full = loadConfig({}) as CursorClawConfig;
    const config: CursorClawConfig = {
      ...full,
      defaultModel: "fallback",
      models: {
        fallback: {
          provider: "fallback-model",
          timeoutMs: 10_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      }
    };
    const result = await listProviderModels("cursor-agent-cli", config, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toEqual([]);
  });

  it("returns BAD_REQUEST when providerId is empty", async () => {
    const result = await listProviderModels("  ", baseConfig, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BAD_REQUEST");
      expect(result.error.message).toContain("providerId");
    }
  });

  it("returns UNKNOWN_PROVIDER for unsupported provider", async () => {
    const result = await listProviderModels("unknown-provider", baseConfig, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_PROVIDER");
      expect(result.error.message).toContain("unknown-provider");
    }
  });

  describe("ollama", () => {
    const originalFetch = globalThis.fetch;
    beforeEach(() => {
      globalThis.fetch = vi.fn();
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns models from GET /api/tags when ollama config present", async () => {
      const config = loadConfig({
        defaultModel: "ollama1",
        models: {
          ollama1: {
            provider: "ollama",
            ollamaModelName: "llama3.2",
            baseURL: "http://localhost:11434",
            timeoutMs: 60_000,
            authProfiles: ["default"],
            fallbackModels: [],
            enabled: true
          }
        }
      }) as CursorClawConfig;
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: "llama3.2" }, { name: "granite3.2" }] })
      });
      const result = await listProviderModels("ollama", config, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.models).toEqual([
          { id: "llama3.2", name: "llama3.2" },
          { id: "granite3.2", name: "granite3.2" }
        ]);
      }
      expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:11434/api/tags", { method: "GET" });
    });

    it("returns structured error when ollama /api/tags fails", async () => {
      const config = loadConfig({
        defaultModel: "ollama1",
        models: {
          ollama1: {
            provider: "ollama",
            ollamaModelName: "llama3.2",
            timeoutMs: 60_000,
            authProfiles: ["default"],
            fallbackModels: [],
            enabled: true
          }
        }
      }) as CursorClawConfig;
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        text: async () => "connection refused"
      });
      const result = await listProviderModels("ollama", config, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PROVIDER_ERROR");
        expect(result.error.message).toContain("failed");
      }
    });
  });

  describe("openai-compatible", () => {
    const originalFetch = globalThis.fetch;
    beforeEach(() => {
      globalThis.fetch = vi.fn();
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns NO_CREDENTIAL when apiKeyRef not resolved", async () => {
      const config = loadConfig({
        defaultModel: "openai1",
        models: {
          openai1: {
            provider: "openai-compatible",
            openaiModelId: "gpt-4o-mini",
            apiKeyRef: "profile:openai-compatible",
            timeoutMs: 60_000,
            authProfiles: ["default"],
            fallbackModels: [],
            enabled: true
          }
        }
      }) as CursorClawConfig;
      const result = await listProviderModels("openai-compatible", config, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NO_CREDENTIAL");
      }
    });

    it("returns models from GET /v1/models when apiKey resolved", async () => {
      const prev = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-test";
      try {
        const config = loadConfig({
          defaultModel: "openai1",
          models: {
            openai1: {
              provider: "openai-compatible",
              openaiModelId: "gpt-4o-mini",
              apiKeyRef: "env:OPENAI_API_KEY",
              baseURL: "https://api.openai.com/v1",
              timeoutMs: 60_000,
              authProfiles: ["default"],
              fallbackModels: [],
              enabled: true
            }
          }
        }) as CursorClawConfig;
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }]
        })
      });
      const result = await listProviderModels("openai-compatible", config, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.models).toEqual([
          { id: "gpt-4o-mini", name: "gpt-4o-mini" },
          { id: "gpt-4o", name: "gpt-4o" }
        ]);
      }
        expect(globalThis.fetch).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
          method: "GET",
          headers: { Authorization: "Bearer sk-test" }
        });
      } finally {
        if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
        else delete process.env.OPENAI_API_KEY;
      }
    });
  });
});
