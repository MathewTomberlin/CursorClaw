import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/memory.js";
import { PrivacyScrubber } from "../src/privacy/privacy-scrubber.js";
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
    expect(capturedMessages[0]?.[0]?.content).not.toContain("my-user-secret-abc123456");
    expect(capturedMessages[0]?.[0]?.content).toContain("[SECRET_ASSIGNMENT_");

    const toolEvent = result.events.find((event) => event.type === "tool");
    const serializedToolEvent = JSON.stringify(toolEvent?.payload ?? {});
    expect(serializedToolEvent).not.toContain("tool-secret-value-987654");
    expect(serializedToolEvent).toContain("SECRET_ASSIGNMENT");

    expect(result.assistantText).not.toContain("assistant-secret-abc123xyz");
    expect(result.assistantText).toContain("SECRET_ASSIGNMENT");
  });
});
