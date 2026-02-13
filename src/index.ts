import { join } from "node:path";

import { buildGateway } from "./gateway.js";
import { MemoryStore } from "./memory.js";
import { CursorAgentModelAdapter } from "./model-adapter.js";
import { AgentRuntime } from "./runtime.js";
import { AutonomyBudget, CronService, HeartbeatRunner, WorkflowRuntime } from "./scheduler.js";
import {
  BehaviorPolicyEngine,
  DeliveryPacer,
  GreetingPolicy,
  PresenceManager,
  TypingPolicy
} from "./responsiveness.js";
import { AuthService, IncidentCommander, MethodRateLimiter, PolicyDecisionLogger } from "./security.js";
import { PolicyApprovalGate, ToolRouter, createExecTool, createWebFetchTool } from "./tools.js";
import { isDevMode, loadConfigFromDisk, validateStartupConfig } from "./config.js";
import { AutonomyOrchestrator } from "./orchestrator.js";

const STRICT_EXEC_BINS = new Set(["echo", "pwd", "ls", "cat", "node"]);

function resolveAllowedExecBins(args: {
  bins: string[];
  profile: "strict" | "developer";
  devMode: boolean;
}): string[] {
  if (args.devMode || args.profile === "developer") {
    return [...new Set(args.bins)];
  }
  const strictBins = args.bins.filter((bin) => STRICT_EXEC_BINS.has(bin));
  if (strictBins.length === 0) {
    return ["echo"];
  }
  return strictBins;
}

async function main(): Promise<void> {
  const workspaceDir = process.cwd();
  const config = loadConfigFromDisk({ cwd: workspaceDir });
  const devMode = isDevMode();
  validateStartupConfig(config, {
    allowInsecureDefaults: devMode
  });
  const incidentCommander = new IncidentCommander();

  const memory = new MemoryStore({ workspaceDir });
  const adapter = new CursorAgentModelAdapter({
    models: config.models,
    defaultModel: config.defaultModel
  });

  const allowExecIntents =
    config.tools.exec.ask === "always" ? [] : (["read-only"] as const);
  const approvalGate = new PolicyApprovalGate({
    devMode,
    allowHighRiskTools: false,
    allowExecIntents: [...allowExecIntents]
  });
  const allowedExecBins = resolveAllowedExecBins({
    bins: config.tools.exec.allowBins,
    profile: config.tools.exec.profile,
    devMode
  });
  const toolRouter = new ToolRouter({
    approvalGate,
    allowedExecBins,
    isToolIsolationEnabled: () => incidentCommander.isToolIsolationEnabled()
  });
  toolRouter.register(createExecTool({ allowedBins: allowedExecBins, approvalGate }));
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
  const behavior = new BehaviorPolicyEngine({
    typingPolicy: new TypingPolicy("thinking"),
    presenceManager: new PresenceManager(),
    deliveryPacer: new DeliveryPacer(1_500),
    greetingPolicy: new GreetingPolicy()
  });
  const gateway = buildGateway({
    config,
    runtime,
    cronService,
    auth,
    rateLimiter,
    policyLogs,
    incidentCommander,
    behavior
  });

  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  await gateway.listen({
    host: config.gateway.bind === "loopback" ? "127.0.0.1" : "0.0.0.0",
    port
  });

  const orchestrator = new AutonomyOrchestrator({
    cronService,
    heartbeat,
    budget,
    workflow,
    memory,
    heartbeatChannelId: "heartbeat:main",
    cronTickMs: 1_000,
    integrityScanEveryMs: config.memory.integrityScanEveryMs,
    onCronRun: async (job) => {
      const sessionId = job.isolated ? `cron:${job.id}` : "main";
      await runtime.runTurn({
        session: {
          sessionId,
          channelId: sessionId,
          channelKind: "web"
        },
        messages: [
          {
            role: "user",
            content: `[cron:${job.id}] run scheduled task`
          }
        ]
      });
    },
    onHeartbeatTurn: async (channelId) => {
      const result = await runtime.runTurn({
        session: {
          sessionId: "heartbeat:main",
          channelId,
          channelKind: "web"
        },
        messages: [
          {
            role: "user",
            content: "Read HEARTBEAT.md if present. If no action needed, reply HEARTBEAT_OK."
          }
        ]
      });
      return result.assistantText.trim() === "" ? "HEARTBEAT_OK" : result.assistantText;
    }
  });
  orchestrator.start();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await orchestrator.stop();
    await gateway.close();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
