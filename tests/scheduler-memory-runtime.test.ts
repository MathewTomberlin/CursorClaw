import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { InMemoryLifecycleStream } from "../src/lifecycle-stream/in-memory-stream.js";
import { MemoryStore } from "../src/memory.js";
import { CursorAgentModelAdapter } from "../src/model-adapter.js";
import { AgentRuntime } from "../src/runtime.js";
import {
  AutonomyBudget,
  CronService,
  HeartbeatRunner,
  WorkflowRuntime
} from "../src/scheduler.js";
import { AlwaysAllowApprovalGate, ToolRouter, createExecTool } from "../src/tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("scheduler, memory, and runtime", () => {
  it("adapts heartbeat interval and enforces autonomy budget", async () => {
    const heartbeat = new HeartbeatRunner({
      enabled: true,
      everyMs: 30_000,
      minMs: 5_000,
      maxMs: 120_000,
      visibility: "silent"
    });
    const intervalFast = heartbeat.nextInterval({ unreadEvents: 30 });
    expect(intervalFast).toBeLessThanOrEqual(30_000);
    const intervalSlow = heartbeat.nextInterval({ unreadEvents: 0 });
    expect(intervalSlow).toBeGreaterThanOrEqual(intervalFast);

    const budget = new AutonomyBudget({
      maxPerHourPerChannel: 1,
      maxPerDayPerChannel: 2
    });
    expect(budget.allow("chan-a", new Date("2026-02-13T10:00:00Z"))).toBe(true);
    expect(budget.allow("chan-a", new Date("2026-02-13T10:10:00Z"))).toBe(false);

    const result = await heartbeat.runOnce({
      channelId: "chan-a",
      budget: new AutonomyBudget({
        maxPerHourPerChannel: 5,
        maxPerDayPerChannel: 10
      }),
      turn: async () => "HEARTBEAT_OK"
    });
    expect(result).toBe("HEARTBEAT_OK");

    const quietBudget = new AutonomyBudget({
      maxPerHourPerChannel: 5,
      maxPerDayPerChannel: 10,
      quietHours: {
        startHour: 22,
        endHour: 6
      }
    });
    expect(quietBudget.allow("chan-a", new Date("2026-02-13T23:00:00Z"))).toBe(false);
  });

  it("runs cron jobs with retry backoff and max concurrency", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-cron-"));
    tempDirs.push(dir);
    const cron = new CronService({
      maxConcurrentRuns: 1,
      stateFile: join(dir, "cron-state.json")
    });
    const job = cron.addJob({
      type: "every",
      expression: "1s",
      isolated: true,
      maxRetries: 2,
      backoffMs: 100
    });
    let attempts = 0;
    await cron.tick(async (run) => {
      expect(run.id).toBe(job.id);
      attempts += 1;
      throw new Error("simulated transient failure");
    }, Date.now() + 2_000);
    expect(attempts).toBe(1);
    const jobs = cron.listJobs();
    expect(jobs[0]).toBeDefined();
    expect(jobs[0]?.nextRunAt).toBeDefined();
  });

  it("runs at jobs only once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-at-"));
    tempDirs.push(dir);
    const cron = new CronService({
      maxConcurrentRuns: 1,
      stateFile: join(dir, "cron-state.json")
    });

    const start = Date.now();
    const runAt = start + 10_000;
    cron.addJob({
      type: "at",
      expression: String(runAt),
      isolated: true,
      maxRetries: 2,
      backoffMs: 100
    });

    let runs = 0;
    await cron.tick(async () => {
      runs += 1;
    }, start + 1_000);
    expect(runs).toBe(0);

    await cron.tick(async () => {
      runs += 1;
    }, runAt);
    expect(runs).toBe(1);

    await cron.tick(async () => {
      runs += 1;
    }, runAt + 60_000);
    expect(runs).toBe(1);

    const jobs = cron.listJobs();
    expect(jobs[0]?.nextRunAt).toBeUndefined();
  });

  it("stores classified memory with provenance and session isolation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-memory-"));
    tempDirs.push(dir);
    const memory = new MemoryStore({ workspaceDir: dir });
    await memory.append({
      sessionId: "s1",
      category: "profile",
      text: "user likes tea",
      provenance: {
        sourceChannel: "dm:u1",
        confidence: 0.9,
        timestamp: new Date().toISOString(),
        sensitivity: "private-user"
      }
    });
    await memory.append({
      sessionId: "s1",
      category: "secret",
      text: "api key is ABC",
      provenance: {
        sourceChannel: "dm:u1",
        confidence: 0.5,
        timestamp: new Date().toISOString(),
        sensitivity: "secret"
      }
    });
    await memory.append({
      sessionId: "s2",
      category: "profile",
      text: "other session fact",
      provenance: {
        sourceChannel: "dm:u2",
        confidence: 0.9,
        timestamp: new Date().toISOString(),
        sensitivity: "public"
      }
    });

    const sessionVisible = await memory.retrieveForSession({ sessionId: "s1" });
    expect(sessionVisible.some((record) => record.text.includes("api key"))).toBe(false);
    expect(sessionVisible.every((record) => record.sessionId === "s1")).toBe(true);
  });

  it("runs deterministic workflow with idempotency and approvals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-workflow-"));
    tempDirs.push(dir);
    const workflow = new WorkflowRuntime(join(dir, "state"));
    let counter = 0;
    const def = {
      id: "wf-1",
      steps: [
        { id: "s1", requiresApproval: false, run: async () => void (counter += 1) },
        { id: "s2", requiresApproval: true, run: async () => void (counter += 1) }
      ]
    };
    const first = await workflow.run(def, {
      idempotencyKey: "id-1",
      approval: async () => true
    });
    expect(first.completedStepIds).toEqual(["s1", "s2"]);

    const second = await workflow.run(def, {
      idempotencyKey: "id-1",
      approval: async () => true
    });
    expect(second.completedStepIds).toEqual(["s1", "s2"]);
    expect(counter).toBe(2);
  });

  it("resumes persisted workflow state across runtime restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-workflow-restart-"));
    tempDirs.push(dir);

    const stepRuns: string[] = [];
    const def = {
      id: "wf-restart",
      steps: [
        {
          id: "s1",
          requiresApproval: false,
          run: async () => {
            stepRuns.push("s1");
          }
        },
        {
          id: "s2",
          requiresApproval: true,
          run: async () => {
            stepRuns.push("s2");
          }
        }
      ]
    };

    const firstRuntime = new WorkflowRuntime(join(dir, "state"));
    await expect(
      firstRuntime.run(def, {
        idempotencyKey: "id-restart",
        approval: async (stepId) => stepId !== "s2"
      })
    ).rejects.toThrow("workflow step denied: s2");
    expect(stepRuns).toEqual(["s1"]);

    const secondRuntime = new WorkflowRuntime(join(dir, "state"));
    const resumed = await secondRuntime.run(def, {
      idempotencyKey: "id-restart",
      approval: async () => true
    });

    expect(resumed.completedStepIds).toEqual(["s1", "s2"]);
    expect(stepRuns).toEqual(["s1", "s2"]);
  });

  it("executes runtime lifecycle and snapshots events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-runtime-"));
    tempDirs.push(dir);
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
    const adapter = new CursorAgentModelAdapter({
      defaultModel: "fallback",
      models: config.models
    });
    const gate = new AlwaysAllowApprovalGate();
    const tools = new ToolRouter({
      approvalGate: gate,
      allowedExecBins: ["echo"]
    });
    tools.register(createExecTool({ allowedBins: ["echo"], approvalGate: gate }));

    const runtime = new AgentRuntime({
      config,
      adapter,
      toolRouter: tools,
      memory,
      snapshotDir: join(dir, "snapshots")
    });
    const result = await runtime.runTurn({
      session: {
        sessionId: "session-main",
        channelId: "chan-main",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "hello runtime" }]
    });
    expect(result.events.map((entry) => entry.type)).toContain("queued");
    expect(result.events.map((entry) => entry.type)).toContain("started");
    expect(result.events.map((entry) => entry.type)).toContain("assistant");
    expect(result.events.map((entry) => entry.type)).toContain("completed");

    const snapshots = await readFile(join(dir, "snapshots", `session-main-${result.runId}.json`), "utf8");
    expect(snapshots).toContain(result.runId);
  });

  it("lifecycle stream subscriber receives events for a run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-lifecycle-"));
    tempDirs.push(dir);
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
    const adapter = new CursorAgentModelAdapter({
      defaultModel: "fallback",
      models: config.models
    });
    const gate = new AlwaysAllowApprovalGate();
    const tools = new ToolRouter({
      approvalGate: gate,
      allowedExecBins: ["echo"]
    });
    tools.register(createExecTool({ allowedBins: ["echo"], approvalGate: gate }));

    const lifecycleStream = new InMemoryLifecycleStream();
    const runtime = new AgentRuntime({
      config,
      adapter,
      toolRouter: tools,
      memory,
      lifecycleStream,
      snapshotDir: join(dir, "snapshots")
    });

    const collected: string[] = [];
    const subPromise = (async () => {
      for await (const event of lifecycleStream.subscribe("session-lc")) {
        collected.push(event.type);
        if (event.type === "completed" || event.type === "failed") break;
      }
    })();

    await runtime.runTurn({
      session: {
        sessionId: "session-lc",
        channelId: "chan-lc",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "hi" }]
    });

    await subPromise;
    expect(collected).toContain("queued");
    expect(collected).toContain("started");
    expect(collected).toContain("completed");
  });

  it("excludes secret memory from prompt assembly by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-runtime-memory-filter-"));
    tempDirs.push(dir);
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
      memory: {
        includeSecretsInPrompt: false
      }
    });
    const memory = new MemoryStore({ workspaceDir: dir });
    await memory.append({
      sessionId: "s-memory",
      category: "profile",
      text: "public preference tea",
      provenance: {
        sourceChannel: "dm:s-memory",
        confidence: 0.9,
        timestamp: new Date().toISOString(),
        sensitivity: "public"
      }
    });
    await memory.append({
      sessionId: "s-memory",
      category: "secret",
      text: "secret-api-key-value",
      provenance: {
        sourceChannel: "dm:s-memory",
        confidence: 0.9,
        timestamp: new Date().toISOString(),
        sensitivity: "secret"
      }
    });

    const observedMessages: Array<Array<{ role: string; content: string }>> = [];
    const fakeAdapter = {
      createSession: async () => ({ id: "fake-session", model: "fallback" }),
      sendTurn: async function* (
        _session: { id: string; model: string },
        messages: Array<{ role: string; content: string }>
      ) {
        observedMessages.push(messages);
        yield { type: "assistant_delta", data: { content: "ok" } };
        yield { type: "done", data: {} };
      },
      cancel: async () => undefined,
      close: async () => undefined
    } as unknown as CursorAgentModelAdapter;

    const gate = new AlwaysAllowApprovalGate();
    const tools = new ToolRouter({
      approvalGate: gate,
      allowedExecBins: ["echo"]
    });
    tools.register(createExecTool({ allowedBins: ["echo"], approvalGate: gate }));

    const runtime = new AgentRuntime({
      config,
      adapter: fakeAdapter,
      toolRouter: tools,
      memory,
      snapshotDir: join(dir, "snapshots")
    });

    await runtime.runTurn({
      session: {
        sessionId: "s-memory",
        channelId: "dm:s-memory",
        channelKind: "dm"
      },
      messages: [{ role: "user", content: "summarize memory context" }]
    });

    expect(observedMessages.length).toBeGreaterThanOrEqual(1);
    const systemMessages = observedMessages[0]?.filter((m) => m.role === "system") ?? [];
    const combinedSystem = systemMessages.map((m) => m.content).join("\n");
    expect(combinedSystem).toContain("public preference tea");
    expect(combinedSystem).not.toContain("secret-api-key-value");
  });
});
