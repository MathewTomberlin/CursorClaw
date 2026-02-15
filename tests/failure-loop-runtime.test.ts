import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { DecisionJournal } from "../src/decision-journal.js";
import { MemoryStore } from "../src/memory.js";
import { DeepScanService } from "../src/reliability/deep-scan.js";
import { FailureLoopGuard } from "../src/reliability/failure-loop.js";
import { ReasoningResetController } from "../src/reliability/reasoning-reset.js";
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
    const firstSystemMessage = observedMessages[0]
      ?.filter((entry) => entry.role === "system")
      .map((entry) => entry.content)
      .join("\n") ?? "";
    expect(firstSystemMessage).toContain("three distinct architectural hypotheses");

    await runtime.runTurn({
      session: {
        sessionId: "s1",
        channelId: "dm:s1",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "third run" }]
    });
    const thirdRunSystemMessage = observedMessages[1]
      ?.filter((entry) => entry.role === "system")
      .map((entry) => entry.content)
      .join("\n") ?? "";
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

  it("respects continuity.decisionJournalReplayCount when injecting decision journal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-journal-replay-count-"));
    tempDirs.push(dir);
    const journal = new DecisionJournal({
      path: join(dir, "CLAW_HISTORY.log"),
      maxBytes: 1024 * 1024
    });
    for (let idx = 0; idx < 5; idx += 1) {
      await journal.append({
        type: "decision",
        summary: `decision-${idx}`
      });
    }

    const observedMessages: Array<Array<{ role: string; content: string }>> = [];
    const fakeAdapter = {
      createSession: async () => ({ id: "session", model: "fallback" }),
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
      },
      continuity: { decisionJournalReplayCount: 2 }
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
        sessionId: "s-replay-count",
        channelId: "dm:s-replay-count",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "hi" }]
    });

    const journalMessage =
      observedMessages[0]?.find((entry) => entry.role === "system" && entry.content.includes("decision journal"))
        ?.content ?? "";
    expect(journalMessage).toContain("Recent decision journal context");
    expect(journalMessage).toContain("decision-4");
    expect(journalMessage).toContain("decision-3");
    expect(journalMessage).not.toContain("decision-2");
    expect(journalMessage).toContain("Maintain rationale continuity");
  });

  it("respects continuity.decisionJournalReplayMode sinceLastSession when sessionStartMs is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-journal-mode-session-"));
    tempDirs.push(dir);
    const journal = new DecisionJournal({
      path: join(dir, "CLAW_HISTORY.log"),
      maxBytes: 1024 * 1024
    });
    const sessionStartMs = Date.now() - 2000;
    await journal.append({ type: "decision", summary: "during-session" });

    const observedMessages: Array<Array<{ role: string; content: string }>> = [];
    const fakeAdapter = {
      createSession: async () => ({ id: "session", model: "fallback" }),
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
      },
      continuity: { decisionJournalReplayCount: 5, decisionJournalReplayMode: "sinceLastSession" }
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
      sessionStartMs,
      snapshotDir: join(dir, "snapshots")
    });

    await runtime.runTurn({
      session: { sessionId: "s-mode", channelId: "dm:s-mode", channelKind: "dm" },
      messages: [{ role: "user", content: "hi" }]
    });

    const journalMessage =
      observedMessages[0]?.find((entry) => entry.role === "system" && entry.content.includes("decision journal"))
        ?.content ?? "";
    expect(journalMessage).toContain("Recent decision journal context");
    expect(journalMessage).toContain("during-session");
    expect(journalMessage).toContain("Maintain rationale continuity");
  });

  it("triggers reasoning reset with deep scan context after repeated failed iterations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-reasoning-reset-"));
    tempDirs.push(dir);
    let callCount = 0;
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
        callCount += 1;
        if (callCount < 3) {
          throw new Error("forced failure");
        }
        observedMessages.push(messages);
        yield { type: "assistant_delta", data: { content: "resolved" } };
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
      reasoningResetController: new ReasoningResetController({
        iterationThreshold: 3
      }),
      deepScanService: {
        scanRecentlyTouched: async () => ({
          touchedFiles: ["src/app.ts", "openclaw.json"],
          configCandidates: ["openclaw.json"],
          durationMs: 10
        })
      } as unknown as DeepScanService,
      snapshotDir: join(dir, "snapshots")
    });

    await expect(
      runtime.runTurn({
        session: {
          sessionId: "s-reset",
          channelId: "dm:s-reset",
          channelKind: "dm"
        },
        messages: [{ role: "user", content: "attempt 1" }]
      })
    ).rejects.toThrow(/forced failure/);
    await expect(
      runtime.runTurn({
        session: {
          sessionId: "s-reset",
          channelId: "dm:s-reset",
          channelKind: "dm"
        },
        messages: [{ role: "user", content: "attempt 2" }]
      })
    ).rejects.toThrow(/forced failure/);
    await runtime.runTurn({
      session: {
        sessionId: "s-reset",
        channelId: "dm:s-reset",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "attempt 3" }]
    });

    const joinedSystem = observedMessages[0]
      ?.filter((entry) => entry.role === "system")
      .map((entry) => entry.content)
      .join("\n") ?? "";
    expect(joinedSystem).toContain("Assumption invalidation deep scan");
    expect(joinedSystem).toContain("openclaw.json");
  });
});
