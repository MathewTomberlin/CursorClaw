import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/memory.js";
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

describe("runtime context drift controls", () => {
  it("deprioritizes stale messages and annotates contradictions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-context-drift-"));
    tempDirs.push(dir);
    const capturedPrompts: Array<Array<{ role: string; content: string }>> = [];
    const fakeAdapter = {
      createSession: async () => ({
        id: "session",
        model: "fallback"
      }),
      sendTurn: async function* (
        _session: { id: string; model: string },
        messages: Array<{ role: string; content: string }>
      ): AsyncIterable<AdapterEvent> {
        capturedPrompts.push(messages);
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
    const runtime = new AgentRuntime({
      config,
      adapter: fakeAdapter as unknown as import("../src/model-adapter.js").CursorAgentModelAdapter,
      toolRouter: new ToolRouter({
        approvalGate: new AlwaysAllowApprovalGate(),
        allowedExecBins: ["echo"]
      }),
      memory: new MemoryStore({ workspaceDir: dir }),
      snapshotDir: join(dir, "snapshots")
    });

    const oldMessages = Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const,
      content: `older-${index}: skip tests for now`
    }));
    await runtime.runTurn({
      session: {
        sessionId: "s-context",
        channelId: "dm:s-context",
        channelKind: "dm"
      },
      messages: [
        ...oldMessages,
        { role: "user", content: "Please run tests and refactor if needed." },
        { role: "user", content: "Do not refactor everything." }
      ]
    });

    const prompt = capturedPrompts[0] ?? [];
    const userPromptMessages = prompt.filter((message) => message.role === "user");
    expect(userPromptMessages.length).toBeLessThanOrEqual(8);
    const systemJoined = prompt
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    expect(systemJoined).toContain("Context freshness policy retained");
    expect(systemJoined).toContain("Conflicting directives found");
  });
});
