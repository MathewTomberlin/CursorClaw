import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildGateway } from "../src/gateway.js";
import type { ChannelHub } from "../src/channels.js";
import { MemoryStore } from "../src/memory.js";
import { CursorAgentModelAdapter } from "../src/model-adapter.js";
import { RunStore } from "../src/run-store.js";
import { AgentRuntime } from "../src/runtime.js";
import { CronService } from "../src/scheduler.js";
import { ApprovalWorkflow } from "../src/security/approval-workflow.js";
import { CapabilityStore } from "../src/security/capabilities.js";
import { AuthService, IncidentCommander, MethodRateLimiter, PolicyDecisionLogger } from "../src/security.js";
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

async function createGateway(options: {
  channelHub?: ChannelHub;
  approvalWorkflow?: ApprovalWorkflow;
  capabilityStore?: CapabilityStore;
  onFileChangeSuggestions?: (args: {
    channelId: string;
    files: string[];
    enqueue: boolean;
  }) => Promise<{ suggestions: string[]; queued: number }>;
  onWorkspaceStatus?: () => Promise<unknown>;
  onWorkspaceSemanticSearch?: (args: {
    query: string;
    topK: number;
    workspace?: string;
    repo?: string;
  }) => Promise<unknown>;
  onTraceIngest?: (args: {
    sessionId?: string;
    method: string;
    url: string;
    status: number;
    latencyMs: number;
    requestBody?: unknown;
    responseBody?: unknown;
    headers?: Record<string, string>;
  }) => Promise<unknown>;
  onExplainFunction?: (args: { modulePath: string; symbol: string }) => Promise<unknown>;
  onActivity?: () => void;
} = {}) {
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
  const incidentCommander = new IncidentCommander();
  const auth = new AuthService({
    mode: "token",
    token: "test-token",
    trustedProxyIps: [],
    isTokenRevoked: (token: string) => incidentCommander.isTokenRevoked(token)
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
    ...(options.channelHub ? { channelHub: options.channelHub } : {}),
    ...(options.approvalWorkflow ? { approvalWorkflow: options.approvalWorkflow } : {}),
    ...(options.capabilityStore ? { capabilityStore: options.capabilityStore } : {}),
    ...(options.onFileChangeSuggestions ? { onFileChangeSuggestions: options.onFileChangeSuggestions } : {}),
    ...(options.onWorkspaceStatus ? { onWorkspaceStatus: options.onWorkspaceStatus } : {}),
    ...(options.onWorkspaceSemanticSearch ? { onWorkspaceSemanticSearch: options.onWorkspaceSemanticSearch } : {}),
    ...(options.onTraceIngest ? { onTraceIngest: options.onTraceIngest } : {}),
    ...(options.onExplainFunction ? { onExplainFunction: options.onExplainFunction } : {}),
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    auth,
    rateLimiter,
    policyLogs,
    incidentCommander
  });
  return app;
}

describe("gateway integration", () => {
  it("exposes runtime metrics and incident flags on status endpoint", async () => {
    const app = await createGateway();
    const status = await app.inject({
      method: "GET",
      url: "/status"
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().runtimeMetrics).toBeDefined();
    expect(status.json().incident).toMatchObject({
      proactiveSendsDisabled: false,
      toolIsolationEnabled: false
    });
    await app.close();
  });

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

  it("dispatches chat.send through channel hub when configured", async () => {
    const sentPayloads: unknown[] = [];
    const channelHub = {
      async send(message: unknown) {
        sentPayloads.push(message);
        return {
          delivered: true,
          channelId: "c1",
          provider: "mock-channel",
          messageId: "msg-1",
          text: "delivered via adapter"
        };
      },
      register() {
        return undefined;
      },
      listAdapters() {
        return ["mock-channel"];
      }
    } as unknown as ChannelHub;
    const app = await createGateway({ channelHub });
    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "chat.send",
        params: {
          channelId: "c1",
          text: "hello adapter"
        }
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.provider).toBe("mock-channel");
    expect(sentPayloads.length).toBe(1);
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
    expect(secondWaitRes.statusCode).toBe(404);
    expect(secondWaitRes.json().error.message).toContain(`runId not found: ${runId}`);
    await app.close();
  });

  it("recovers completed run results across gateway restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-gw-runstore-"));
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
    const build = async () => {
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
      const runStore = new RunStore({
        stateFile: join(dir, "run-store.json")
      });
      await runStore.load();
      await runStore.markInFlightInterrupted();
      return buildGateway({
        config,
        runtime,
        cronService,
        runStore,
        auth: new AuthService({
          mode: "token",
          token: "test-token",
          trustedProxyIps: []
        }),
        rateLimiter: new MethodRateLimiter(10, 60_000),
        policyLogs: new PolicyDecisionLogger(),
        incidentCommander: new IncidentCommander()
      });
    };

    const app1 = await build();
    const runRes = await app1.inject({
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
            sessionId: "s-restart",
            channelId: "dm:s-restart",
            channelKind: "dm"
          },
          messages: [{ role: "user", content: "persist my run" }]
        }
      }
    });
    expect(runRes.statusCode).toBe(200);
    const runId = runRes.json().result.runId as string;

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    await app1.close();

    const app2 = await build();
    const waitRes = await app2.inject({
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

    const secondWaitRes = await app2.inject({
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
    expect(secondWaitRes.statusCode).toBe(404);
    await app2.close();
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

  it("executes incident.bundle for admin role", async () => {
    const app = await createGateway();
    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "incident.bundle",
        params: {
          tokens: ["token-a", "token-b"]
        }
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().result.proactiveDisabled).toBe(true);
    expect(res.json().result.isolatedTools).toBe(true);
    expect(res.json().result.revokedTokenHashes).toHaveLength(2);
    await app.close();
  });

  it("revokes tokens from incident bundle and blocks subsequent RPC auth", async () => {
    const app = await createGateway();
    const incident = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "incident.bundle",
        params: {
          tokens: ["test-token"]
        }
      }
    });
    expect(incident.statusCode).toBe(200);

    const blocked = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "chat.send",
        params: {
          channelId: "c1",
          text: "am I blocked?"
        }
      }
    });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error.code).toBe("AUTH_INVALID");
    await app.close();
  });

  it("enforces incident mode by blocking proactive chat sends", async () => {
    const app = await createGateway();
    const incident = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "incident.bundle",
        params: {
          tokens: []
        }
      }
    });
    expect(incident.statusCode).toBe(200);

    const sendRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "chat.send",
        params: {
          channelId: "c1",
          text: "hello proactive",
          proactive: true
        }
      }
    });
    expect(sendRes.statusCode).toBe(403);
    expect(sendRes.json().error.code).toBe("FORBIDDEN");
    await app.close();
  });

  it("sanitizes internal errors on server faults", async () => {
    const app = await createGateway();
    const res = await app.inject({
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
          expression: "not-a-duration",
          isolated: true
        }
      }
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL");
    expect(res.json().error.message).toBe("Internal server error");
    expect(res.json().error.message).not.toContain("invalid duration");
    await app.close();
  });

  it("rejects oversized RPC payloads", async () => {
    const app = await createGateway();
    const oversized = "x".repeat(80_000);
    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "chat.send",
        params: {
          channelId: "c1",
          text: oversized
        }
      }
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it("rejects too-long per-message content in agent turns", async () => {
    const app = await createGateway();
    const res = await app.inject({
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
            sessionId: "s-big",
            channelId: "dm:s-big",
            channelKind: "dm"
          },
          messages: [{ role: "user", content: "y".repeat(20_000) }]
        }
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
    expect(String(res.json().error.message)).toContain("message too long");
    await app.close();
  });

  it("blocks high-risk tool execution after incident.bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-gw-incident-tool-"));
    cleanupPaths.push(dir);
    const script = [
      "process.stdout.write(JSON.stringify({type:'tool_call',data:{name:'exec',args:{command:'echo hello'}}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'done',data:{}})+'\\n');"
    ].join("");
    const config = loadConfig({
      gateway: {
        auth: { mode: "token", token: "test-token" },
        protocolVersion: "2.0",
        bind: "loopback",
        trustedProxyIps: []
      },
      defaultModel: "cursor-auto",
      models: {
        "cursor-auto": {
          provider: "cursor-agent-cli",
          command: process.execPath,
          args: ["-e", script],
          timeoutMs: 10_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      }
    });
    const memory = new MemoryStore({ workspaceDir: dir });
    const adapter = new CursorAgentModelAdapter({
      defaultModel: "cursor-auto",
      models: config.models
    });
    const incidentCommander = new IncidentCommander();
    const gate = new AlwaysAllowApprovalGate();
    const toolRouter = new ToolRouter({
      approvalGate: gate,
      allowedExecBins: ["echo"],
      isToolIsolationEnabled: () => incidentCommander.isToolIsolationEnabled()
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
    const app = buildGateway({
      config,
      runtime,
      cronService,
      auth: new AuthService({
        mode: "token",
        token: "test-token",
        trustedProxyIps: []
      }),
      rateLimiter: new MethodRateLimiter(10, 60_000),
      policyLogs: new PolicyDecisionLogger(),
      incidentCommander
    });

    const incident = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "incident.bundle",
        params: {}
      }
    });
    expect(incident.statusCode).toBe(200);

    const run = await app.inject({
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
            sessionId: "s-incident",
            channelId: "dm:s-incident",
            channelKind: "dm"
          },
          messages: [{ role: "user", content: "trigger tool" }]
        }
      }
    });
    expect(run.statusCode).toBe(200);
    const runId = run.json().result.runId as string;

    const wait = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "agent.wait",
        params: {
          runId
        }
      }
    });
    expect(wait.statusCode).toBe(500);
    expect(wait.json().error.code).toBe("INTERNAL");
    expect(runtime.getDecisionLogs().some((entry) => entry.reasonCode === "TOOL_POLICY_BLOCKED")).toBe(true);
    await app.close();
  });

  it("lists and resolves approval requests through RPC endpoints", async () => {
    const capabilityStore = new CapabilityStore();
    const approvalWorkflow = new ApprovalWorkflow({
      capabilityStore,
      defaultGrantTtlMs: 60_000,
      defaultGrantUses: 1
    });
    const request = approvalWorkflow.request({
      tool: "web_fetch",
      intent: "network-impacting",
      plan: "network fetch",
      args: { url: "https://example.com" }
    });
    const app = await createGateway({
      approvalWorkflow,
      capabilityStore
    });

    const listRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "approval.list",
        params: {
          status: "pending"
        }
      }
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().result.requests[0].id).toBe(request.id);

    const resolveRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "approval.resolve",
        params: {
          requestId: request.id,
          decision: "approve",
          grantUses: 1
        }
      }
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().result.request.status).toBe("approved");

    const grantsRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "approval.capabilities",
        params: {}
      }
    });
    expect(grantsRes.statusCode).toBe(200);
    expect(grantsRes.json().result.grants.length).toBeGreaterThan(0);
    await app.close();
  });

  it("returns proactive suggestions for file change RPC", async () => {
    const app = await createGateway({
      onFileChangeSuggestions: async ({ channelId, files, enqueue }) => ({
        suggestions: [`suggestion for ${channelId}`, ...files.map((file) => `check ${file}`)],
        queued: enqueue ? files.length : 0
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "advisor.file_change",
        params: {
          channelId: "dm:u1",
          files: ["src/auth.ts", "docs/api.md"],
          enqueue: true
        }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(response.json().result.queued).toBe(2);
    await app.close();
  });

  it("supports workspace, trace, and function-explainer RPC methods", async () => {
    let activitySignals = 0;
    const app = await createGateway({
      onActivity: () => {
        activitySignals += 1;
      },
      onWorkspaceStatus: async () => ({
        roots: [{ id: "primary", healthy: true }],
        indexedFiles: 12
      }),
      onWorkspaceSemanticSearch: async ({ query, topK }) => ({
        query,
        topK,
        results: [{ modulePath: "src/app.ts", maxScore: 0.9 }]
      }),
      onTraceIngest: async ({ url }) => ({
        accepted: true,
        url
      }),
      onExplainFunction: async ({ modulePath, symbol }) => ({
        modulePath,
        symbol,
        confidence: 80
      })
    });

    const statusRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "workspace.status",
        params: {}
      }
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().result.indexedFiles).toBe(12);

    const searchRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "workspace.semantic_search",
        params: {
          query: "auth flow",
          topK: 3
        }
      }
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().result.results[0].modulePath).toBe("src/app.ts");

    const traceRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "trace.ingest",
        params: {
          method: "GET",
          url: "http://localhost:3000/health",
          status: 200,
          latencyMs: 10
        }
      }
    });
    expect(traceRes.statusCode).toBe(200);
    expect(traceRes.json().result.accepted).toBe(true);

    const explainRes = await app.inject({
      method: "POST",
      url: "/rpc",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        version: "2.0",
        method: "advisor.explain_function",
        params: {
          modulePath: "src/app.ts",
          symbol: "runApp"
        }
      }
    });
    expect(explainRes.statusCode).toBe(200);
    expect(explainRes.json().result.symbol).toBe("runApp");
    expect(activitySignals).toBeGreaterThanOrEqual(4);
    await app.close();
  });
});
