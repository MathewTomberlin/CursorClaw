import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("autonomy orchestrator integration", () => {
  it("executes cron jobs without manual tick invocation", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-orchestrator-cron-"));
    tempDirs.push(dir);

    const cron = new CronService({
      maxConcurrentRuns: 1,
      stateFile: join(dir, "cron-state.json")
    });
    cron.addJob({
      type: "every",
      expression: "1s",
      isolated: true,
      maxRetries: 1,
      backoffMs: 100
    });

    const heartbeat = new HeartbeatRunner({
      enabled: false,
      everyMs: 100,
      minMs: 100,
      maxMs: 1000,
      visibility: "silent"
    });
    const budget = new AutonomyBudget({
      maxPerHourPerChannel: 10,
      maxPerDayPerChannel: 100
    });
    const workflow = new WorkflowRuntime(join(dir, "workflow-state"));
    const memory = new MemoryStore({ workspaceDir: dir });
    let runCount = 0;
    const orchestrator = new AutonomyOrchestrator({
      cronService: cron,
      heartbeat,
      budget,
      workflow,
      memory,
      heartbeatChannelId: "hb",
      cronTickMs: 100,
      integrityScanEveryMs: 0,
      onCronRun: async () => {
        runCount += 1;
      },
      onHeartbeatTurn: async () => "HEARTBEAT_OK"
    });

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(2_200);
    await orchestrator.stop();
    expect(runCount).toBeGreaterThanOrEqual(1);
  });

  it("runs scheduled heartbeats regardless of autonomy budget", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-orchestrator-heartbeat-"));
    tempDirs.push(dir);

    const cron = new CronService({
      maxConcurrentRuns: 1,
      stateFile: join(dir, "cron-state.json")
    });
    const heartbeat = new HeartbeatRunner({
      enabled: true,
      everyMs: 50,
      minMs: 10,
      maxMs: 100,
      visibility: "silent"
    });
    const budget = new AutonomyBudget({
      maxPerHourPerChannel: 0,
      maxPerDayPerChannel: 0
    });
    const workflow = new WorkflowRuntime(join(dir, "workflow-state"));
    const memory = new MemoryStore({ workspaceDir: dir });
    let heartbeatTurns = 0;
    const orchestrator = new AutonomyOrchestrator({
      cronService: cron,
      heartbeat,
      budget,
      workflow,
      memory,
      heartbeatChannelId: "hb-budget",
      cronTickMs: 0,
      integrityScanEveryMs: 0,
      onCronRun: async () => undefined,
      onHeartbeatTurn: async () => {
        heartbeatTurns += 1;
        return "SENT";
      }
    });

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(300);
    await orchestrator.stop();
    // Scheduled heartbeats bypass budget (bypassBudget: true) so they always run.
    expect(heartbeatTurns).toBeGreaterThanOrEqual(1);
  });

  it("exposes workflow runtime through orchestrator dispatch path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-orchestrator-workflow-"));
    tempDirs.push(dir);

    const cron = new CronService({
      maxConcurrentRuns: 1,
      stateFile: join(dir, "cron-state.json")
    });
    const heartbeat = new HeartbeatRunner({
      enabled: false,
      everyMs: 100,
      minMs: 100,
      maxMs: 1000,
      visibility: "silent"
    });
    const budget = new AutonomyBudget({
      maxPerHourPerChannel: 10,
      maxPerDayPerChannel: 100
    });
    const workflow = new WorkflowRuntime(join(dir, "workflow-state"));
    const memory = new MemoryStore({ workspaceDir: dir });

    const orchestrator = new AutonomyOrchestrator({
      cronService: cron,
      heartbeat,
      budget,
      workflow,
      memory,
      heartbeatChannelId: "hb",
      cronTickMs: 0,
      integrityScanEveryMs: 0,
      onCronRun: async () => undefined,
      onHeartbeatTurn: async () => "HEARTBEAT_OK"
    });

    let counter = 0;
    const state = await orchestrator.runWorkflow(
      {
        id: "wf-orchestrator",
        steps: [
          {
            id: "step-1",
            requiresApproval: false,
            run: async () => {
              counter += 1;
            }
          }
        ]
      },
      {
        idempotencyKey: "id-1",
        approval: async () => true
      }
    );

    expect(counter).toBe(1);
    expect(state.completedStepIds).toEqual(["step-1"]);
  });

  it("runs periodic memory integrity scans", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-orchestrator-integrity-"));
    tempDirs.push(dir);

    const cron = new CronService({
      maxConcurrentRuns: 1,
      stateFile: join(dir, "cron-state.json")
    });
    const heartbeat = new HeartbeatRunner({
      enabled: false,
      everyMs: 100,
      minMs: 100,
      maxMs: 1000,
      visibility: "silent"
    });
    const budget = new AutonomyBudget({
      maxPerHourPerChannel: 10,
      maxPerDayPerChannel: 100
    });
    const workflow = new WorkflowRuntime(join(dir, "workflow-state"));
    const memory = new MemoryStore({ workspaceDir: dir });
    await memory.append({
      sessionId: "s1",
      category: "profile",
      text: "fact-one",
      provenance: {
        sourceChannel: "dm:s1",
        confidence: 1,
        timestamp: new Date().toISOString(),
        sensitivity: "public"
      }
    });
    await memory.append({
      sessionId: "s1",
      category: "profile",
      text: "fact-two",
      provenance: {
        sourceChannel: "dm:s1",
        confidence: 1,
        timestamp: new Date().toISOString(),
        sensitivity: "public"
      }
    });

    vi.useFakeTimers();
    let scanCount = 0;
    const orchestrator = new AutonomyOrchestrator({
      cronService: cron,
      heartbeat,
      budget,
      workflow,
      memory,
      heartbeatChannelId: "hb",
      cronTickMs: 0,
      integrityScanEveryMs: 25,
      onCronRun: async () => undefined,
      onHeartbeatTurn: async () => "HEARTBEAT_OK",
      onIntegrityScan: () => {
        scanCount += 1;
      }
    });

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(250);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 80));
    vi.useFakeTimers();
    await orchestrator.stop();
    expect(scanCount).toBeGreaterThanOrEqual(1);
    expect(orchestrator.getState().latestIntegrityFindings.length).toBeGreaterThanOrEqual(1);
  });

  it("integrityScan returns expected shape (contradiction and staleness)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-integrity-shape-"));
    tempDirs.push(dir);
    const memory = new MemoryStore({ workspaceDir: dir });
    await memory.append({
      sessionId: "s1",
      category: "cat",
      text: "first",
      provenance: {
        sourceChannel: "ch",
        confidence: 1,
        timestamp: new Date().toISOString(),
        sensitivity: "public"
      }
    });
    await memory.append({
      sessionId: "s1",
      category: "cat",
      text: "second",
      provenance: {
        sourceChannel: "ch",
        confidence: 1,
        timestamp: new Date().toISOString(),
        sensitivity: "public"
      }
    });
    const findings = await memory.integrityScan();
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    for (const f of findings) {
      expect(f).toHaveProperty("recordId");
      expect(f).toHaveProperty("severity");
      expect(f).toHaveProperty("issue");
      expect(["warning", "error"]).toContain(f.severity);
    }
  });
});
