import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { DecisionJournal } from "../src/decision-journal.js";
import { MemoryStore } from "../src/memory.js";
import { FailureLoopGuard } from "../src/reliability/failure-loop.js";
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

describe("runtime failure loop guard integration", () => {
  it("injects multi-path reasoning instruction after repeated failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-failure-loop-"));
    tempDirs.push(dir);

    const observedMessages: Array<Array<{ role: string; content: string }>> = [];
    let callCount = 0;
    const fakeAdapter = {
      createSession: async () => ({
        id: "session",
        model: "fallback"
      }),
      sendTurn: async function* (
        _session: { id: string; model: string },
        messages: Array<{ role: string; content: string }>
      ): AsyncIterable<AdapterEvent> {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("synthetic failure");
        }
        observedMessages.push(messages);
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
      failureLoopGuard: new FailureLoopGuard({
        escalationThreshold: 1
      }),
      snapshotDir: join(dir, "snapshots")
    });

    await expect(
      runtime.runTurn({
        session: {
          sessionId: "s1",
          channelId: "dm:s1",
          channelKind: "dm"
        },
        messages: [{ role: "user", content: "first run" }]
      })
    ).rejects.toThrow(/synthetic failure/);

    const second = await runtime.runTurn({
      session: {
        sessionId: "s1",
        channelId: "dm:s1",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "second run" }]
    });

    expect(second.assistantText).toContain("ok");
    const firstSystemMessage = observedMessages[0]?.find((entry) => entry.role === "system")?.content ?? "";
    expect(firstSystemMessage).toContain("three distinct architectural hypotheses");

    await runtime.runTurn({
      session: {
        sessionId: "s1",
        channelId: "dm:s1",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "third run" }]
    });
    const thirdRunSystemMessage = observedMessages[1]?.find((entry) => entry.role === "system")?.content ?? "";
    expect(thirdRunSystemMessage).not.toContain("three distinct architectural hypotheses");
  });

  it("injects recent decision journal context with bounded history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-journal-context-"));
    tempDirs.push(dir);
    const journal = new DecisionJournal({
      path: join(dir, "CLAW_HISTORY.log"),
      maxBytes: 1024 * 1024
    });
    for (let idx = 0; idx < 8; idx += 1) {
      await journal.append({
        type: "decision",
        summary: `decision-${idx}`
      });
    }

    const observedMessages: Array<Array<{ role: string; content: string }>> = [];
    const fakeAdapter = {
      createSession: async () => ({
        id: "session",
        model: "fallback"
      }),
      sendTurn: async function* (
        _session: { id: string; model: string },
        messages: Array<{ role: string; content: string }>
      ): AsyncIterable<AdapterEvent> {
        observedMessages.push(messages);
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
      decisionJournal: journal,
      snapshotDir: join(dir, "snapshots")
    });

    await runtime.runTurn({
      session: {
        sessionId: "s-journal",
        channelId: "dm:s-journal",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "hello" }]
    });

    const journalMessage =
      observedMessages[0]?.find((entry) => entry.role === "system" && entry.content.includes("decision journal"))
        ?.content ?? "";
    expect(journalMessage).toContain("Recent decision journal context");
    expect(journalMessage).toContain("decision-7");
    expect(journalMessage).not.toContain("decision-0");
    expect(journalMessage).toContain("Maintain rationale continuity");
  });
});
