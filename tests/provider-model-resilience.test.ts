import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelAdapter, AdapterEvent, ModelSessionHandle } from "../src/types.js";
import type { CursorClawConfig } from "../src/config.js";
import {
  resolveValidationStorePath,
  readValidationStore,
  writeValidationStore,
  updateValidationResult,
  isModelValidated,
  type ProviderModelValidationStore
} from "../src/provider-model-resilience/validation-store.js";
import { runProbe } from "../src/provider-model-resilience/probe.js";
import { CursorAgentModelAdapter } from "../src/model-adapter.js";
import type { ToolDefinition } from "../src/types.js";

describe("provider-model-resilience validation store", () => {
  it("resolveValidationStorePath uses default when config path absent", () => {
    const path = resolveValidationStorePath(undefined, "/cwd");
    expect(path).toMatch(/provider-model-validation\.json$/);
    expect(path).toContain("run");
  });

  it("resolveValidationStorePath uses config path when provided", () => {
    const path = resolveValidationStorePath("custom/validation.json", "/cwd");
    expect(path).toMatch(/custom[\\/]validation\.json$/);
  });

  it("readValidationStore returns empty when file missing", async () => {
    const path = join(tmpdir(), "cursorclaw-pmr-missing-" + Date.now(), "store.json");
    const data = await readValidationStore(path);
    expect(data.lastUpdated).toBeDefined();
    expect(data.results).toEqual({});
  });

  it("readValidationStore returns empty when file has invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-pmr-"));
    const path = join(dir, "store.json");
    try {
      await writeFile(path, "not json", "utf-8");
      const data = await readValidationStore(path);
      expect(data.results).toEqual({});
    } finally {
      await rm(dir, { recursive: true }).catch(() => {});
    }
  });

  it("writeValidationStore and readValidationStore round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-pmr-"));
    const path = join(dir, "store.json");
    try {
      const store: ProviderModelValidationStore = {
        lastUpdated: "2026-01-01T00:00:00.000Z",
        results: {
          "model-a": {
            passed: true,
            lastRun: "2026-01-01T00:00:00.000Z",
            checks: { toolCall: true },
            error: null
          }
        }
      };
      await writeValidationStore(path, store);
      const read = await readValidationStore(path);
      expect(read.results["model-a"]?.passed).toBe(true);
      expect(read.results["model-a"]?.checks?.toolCall).toBe(true);
    } finally {
      await rm(dir, { recursive: true }).catch(() => {});
    }
  });

  it("updateValidationResult merges into existing store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-pmr-"));
    const path = join(dir, "store.json");
    try {
      await writeValidationStore(path, { lastUpdated: "", results: {} });
      await updateValidationResult(path, "m1", {
        passed: true,
        lastRun: "",
        checks: { toolCall: true },
        error: null
      });
      await updateValidationResult(path, "m2", {
        passed: false,
        lastRun: "",
        checks: { toolCall: false },
        error: "timeout"
      });
      const data = await readValidationStore(path);
      expect(data.results["m1"]?.passed).toBe(true);
      expect(data.results["m2"]?.passed).toBe(false);
      expect(data.results["m2"]?.error).toBe("timeout");
    } finally {
      await rm(dir, { recursive: true }).catch(() => {});
    }
  });

  it("isModelValidated returns false when store file does not exist", async () => {
    const path = join(tmpdir(), "cursorclaw-pmr-nonexistent-" + Date.now(), "store.json");
    expect(await isModelValidated(path, "any")).toBe(false);
  });

  it("isModelValidated returns true when store has passed result on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-pmr-"));
    const path = join(dir, "store.json");
    try {
      await writeValidationStore(path, {
        lastUpdated: "",
        results: { x: { passed: true, lastRun: "", checks: {}, error: null } }
      });
      expect(await isModelValidated(path, "x")).toBe(true);
      expect(await isModelValidated(path, "y")).toBe(false);
    } finally {
      await rm(dir, { recursive: true }).catch(() => {});
    }
  });
});

function mockAdapter(events: AdapterEvent[]): ModelAdapter {
  return {
    createSession: async (_ctx, opts) => ({
      id: "s1",
      model: opts?.modelId ?? "default",
      authProfile: "default"
    }),
    sendTurn: async function* () {
      for (const e of events) {
        yield e;
      }
    },
    cancel: async () => {},
    close: async () => {}
  };
}

function minimalConfig(modelId: string): CursorClawConfig {
  return {
    models: {
      [modelId]: {
        provider: "fallback-model",
        timeoutMs: 10_000,
        authProfiles: ["default"],
        fallbackModels: [],
        enabled: true
      }
    },
    defaultModel: modelId
  } as unknown as CursorClawConfig;
}

describe("provider-model-resilience probe", () => {
  it("runProbe passes when stream has tool_call and done", async () => {
    const adapter = mockAdapter([
      { type: "tool_call", data: { name: "echo", args: {} } },
      { type: "done" }
    ]);
    const config = minimalConfig("test");
    const outcome = await runProbe("test", config, { adapter });
    expect(outcome.passed).toBe(true);
    expect(outcome.checks.toolCall).toBe(true);
    expect(outcome.error).toBeNull();
  });

  it("runProbe fails when stream has no tool_call", async () => {
    const adapter = mockAdapter([{ type: "done" }]);
    const config = minimalConfig("test");
    const outcome = await runProbe("test", config, { adapter });
    expect(outcome.passed).toBe(false);
    expect(outcome.checks.toolCall).toBe(false);
  });

  it("runProbe fails when stream has tool_call but no done", async () => {
    const adapter = mockAdapter([{ type: "tool_call", data: { name: "echo", args: {} } }]);
    const config = minimalConfig("test");
    const outcome = await runProbe("test", config, { adapter, timeoutMs: 50 });
    expect(outcome.passed).toBe(false);
    expect(outcome.checks.toolCall).toBe(true);
  });

  it("runProbe fails when adapter throws", async () => {
    const adapter: ModelAdapter = {
      createSession: async () => ({ id: "s1", model: "test", authProfile: "default" }),
      sendTurn: async function* () {
        throw new Error("provider error");
      },
      cancel: async () => {},
      close: async () => {}
    };
    const config = minimalConfig("test");
    const outcome = await runProbe("test", config, { adapter });
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("provider error");
  });

  it("runProbe returns error when model not in config", async () => {
    const config = minimalConfig("other");
    const outcome = await runProbe("missing", config);
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("not in config");
  });

  it("runProbe with fullSuite passes when tool_call + done then reasoning (4) + done", async () => {
    const turn1: AdapterEvent[] = [
      { type: "tool_call", data: { name: "echo", args: {} } },
      { type: "done" }
    ];
    const turn2: AdapterEvent[] = [
      { type: "assistant_delta", data: { content: "4" } },
      { type: "done" }
    ];
    let callCount = 0;
    const adapter: ModelAdapter = {
      createSession: async (_ctx, opts) => ({
        id: "s1",
        model: opts?.modelId ?? "default",
        authProfile: "default"
      }),
      sendTurn: async function* (_session, _messages, _tools) {
        const events = callCount === 0 ? turn1 : turn2;
        callCount++;
        for (const e of events) {
          yield e;
        }
      },
      cancel: async () => {},
      close: async () => {}
    };
    const config = minimalConfig("test");
    const outcome = await runProbe("test", config, { adapter, fullSuite: true });
    expect(outcome.passed).toBe(true);
    expect(outcome.checks.toolCall).toBe(true);
    expect(outcome.checks.reasoning).toBe(true);
    expect(outcome.error).toBeNull();
  });

  it("runProbe with fullSuite fails when reasoning response lacks 4", async () => {
    const turn1: AdapterEvent[] = [
      { type: "tool_call", data: { name: "echo", args: {} } },
      { type: "done" }
    ];
    const turn2: AdapterEvent[] = [
      { type: "assistant_delta", data: { content: "five" } },
      { type: "done" }
    ];
    let callCount = 0;
    const adapter: ModelAdapter = {
      createSession: async () => ({ id: "s1", model: "test", authProfile: "default" }),
      sendTurn: async function* () {
        const events = callCount === 0 ? turn1 : turn2;
        callCount++;
        for (const e of events) {
          yield e;
        }
      },
      cancel: async () => {},
      close: async () => {}
    };
    const config = minimalConfig("test");
    const outcome = await runProbe("test", config, { adapter, fullSuite: true });
    expect(outcome.passed).toBe(false);
    expect(outcome.checks.toolCall).toBe(true);
    expect(outcome.checks.reasoning).toBe(false);
    expect(outcome.error).toContain("reasoning");
  });
});

const simpleTool: ToolDefinition = {
  name: "echo_tool",
  description: "echo",
  schema: { type: "object", properties: {}, additionalProperties: false },
  riskLevel: "low",
  execute: async (args) => args
};

describe("useOnlyValidatedFallbacks policy (PMR Phase 3)", () => {
  it("filters fallback chain to validated models only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-pmr-policy-"));
    const storePath = join(dir, "store.json");
    try {
      await writeValidationStore(storePath, {
        lastUpdated: "",
        results: {
          primary: { passed: false, lastRun: "", checks: {}, error: "timeout" },
          "fallback-b": { passed: true, lastRun: "", checks: { toolCall: true }, error: null }
        }
      });
      const adapter = new CursorAgentModelAdapter({
        defaultModel: "primary",
        models: {
          primary: {
            provider: "fallback-model",
            timeoutMs: 5_000,
            authProfiles: ["default"],
            fallbackModels: ["fallback-b"],
            enabled: true
          },
          "fallback-b": {
            provider: "fallback-model",
            timeoutMs: 5_000,
            authProfiles: ["default"],
            fallbackModels: [],
            enabled: true
          }
        },
        providerModelResilience: { useOnlyValidatedFallbacks: true, validationStorePath: storePath },
        cwd: dir
      });
      const session = await adapter.createSession({
        sessionId: "s1",
        channelId: "c1",
        channelKind: "dm"
      });
      const events: string[] = [];
      for await (const event of adapter.sendTurn(
        session,
        [{ role: "user", content: "hi" }],
        [simpleTool],
        { turnId: "t1" }
      )) {
        events.push(event.type);
      }
      expect(events).toContain("done");
      expect(session.model).toBe("fallback-b");
    } finally {
      await rm(dir, { recursive: true }).catch(() => {});
    }
  });

  it("throws clear error when no validated model available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-pmr-policy-"));
    const storePath = join(dir, "store.json");
    try {
      await writeValidationStore(storePath, {
        lastUpdated: "",
        results: {
          primary: { passed: false, lastRun: "", checks: {}, error: "timeout" }
        }
      });
      const adapter = new CursorAgentModelAdapter({
        defaultModel: "primary",
        models: {
          primary: {
            provider: "fallback-model",
            timeoutMs: 5_000,
            authProfiles: ["default"],
            fallbackModels: [],
            enabled: true
          }
        },
        providerModelResilience: { useOnlyValidatedFallbacks: true, validationStorePath: storePath },
        cwd: dir
      });
      const session = await adapter.createSession({
        sessionId: "s1",
        channelId: "c1",
        channelKind: "dm"
      });
      const collect = async (): Promise<void> => {
        for await (const _event of adapter.sendTurn(
          session,
          [{ role: "user", content: "hi" }],
          [simpleTool],
          { turnId: "t2" }
        )) {
          // no-op
        }
      };
      await expect(collect()).rejects.toThrow(/no validated model available/);
      await expect(collect()).rejects.toThrow(/useOnlyValidatedFallbacks to false/);
    } finally {
      await rm(dir, { recursive: true }).catch(() => {});
    }
  });
});
