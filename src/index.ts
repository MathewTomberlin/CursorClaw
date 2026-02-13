import { join } from "node:path";

import {
  ChannelHub,
  LocalEchoChannelAdapter,
  SlackChannelAdapter,
  type SlackAdapterConfig
} from "./channels.js";
import { AutonomyStateStore } from "./autonomy-state.js";
import { buildGateway } from "./gateway.js";
import { DecisionJournal } from "./decision-journal.js";
import { MemoryStore } from "./memory.js";
import { InMemoryMcpServerAdapter, McpRegistry } from "./mcp.js";
import { CursorAgentModelAdapter } from "./model-adapter.js";
import {
  ContextAnalyzerPlugin,
  MemoryCollectorPlugin,
  ObservationCollectorPlugin,
  PromptSynthesizerPlugin
} from "./plugins/builtins.js";
import { PluginHost } from "./plugins/host.js";
import { ProactiveSuggestionEngine } from "./proactive-suggestions.js";
import {
  PrivacyScrubber
} from "./privacy/privacy-scrubber.js";
import {
  DEFAULT_SECRET_SCANNER_DETECTORS,
  type SecretDetectorName
} from "./privacy/secret-scanner.js";
import { RunStore } from "./run-store.js";
import { AgentRuntime } from "./runtime.js";
import { FailureLoopGuard } from "./reliability/failure-loop.js";
import { GitCheckpointManager } from "./reliability/git-checkpoint.js";
import { RuntimeObservationStore } from "./runtime-observation.js";
import { AutonomyBudget, CronService, HeartbeatRunner, WorkflowRuntime } from "./scheduler.js";
import {
  BehaviorPolicyEngine,
  DeliveryPacer,
  GreetingPolicy,
  PresenceManager,
  TypingPolicy
} from "./responsiveness.js";
import { ApprovalWorkflow } from "./security/approval-workflow.js";
import { CapabilityStore } from "./security/capabilities.js";
import { AuthService, IncidentCommander, MethodRateLimiter, PolicyDecisionLogger } from "./security.js";
import {
  CapabilityApprovalGate,
  ToolRouter,
  createExecTool,
  createMcpCallTool,
  createMcpListResourcesTool,
  createMcpReadResourceTool,
  createWebFetchTool
} from "./tools.js";
import { isDevMode, loadConfigFromDisk, validateStartupConfig } from "./config.js";
import { AutonomyOrchestrator } from "./orchestrator.js";

const STRICT_EXEC_BINS = new Set(["echo", "pwd", "ls", "cat", "node"]);
const VALID_SECRET_DETECTORS = new Set(DEFAULT_SECRET_SCANNER_DETECTORS);

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
  const decisionJournal = new DecisionJournal({
    path: join(workspaceDir, "CLAW_HISTORY.log"),
    maxBytes: 5 * 1024 * 1024
  });
  const observationStore = new RuntimeObservationStore({
    maxEvents: 5_000,
    stateFile: join(workspaceDir, "tmp", "observations.json")
  });
  await observationStore.load();

  const memory = new MemoryStore({ workspaceDir });
  const configuredDetectors = config.privacy.detectors.filter(
    (detector): detector is SecretDetectorName => VALID_SECRET_DETECTORS.has(detector as SecretDetectorName)
  );
  const privacyScrubber = new PrivacyScrubber({
    enabled: config.privacy.scanBeforeEgress,
    failClosedOnError: config.privacy.failClosedOnScannerError,
    detectors: configuredDetectors.length > 0 ? configuredDetectors : DEFAULT_SECRET_SCANNER_DETECTORS
  });
  const adapter = new CursorAgentModelAdapter({
    models: config.models,
    defaultModel: config.defaultModel
  });
  const pluginHost = new PluginHost({
    defaultTimeoutMs: 2_500
  });
  pluginHost.registerCollector(new MemoryCollectorPlugin(memory, config.memory.includeSecretsInPrompt));
  pluginHost.registerCollector(new ObservationCollectorPlugin(observationStore));
  pluginHost.registerAnalyzer(new ContextAnalyzerPlugin());
  pluginHost.registerSynthesizer(new PromptSynthesizerPlugin());
  const mcpRegistry = new McpRegistry({
    allowedServers: config.mcp.allowServers
  });
  const localMcpServer = new InMemoryMcpServerAdapter("local");
  localMcpServer.defineResource(
    "cursorclaw://status",
    "CursorClaw local MCP status resource.",
    "text/plain",
    "status"
  );
  localMcpServer.defineTool("echo", async (args) => ({ echoed: args }));
  mcpRegistry.register(localMcpServer);

  const capabilityStore = new CapabilityStore();
  const approvalWorkflow = new ApprovalWorkflow({
    capabilityStore,
    defaultGrantTtlMs: 10 * 60_000,
    defaultGrantUses: 1
  });
  const approvalGate = new CapabilityApprovalGate({
    devMode,
    approvalWorkflow,
    capabilityStore,
    allowReadOnlyWithoutGrant: config.tools.exec.ask !== "always"
  });
  const allowedExecBins = resolveAllowedExecBins({
    bins: config.tools.exec.allowBins,
    profile: config.tools.exec.profile,
    devMode
  });
  const toolRouter = new ToolRouter({
    approvalGate,
    allowedExecBins,
    isToolIsolationEnabled: () => incidentCommander.isToolIsolationEnabled(),
    decisionJournal
  });
  toolRouter.register(createExecTool({ allowedBins: allowedExecBins, approvalGate }));
  toolRouter.register(createWebFetchTool({ approvalGate }));
  if (config.mcp.enabled) {
    toolRouter.register(createMcpListResourcesTool({ registry: mcpRegistry }));
    toolRouter.register(createMcpReadResourceTool({ registry: mcpRegistry }));
    toolRouter.register(createMcpCallTool({ registry: mcpRegistry, approvalGate }));
  }

  const runtime = new AgentRuntime({
    config,
    adapter,
    toolRouter,
    memory,
    pluginHost,
    observationStore,
    decisionJournal,
    failureLoopGuard: new FailureLoopGuard({
      escalationThreshold: config.reliability.failureEscalationThreshold
    }),
    gitCheckpointManager: config.reliability.checkpoint.enabled
      ? new GitCheckpointManager({
          workspaceDir,
          reliabilityCheckCommands: config.reliability.checkpoint.reliabilityCommands,
          commandTimeoutMs: config.reliability.checkpoint.commandTimeoutMs,
          decisionJournal
        })
      : undefined,
    privacyScrubber,
    snapshotDir: join(workspaceDir, "tmp", "snapshots")
  });

  const cronService = new CronService({
    maxConcurrentRuns: 4,
    stateFile: join(workspaceDir, "tmp", "cron-state.json")
  });
  await cronService.loadState();
  const runStore = new RunStore({
    stateFile: join(workspaceDir, "tmp", "run-store.json"),
    maxCompletedRuns: 10_000
  });
  await runStore.load();
  await runStore.markInFlightInterrupted();

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
    isTokenRevoked?: (token: string) => boolean;
  } = {
    mode: config.gateway.auth.mode,
    trustedProxyIps: config.gateway.trustedProxyIps,
    isTokenRevoked: (token: string) => incidentCommander.isTokenRevoked(token)
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
  const channelHub = new ChannelHub();
  const slackConfig: SlackAdapterConfig = {
    enabled: /^(1|true|yes)$/i.test(process.env.CURSORCLAW_SLACK_ENABLED ?? "")
  };
  if (process.env.SLACK_BOT_TOKEN) {
    slackConfig.botToken = process.env.SLACK_BOT_TOKEN;
  }
  if (process.env.SLACK_DEFAULT_CHANNEL) {
    slackConfig.defaultChannel = process.env.SLACK_DEFAULT_CHANNEL;
  }
  channelHub.register(new SlackChannelAdapter(slackConfig));
  channelHub.register(new LocalEchoChannelAdapter());
  const suggestionEngine = new ProactiveSuggestionEngine();
  let orchestratorRef: AutonomyOrchestrator | null = null;
  const gateway = buildGateway({
    config,
    runtime,
    cronService,
    runStore,
    channelHub,
    auth,
    rateLimiter,
    policyLogs,
    incidentCommander,
    behavior,
    approvalWorkflow,
    capabilityStore,
    onFileChangeSuggestions: async ({ channelId, files, enqueue }) => {
      const suggestions = suggestionEngine.suggest({ files });
      let queued = 0;
      if (enqueue && orchestratorRef && suggestions.length > 0) {
        for (const suggestion of suggestions) {
          await orchestratorRef.queueProactiveIntent({
            channelId,
            text: suggestion
          });
          queued += 1;
        }
      }
      await decisionJournal.append({
        type: "file-change-suggestions",
        summary: `Generated ${suggestions.length} proactive suggestions`,
        metadata: {
          channelId,
          files,
          queued
        }
      });
      return {
        suggestions,
        queued
      };
    }
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
    autonomyStateStore: new AutonomyStateStore({
      stateFile: join(workspaceDir, "tmp", "autonomy-state.json")
    }),
    heartbeatChannelId: "heartbeat:main",
    cronTickMs: 1_000,
    integrityScanEveryMs: config.memory.integrityScanEveryMs,
    intentTickMs: 1_000,
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
    },
    onProactiveIntent: async (intent) => {
      const delivered = await channelHub.send({
        channelId: intent.channelId,
        text: intent.text,
        proactive: true
      });
      return delivered.delivered;
    }
  });
  orchestratorRef = orchestrator;
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
