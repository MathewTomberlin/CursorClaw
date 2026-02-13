import { join } from "node:path";

import { buildGateway } from "./gateway.js";
import { MemoryStore } from "./memory.js";
import { CursorAgentModelAdapter } from "./model-adapter.js";
import { AgentRuntime } from "./runtime.js";
import { AutonomyBudget, CronService, HeartbeatRunner, WorkflowRuntime } from "./scheduler.js";
import { AuthService, MethodRateLimiter, PolicyDecisionLogger } from "./security.js";
import { AlwaysAllowApprovalGate, ToolRouter, createExecTool, createWebFetchTool } from "./tools.js";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig(DEFAULT_CONFIG);
  const workspaceDir = process.cwd();
  const memory = new MemoryStore({ workspaceDir });
  const adapter = new CursorAgentModelAdapter({
    models: config.models,
    defaultModel: config.defaultModel
  });

  const approvalGate = new AlwaysAllowApprovalGate();
  const toolRouter = new ToolRouter({
    approvalGate,
    allowedExecBins: config.tools.exec.allowBins
  });
  toolRouter.register(createExecTool({ allowedBins: config.tools.exec.allowBins, approvalGate }));
  toolRouter.register(createWebFetchTool());

  const runtime = new AgentRuntime({
    config,
    adapter,
    toolRouter,
    memory,
    snapshotDir: join(workspaceDir, "tmp", "snapshots")
  });

  const cronService = new CronService({
    maxConcurrentRuns: 4,
    stateFile: join(workspaceDir, "tmp", "cron-state.json")
  });
  await cronService.loadState();

  const heartbeat = new HeartbeatRunner(config.heartbeat);
  const budget = new AutonomyBudget(config.autonomyBudget);
  const workflow = new WorkflowRuntime(join(workspaceDir, "tmp", "workflow-state"));
  void heartbeat;
  void budget;
  void workflow;

  const policyLogs = new PolicyDecisionLogger();
  const authOptions: {
    mode: "token" | "password" | "none";
    token?: string;
    password?: string;
    trustedProxyIps: string[];
    trustedIdentityHeader?: string;
  } = {
    mode: config.gateway.auth.mode,
    trustedProxyIps: config.gateway.trustedProxyIps
  };
  if (config.gateway.auth.token !== undefined) {
    authOptions.token = config.gateway.auth.token;
  }
  if (config.gateway.auth.password !== undefined) {
    authOptions.password = config.gateway.auth.password;
  }
  if (config.gateway.auth.trustedIdentityHeader !== undefined) {
    authOptions.trustedIdentityHeader = config.gateway.auth.trustedIdentityHeader;
  }
  const auth = new AuthService(authOptions);
  const rateLimiter = new MethodRateLimiter(60, 60_000, {
    "agent.run": 20,
    "chat.send": 40,
    "cron.add": 10
  });
  const gateway = buildGateway({
    config,
    runtime,
    cronService,
    auth,
    rateLimiter,
    policyLogs
  });

  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  await gateway.listen({
    host: config.gateway.bind === "loopback" ? "127.0.0.1" : "0.0.0.0",
    port
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
