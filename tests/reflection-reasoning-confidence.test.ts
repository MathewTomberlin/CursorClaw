import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/memory.js";
import { IdleReflectionScheduler } from "../src/reflection/idle-scheduler.js";
import { computeFlakyScore } from "../src/reflection/flaky-score.js";
import { ConfidenceModel } from "../src/reliability/confidence-model.js";
import { DeepScanService } from "../src/reliability/deep-scan.js";
import { FailureLoopGuard } from "../src/reliability/failure-loop.js";
import { ReasoningResetController } from "../src/reliability/reasoning-reset.js";
import { AgentRuntime } from "../src/runtime.js";
import { AlwaysAllowApprovalGate, ToolRouter } from "../src/tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("reflection + reasoning reset + confidence model", () => {
  it("runs reflection jobs only when session is idle", async () => {
    vi.useFakeTimers();
    const scheduler = new IdleReflectionScheduler({
      idleAfterMs: 50,
      tickMs: 10,
      maxConcurrentJobs: 1
    });
    let runCount = 0;
    scheduler.enqueue({
      id: "job-1",
      run: async () => {
        runCount += 1;
      }
    });
    scheduler.start();
    scheduler.noteActivity(0);

    await vi.advanceTimersByTimeAsync(40);
    expect(runCount).toBe(0);

    await vi.advanceTimersByTimeAsync(30);
    expect(runCount).toBe(1);
    scheduler.stop();
  });

  it("scores flaky outcomes with transition-sensitive instability", () => {
    const stable = computeFlakyScore([true, true, true, true]);
    const flaky = computeFlakyScore([true, false, true, false]);
    expect(stable.flakyScore).toBeLessThan(flaky.flakyScore);
    expect(flaky.confidence).toBeGreaterThan(0);
  });

  it("triggers reasoning reset after configured iteration threshold", () => {
    const controller = new ReasoningResetController({
      iterationThreshold: 3
    });
    expect(controller.noteIteration("session-a").shouldReset).toBe(false);
    expect(controller.noteIteration("session-a").shouldReset).toBe(false);
    const third = controller.noteIteration("session-a");
    expect(third.shouldReset).toBe(true);
    expect(third.resetCount).toBe(1);
  });

  it("requests a human hint when runtime confidence drops below threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-confidence-gate-"));
    tempDirs.push(dir);
    let sendTurnCalled = false;
    const fakeAdapter = {
      createSession: async () => ({
        id: "session",
        model: "fallback"
      }),
      sendTurn: async function* () {
        sendTurnCalled = true;
        yield { type: "assistant_delta", data: { content: "should-not-run" } };
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
        escalationThreshold: 2
      }),
      confidenceModel: new ConfidenceModel(),
      lowConfidenceThreshold: 95,
      snapshotDir: join(dir, "snapshots")
    });

    const result = await runtime.runTurn({
      session: {
        sessionId: "s-low-confidence",
        channelId: "dm:s-low-confidence",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "try another fix" }]
    });

    expect(sendTurnCalled).toBe(false);
    expect(result.requiresHumanHint).toBe(true);
    expect(result.confidenceScore).toBeLessThan(95);
    expect(result.assistantText).toMatch(/need a human hint/i);
  });

  it("scores confidence with rationale payload", () => {
    const model = new ConfidenceModel();
    const output = model.score({
      failureCount: 2,
      hasDeepScan: true,
      pluginDiagnosticCount: 1,
      toolCallCount: 12,
      hasRecentTestsPassing: false
    });
    expect(output.score).toBeLessThan(80);
    expect(output.rationale.length).toBeGreaterThan(0);
  });

  it("keeps deep scan bounded by file count budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-deepscan-"));
    tempDirs.push(dir);
    const deepScan = new DeepScanService({
      workspaceDir: dir,
      maxFiles: 5,
      maxDurationMs: 500
    });
    const result = await deepScan.scanRecentlyTouched({
      additionalFiles: Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`)
    });
    expect(result.touchedFiles.length).toBeLessThanOrEqual(5);
  });
});
