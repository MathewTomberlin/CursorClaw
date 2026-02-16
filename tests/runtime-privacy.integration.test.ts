import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/memory.js";
import { PrivacyScrubber } from "../src/privacy/privacy-scrubber.js";
import { RuntimeObservationStore } from "../src/runtime-observation.js";
import { AgentRuntime } from "../src/runtime.js";
import { AlwaysAllowApprovalGate, ToolRouter } from "../src/tools.js";
import type { AdapterEvent } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("runtime privacy integration", () => {
  it("scrubs secrets before prompt egress and tool event persistence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-runtime-privacy-"));
    tempDirs.push(dir);

    const capturedMessages: Array<Array<{ role: string; content: string }>> = [];
    const fakeAdapter = {
      createSession: async () => ({
        id: "fake-session",
        model: "fallback"
      }),
      sendTurn: async function* (
        _session: { id: string; model: string },
        messages: Array<{ role: string; content: string }>
      ): AsyncIterable<AdapterEvent> {
        capturedMessages.push(messages);
        yield {
          type: "tool_call",
          data: {
            name: "leaky_tool",
            args: {}
          }
        };
        yield {
          type: "assistant_delta",
          data: {
            content: "token=assistant-secret-abc123xyz"
          }
        };
        yield {
          type: "done",
          data: {}
        };
      },
      cancel: async () => undefined,
      close: async () => undefined
    } as const;

    const config = loadConfig({
      defaultModel: "fallback",
      models: {
        fallback: {
          provider: "fallback-model",
          timeoutMs: 5_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      }
    });
    const memory = new MemoryStore({ workspaceDir: dir });
    const router = new ToolRouter({
      approvalGate: new AlwaysAllowApprovalGate(),
      allowedExecBins: ["echo"]
    });
    router.register({
      name: "leaky_tool",
      description: "returns a synthetic secret payload",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      riskLevel: "low",
      execute: async () => ({
        token: "password=tool-secret-value-987654"
      })
    });
    const runtime = new AgentRuntime({
      config,
      adapter: fakeAdapter as unknown as import("../src/model-adapter.js").CursorAgentModelAdapter,
      toolRouter: router,
      memory,
      privacyScrubber: new PrivacyScrubber({
        enabled: true,
        failClosedOnError: true
      }),
      snapshotDir: join(dir, "snapshots")
    });

    const result = await runtime.runTurn({
      session: {
        sessionId: "s-privacy",
        channelId: "dm:s-privacy",
        channelKind: "dm"
      },
      messages: [
        {
          role: "user",
          content: "token=my-user-secret-abc123456"
        }
      ]
    });

    expect(capturedMessages.length).toBe(1);
    const messages = capturedMessages[0] ?? [];
    expect(messages.every((m) => !m.content.includes("my-user-secret-abc123456"))).toBe(true);
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("[SECRET_ASSIGNMENT_");

    const toolEvent = result.events.find((event) => event.type === "tool");
    const serializedToolEvent = JSON.stringify(toolEvent?.payload ?? {});
    expect(serializedToolEvent).not.toContain("tool-secret-value-987654");
    expect(serializedToolEvent).toContain("SECRET_ASSIGNMENT");

    expect(result.assistantText).not.toContain("assistant-secret-abc123xyz");
    expect(result.assistantText).toContain("SECRET_ASSIGNMENT");
  });

  it("scrubs secret-bearing observation logs before prompt injection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-runtime-observation-scrub-"));
    tempDirs.push(dir);

    const capturedMessages: Array<Array<{ role: string; content: string }>> = [];
    const fakeAdapter = {
      createSession: async () => ({
        id: "fake-session",
        model: "fallback"
      }),
      sendTurn: async function* (
        _session: { id: string; model: string },
        messages: Array<{ role: string; content: string }>
      ): AsyncIterable<AdapterEvent> {
        capturedMessages.push(messages);
        yield { type: "assistant_delta", data: { content: "ok" } };
        yield { type: "done", data: {} };
      },
      cancel: async () => undefined,
      close: async () => undefined
    } as const;

    const config = loadConfig({
      defaultModel: "fallback",
      models: {
        fallback: {
          provider: "fallback-model",
          timeoutMs: 5_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      }
    });
    const observations = new RuntimeObservationStore({
      maxEvents: 10
    });
    await observations.append({
      sessionId: "s-observation",
      source: "logs",
      kind: "crash",
      sensitivity: "operational",
      payload: {
        detail: "token=observation-secret-987654"
      }
    });

    const runtime = new AgentRuntime({
      config,
      adapter: fakeAdapter as unknown as import("../src/model-adapter.js").CursorAgentModelAdapter,
      toolRouter: new ToolRouter({
        approvalGate: new AlwaysAllowApprovalGate(),
        allowedExecBins: ["echo"]
      }),
      memory: new MemoryStore({ workspaceDir: dir }),
      observationStore: observations,
      privacyScrubber: new PrivacyScrubber({
        enabled: true,
        failClosedOnError: true
      }),
      snapshotDir: join(dir, "snapshots")
    });

    await runtime.runTurn({
      session: {
        sessionId: "s-observation",
        channelId: "dm:s-observation",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "use observation context" }]
    });

    const system = capturedMessages[0]?.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("Recent runtime observations");
    expect(system).not.toContain("observation-secret-987654");
    expect(system).toContain("SECRET_ASSIGNMENT");
  });

  it("enforces bounded system prompt budget for observation-heavy contexts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-runtime-budget-"));
    tempDirs.push(dir);

    const capturedMessages: Array<Array<{ role: string; content: string }>> = [];
    const fakeAdapter = {
      createSession: async () => ({
        id: "fake-session",
        model: "fallback"
      }),
      sendTurn: async function* (
        _session: { id: string; model: string },
        messages: Array<{ role: string; content: string }>
      ): AsyncIterable<AdapterEvent> {
        capturedMessages.push(messages);
        yield { type: "assistant_delta", data: { content: "ok" } };
        yield { type: "done", data: {} };
      },
      cancel: async () => undefined,
      close: async () => undefined
    } as const;

    const config = loadConfig({
      session: {
        maxMessageChars: 200
      },
      defaultModel: "fallback",
      models: {
        fallback: {
          provider: "fallback-model",
          timeoutMs: 5_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      }
    });
    const observations = new RuntimeObservationStore({
      maxEvents: 20
    });
    for (let idx = 0; idx < 20; idx += 1) {
      await observations.append({
        sessionId: "s-budget",
        source: "logs",
        kind: "noise",
        sensitivity: "operational",
        payload: {
          detail: "x".repeat(500)
        }
      });
    }

    const runtime = new AgentRuntime({
      config,
      adapter: fakeAdapter as unknown as import("../src/model-adapter.js").CursorAgentModelAdapter,
      toolRouter: new ToolRouter({
        approvalGate: new AlwaysAllowApprovalGate(),
        allowedExecBins: ["echo"]
      }),
      memory: new MemoryStore({ workspaceDir: dir }),
      observationStore: observations,
      snapshotDir: join(dir, "snapshots")
    });

    await runtime.runTurn({
      session: {
        sessionId: "s-budget",
        channelId: "dm:s-budget",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "summarize context" }]
    });

    const systemMessages = capturedMessages[0]?.filter((message) => message.role === "system") ?? [];
    const totalSystemChars = systemMessages.reduce((acc, item) => acc + item.content.length, 0);
    expect(totalSystemChars).toBeLessThanOrEqual(300);
  });

  it("propagates runtime crash observations into prompt context for runtime-only debugging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-runtime-observation-debug-"));
    tempDirs.push(dir);
    const observations = new RuntimeObservationStore({
      maxEvents: 10
    });
    await observations.append({
      sessionId: "s-runtime-bug",
      source: "logs",
      kind: "crash-report",
      sensitivity: "operational",
      payload: {
        stack: "TypeError: cannot read properties of undefined"
      }
    });

    const fakeAdapter = {
      createSession: async () => ({
        id: "fake-session",
        model: "fallback"
      }),
      sendTurn: async function* (
        _session: { id: string; model: string },
        messages: Array<{ role: string; content: string }>
      ): AsyncIterable<AdapterEvent> {
        const observationPrompt = messages.find((message) =>
          message.content.includes("TypeError: cannot read properties of undefined")
        );
        const content = observationPrompt
          ? "Runtime observation ingested: propose null-guard fix path."
          : "No runtime observation available.";
        yield { type: "assistant_delta", data: { content } };
        yield { type: "done", data: {} };
      },
      cancel: async () => undefined,
      close: async () => undefined
    } as const;

    const config = loadConfig({
      defaultModel: "fallback",
      models: {
        fallback: {
          provider: "fallback-model",
          timeoutMs: 5_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      }
    });
    const runtime = new AgentRuntime({
      config,
      adapter: fakeAdapter as unknown as import("../src/model-adapter.js").CursorAgentModelAdapter,
      toolRouter: new ToolRouter({
        approvalGate: new AlwaysAllowApprovalGate(),
        allowedExecBins: ["echo"]
      }),
      memory: new MemoryStore({ workspaceDir: dir }),
      observationStore: observations,
      snapshotDir: join(dir, "snapshots")
    });

    const result = await runtime.runTurn({
      session: {
        sessionId: "s-runtime-bug",
        channelId: "dm:s-runtime-bug",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "help fix runtime crash" }]
    });
    expect(result.assistantText).toContain("Runtime observation ingested");
  });
});
