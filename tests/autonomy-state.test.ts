import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AutonomyStateStore } from "../src/autonomy-state.js";
import { MemoryStore } from "../src/memory.js";
import { AutonomyOrchestrator } from "../src/orchestrator.js";
import { AutonomyBudget, CronService, HeartbeatRunner, WorkflowRuntime } from "../src/scheduler.js";

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

describe("autonomy state persistence", () => {
  it(
    "persists proactive intents and budget usage to disk",
    async () => {
      vi.useFakeTimers();
      const dir = await mkdtemp(join(tmpdir(), "cursorclaw-autonomy-state-"));
      tempDirs.push(dir);
      const stateFile = join(dir, "autonomy-state.json");

      const store = new AutonomyStateStore({ stateFile });
      const cron = new CronService({
        maxConcurrentRuns: 1,
        stateFile: join(dir, "cron-state.json")
      });
      const heartbeat = new HeartbeatRunner({
        enabled: false,
        everyMs: 100,
        minMs: 50,
        maxMs: 200,
        visibility: "silent"
      });
      const budget = new AutonomyBudget({
        maxPerHourPerChannel: 5,
        maxPerDayPerChannel: 10
      });
      const workflow = new WorkflowRuntime(join(dir, "workflow-state"));
      const memory = new MemoryStore({ workspaceDir: dir });

      let deliveredCount = 0;
      let resolveDelivery: () => void;
      const deliveryPromise = new Promise<void>((resolve) => {
        resolveDelivery = resolve;
      });
      const orchestrator = new AutonomyOrchestrator({
        cronService: cron,
        heartbeat,
        budget,
        workflow,
        memory,
        autonomyStateStore: store,
        heartbeatChannelId: "hb",
        cronTickMs: 0,
        integrityScanEveryMs: 0,
        intentTickMs: 25,
        onCronRun: async () => undefined,
        onHeartbeatTurn: async () => "HEARTBEAT_OK",
        onProactiveIntent: async () => {
          deliveredCount += 1;
          resolveDelivery();
          return true;
        }
      });

      orchestrator.start();
      await orchestrator.queueProactiveIntent({
        channelId: "dm:user-1",
        text: "scheduled follow-up",
        notBeforeMs: Date.now()
      });
      // Advance timers in steps so intent-tick interval and async dispatch can run
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(25);
        await Promise.resolve();
        if (deliveredCount >= 1) break;
      }
      await deliveryPromise;
      await orchestrator.stop();

    expect(deliveredCount).toBe(1);

    const reloaded = new AutonomyStateStore({ stateFile });
    const snapshot = await reloaded.load();
    expect(snapshot.intents.length).toBe(1);
    expect(snapshot.intents[0]?.status).toBe("sent");
    expect(snapshot.budget.hourly["dm:user-1"]?.length ?? 0).toBeGreaterThanOrEqual(1);
    },
    10_000
  );
});
