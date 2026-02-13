import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildGateway } from "../src/gateway.js";
import { MemoryStore } from "../src/memory.js";
import { CursorAgentModelAdapter } from "../src/model-adapter.js";
import { AgentRuntime } from "../src/runtime.js";
import { CronService } from "../src/scheduler.js";
import { AuthService, MethodRateLimiter, PolicyDecisionLogger } from "../src/security.js";
import { AlwaysAllowApprovalGate, ToolRouter, createExecTool } from "../src/tools.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

async function createGateway() {
  const dir = await mkdtemp(join(tmpdir(), "cursorclaw-gw-"));
  cleanupPaths.push(dir);
  const config = loadConfig({
    gateway: {
      auth: { mode: "token", token: "test-token" },
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
    maxConcurrentRuns: 2,
    stateFile: join(dir, "cron-state.json")
  });
  const auth = new AuthService({
    mode: "token",
    token: "test-token",
    trustedProxyIps: []
  });
  const rateLimiter = new MethodRateLimiter(10, 60_000, {
    "agent.run": 5,
    "chat.send": 5,
    "cron.add": 2
  });
  const policyLogs = new PolicyDecisionLogger();
  const app = buildGateway({
    config,
    runtime,
    cronService,
    auth,
    rateLimiter,
    policyLogs
  });
  return app;
}

describe("gateway integration", () => {
  it("rejects unsupported protocol versions", async () => {
    const app = await createGateway();
    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      payload: {
        version: "1.0",
        method: "chat.send",
        params: { channelId: "c1", text: "hello" }
      },
      headers: {
        authorization: "Bearer test-token"
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("PROTO_VERSION_UNSUPPORTED");
    await app.close();
  });

  it("requires auth for RPC calls", async () => {
    const app = await createGateway();
    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      payload: {
        version: "2.0",
        method: "chat.send",
        params: { channelId: "c1", text: "hello" }
      }
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("supports async agent.run + agent.wait flow", async () => {
    const app = await createGateway();
    const runRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "agent.run",
        params: {
          session: {
            sessionId: "s1",
            channelId: "dm:s1",
            channelKind: "dm"
          },
          messages: [{ role: "user", content: "hi there" }]
        }
      }
    });
    expect(runRes.statusCode).toBe(200);
    const runId = runRes.json().result.runId as string;
    expect(runId).toBeTruthy();

    const waitRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "agent.wait",
        params: { runId }
      }
    });
    expect(waitRes.statusCode).toBe(200);
    const events: Array<{ type: string }> = waitRes.json().result.events;
    expect(events.some((event) => event.type === "completed")).toBe(true);

    const secondWaitRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "agent.wait",
        params: { runId }
      }
    });
    expect(secondWaitRes.statusCode).toBe(500);
    expect(secondWaitRes.json().error.message).toContain(`runId not found: ${runId}`);
    await app.close();
  });

  it("enforces role scope on cron.add for remote role", async () => {
    const app = await createGateway();
    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      remoteAddress: "8.8.8.8",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "cron.add",
        params: {
          type: "every",
          expression: "5m",
          isolated: true
        }
      }
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
