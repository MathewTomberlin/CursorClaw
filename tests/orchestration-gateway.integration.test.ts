import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildGateway } from "../src/gateway.js";
import { MemoryStore } from "../src/memory.js";
import { CursorAgentModelAdapter } from "../src/model-adapter.js";
import { AutonomyOrchestrator } from "../src/orchestrator.js";
import { AgentRuntime } from "../src/runtime.js";
import { AutonomyBudget, CronService, HeartbeatRunner, WorkflowRuntime } from "../src/scheduler.js";
import { AuthService, IncidentCommander, MethodRateLimiter, PolicyDecisionLogger } from "../src/security.js";
import { AlwaysAllowApprovalGate, ToolRouter, createExecTool } from "../src/tools.js";

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

describe("gateway + orchestrator integration", () => {
  it("executes cron jobs added via RPC without manual ticking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-gw-orchestrator-"));
    tempDirs.push(dir);

    const config = loadConfig({
      gateway: {
        auth: {
          mode: "token",
          token: "test-token"
        },
        protocolVersion: "2.0",
        bind: "loopback",
        trustedProxyIps: []
      },
      defaultModel: "fallback",
      models: {
        fallback: {
          provider: "fallback-model",
          timeoutMs: 10_000,
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
    const toolRouter = new ToolRouter({
      approvalGate: gate,
      allowedExecBins: ["echo"]
    });
    toolRouter.register(createExecTool({ allowedBins: ["echo"], approvalGate: gate }));
    const runtime = new AgentRuntime({
      config,
      adapter,
      toolRouter,
      memory,
      snapshotDir: join(dir, "snapshots")
    });

    const cronService = new CronService({
      maxConcurrentRuns: 1,
      stateFile: join(dir, "cron-state.json")
    });
    const incidentCommander = new IncidentCommander();
    const app = buildGateway({
      getConfig: () => config,
      runtime,
      cronService,
      auth: new AuthService({
        mode: "token",
        token: "test-token",
        trustedProxyIps: []
      }),
      rateLimiter: new MethodRateLimiter(20, 60_000),
      policyLogs: new PolicyDecisionLogger(),
      incidentCommander
    });
    const heartbeat = new HeartbeatRunner({
      enabled: false,
      everyMs: 100,
      minMs: 100,
      maxMs: 1000,
      visibility: "silent"
    });
    const budget = new AutonomyBudget({
      maxPerHourPerChannel: 5,
      maxPerDayPerChannel: 20
    });
    const workflow = new WorkflowRuntime(join(dir, "workflow-state"));
    let runCount = 0;
    const orchestrator = new AutonomyOrchestrator({
      cronService,
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

    const addRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "cron.add",
        params: {
          type: "every",
          expression: "1s",
          isolated: true
        }
      }
    });
    expect(addRes.statusCode).toBe(200);

    await new Promise((resolve) => {
      setTimeout(resolve, 2_500);
    });
    expect(runCount).toBeGreaterThanOrEqual(1);

    await orchestrator.stop();
    const persistedState = await readFile(join(dir, "cron-state.json"), "utf8");
    expect(persistedState).toContain("\"expression\": \"1s\"");
    await app.close();
  }, 15_000);
});
