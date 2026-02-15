import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { safeReadUtf8 } from "./fs-utils.js";

import {
  ChannelHub,
  LocalEchoChannelAdapter,
  SlackChannelAdapter,
  type SlackAdapterConfig
} from "./channels.js";
import { AutonomyStateStore } from "./autonomy-state.js";
import { buildGateway, type ProfileContext } from "./gateway.js";
import { DecisionJournal } from "./decision-journal.js";
import { InMemoryLifecycleStream } from "./lifecycle-stream/in-memory-stream.js";
import { ContextIndexService } from "./context/context-index-service.js";
import { LocalEmbeddingIndex } from "./context/embedding-index.js";
import { SemanticContextRetriever } from "./context/retriever.js";
import { SemanticSummaryCache } from "./context/summary-cache.js";
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
import { SemanticContextCollectorPlugin } from "./plugins/semantic-context.collector.js";
import { ProactiveSuggestionEngine } from "./proactive-suggestions.js";
import {
  PrivacyScrubber
} from "./privacy/privacy-scrubber.js";
import {
  DEFAULT_SECRET_SCANNER_DETECTORS,
  type SecretDetectorName
} from "./privacy/secret-scanner.js";
import { RunStore } from "./run-store.js";
import { getThread, setThread, appendMessage } from "./thread-store.js";
import { AgentRuntime } from "./runtime.js";
import { NetworkTraceCollector } from "./network/trace-collector.js";
import { FunctionExplainer } from "./reflection/function-explainer.js";
import { IdleReflectionScheduler } from "./reflection/idle-scheduler.js";
import { SpeculativeTestRunner } from "./reflection/speculative-test-runner.js";
import { ConfidenceModel } from "./reliability/confidence-model.js";
import { DeepScanService } from "./reliability/deep-scan.js";
import { FailureLoopGuard } from "./reliability/failure-loop.js";
import { GitCheckpointManager } from "./reliability/git-checkpoint.js";
import { ReasoningResetController } from "./reliability/reasoning-reset.js";
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
import { AuthService, IncidentCommander, MethodRateLimiter, PolicyDecisionLogger, validateBindAddress } from "./security.js";
import {
  CapabilityApprovalGate,
  ToolRouter,
  createExecTool,
  createGhPrReadTool,
  createGhPrWriteTool,
  createMcpCallTool,
  createMcpListResourcesTool,
  createMcpReadResourceTool,
  createProposeSoulIdentityUpdateTool,
  createRecallMemoryTool,
  createRememberThisTool,
  createWebFetchTool,
  createWebSearchTool
} from "./tools.js";
import type { CursorClawConfig } from "./config.js";
import { getDefaultProfileId, isDevMode, loadConfigFromDisk, validateStartupConfig, resolveConfigPath, resolveProfileRoot } from "./config.js";
import { AutonomyOrchestrator } from "./orchestrator.js";
import { loadSubstrate, SubstrateStore } from "./substrate/index.js";
import type { SubstrateContent } from "./substrate/index.js";
import { WorkspaceCatalog } from "./workspaces/catalog.js";
import { MultiRootIndexer } from "./workspaces/multi-root-indexer.js";
import { MemoryEmbeddingIndex } from "./continuity/memory-embedding-index.js";
import { loadSessionMemoryContext } from "./continuity/session-memory.js";

/** Exit code used when restart is requested; run-with-restart wrapper will re-run the process in the same terminal. */
export const RESTART_EXIT_CODE = 42;

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

/** Build one profile context (substrate, approvals, cron) for a given profile root. Used for single-profile and multi-profile. */
async function buildProfileContext(
  profileRoot: string,
  config: CursorClawConfig,
  options: { isDefault: boolean; pendingProactiveRef?: { current: string | null } }
): Promise<ProfileContext> {
  const substrateStore = new SubstrateStore();
  try {
    await substrateStore.reload(profileRoot, config.substrate);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[CursorClaw] substrate load failed for profile root, continuing with empty:", (err as Error).message);
  }
  const approvalsDir = join(profileRoot, "tmp", "approvals");
  const capabilityStore = new CapabilityStore({ stateDir: approvalsDir });
  await capabilityStore.load();
  const approvalWorkflow = new ApprovalWorkflow({
    capabilityStore,
    defaultGrantTtlMs: 10 * 60_000,
    defaultGrantUses: 1,
    stateDir: approvalsDir
  });
  await approvalWorkflow.load();
  const cronService = new CronService({
    maxConcurrentRuns: 4,
    stateFile: join(profileRoot, "tmp", "cron-state.json")
  });
  await cronService.loadState();
  const ctx: ProfileContext = {
    profileRoot,
    substrateStore,
    approvalWorkflow,
    capabilityStore,
    cronService
  };
  if (options.isDefault && options.pendingProactiveRef) {
    const ref = options.pendingProactiveRef;
    ctx.getPendingProactiveMessage = () => ref.current;
    ctx.takePendingProactiveMessage = () => {
      const v = ref.current;
      ref.current = null;
      return v;
    };
  }
  return ctx;
}

async function main(): Promise<void> {
  const workspaceDir = process.cwd();
  const configPath = resolveConfigPath({ cwd: workspaceDir });
  const initialConfig = loadConfigFromDisk({ cwd: workspaceDir });
  /** Live config ref so config.reload and heartbeat/budget see updates without restart. */
  const configRef = { current: initialConfig };
  const config = configRef.current;
  const tokenLen = config.gateway.auth.token?.length ?? config.gateway.auth.password?.length ?? 0;
  // eslint-disable-next-line no-console
  console.log("[CursorClaw] config:", configPath, "| gateway auth token length:", tokenLen);
  const devMode = isDevMode();
  validateStartupConfig(config, {
    allowInsecureDefaults: devMode
  });

  const pendingProactiveRef = { current: null as string | null };
  /** Set when a user message cancels in-flight heartbeat; next heartbeat turn gets a resume notice. */
  const heartbeatInterruptedByUserRef = { current: false };
  const defaultProfileId = getDefaultProfileId(config);
  const profileList = config.profiles;
  let profileContextMap: Map<string, ProfileContext>;
  let defaultCtx: ProfileContext;
  if (profileList?.length) {
    profileContextMap = new Map();
    for (const p of profileList) {
      const root = resolveProfileRoot(workspaceDir, config, p.id);
      const isDefault = p.id === defaultProfileId;
      profileContextMap.set(p.id, await buildProfileContext(root, config, { isDefault, pendingProactiveRef }));
    }
    defaultCtx = profileContextMap.get(defaultProfileId)!;
  } else {
    const singleProfileRoot = resolveProfileRoot(workspaceDir, config);
    defaultCtx = await buildProfileContext(singleProfileRoot, config, { isDefault: true, pendingProactiveRef });
    profileContextMap = new Map([["default", defaultCtx]]);
  }
  const profileRoot = defaultCtx.profileRoot;

  if (
    !devMode &&
    config.tools.exec.profile === "developer"
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      "[CursorClaw] tools.exec.profile is 'developer': exec runs with process privileges. Use only in trusted environments."
    );
  }
  if (config.gateway.bind !== "loopback") {
    // eslint-disable-next-line no-console
    console.warn(
      "[CursorClaw] gateway.bind is not 'loopback': gateway is reachable from other hosts. Ensure auth and network are locked down."
    );
  }
  if (!devMode && config.memory.includeSecretsInPrompt) {
    // eslint-disable-next-line no-console
    console.warn(
      "[CursorClaw] memory.includeSecretsInPrompt is true: secret-bearing memory may be sent to the model. Use only in controlled environments."
    );
  }
  const incidentCommander = new IncidentCommander();
  const decisionJournal = new DecisionJournal({
    path: join(profileRoot, "CLAW_HISTORY.log"),
    maxBytes: 5 * 1024 * 1024
  });
  const observationStore = new RuntimeObservationStore({
    maxEvents: 5_000,
    stateFile: join(profileRoot, "tmp", "observations.json")
  });
  await observationStore.load();
  const workspaceCatalog = new WorkspaceCatalog({
    roots:
      config.workspaces.roots.length > 0
        ? config.workspaces.roots
        : [
            {
              id: "primary",
              path: profileRoot,
              priority: 0,
              enabled: true
            }
          ]
  });
  const summaryCache = new SemanticSummaryCache({
    stateFile: join(profileRoot, "tmp", "context-summary.json"),
    maxEntries: config.contextCompression.summaryCacheMaxEntries
  });
  await summaryCache.load();
  const embeddingIndex = new LocalEmbeddingIndex({
    stateFile: join(profileRoot, "tmp", "context-embeddings.json"),
    maxChunks: config.contextCompression.embeddingMaxChunks
  });
  await embeddingIndex.load();
  const retriever = new SemanticContextRetriever({
    summaryCache,
    embeddingIndex
  });
  const multiRootIndexer = new MultiRootIndexer({
    maxFilesPerRoot: config.contextCompression.maxFilesPerRoot,
    maxFileBytes: config.contextCompression.maxFileBytes,
    includeExtensions: config.contextCompression.includeExtensions
  });
  const contextIndexService = new ContextIndexService({
    workspaceCatalog,
    retriever,
    indexer: multiRootIndexer,
    stateFile: join(profileRoot, "tmp", "context-index-state.json"),
    refreshEveryMs: config.contextCompression.refreshEveryMs
  });
  if (config.contextCompression.semanticRetrievalEnabled) {
    await contextIndexService.ensureFreshIndex();
  }

  let memoryEmbeddingIndex: MemoryEmbeddingIndex | null = null;
  const hasRollingWindow =
    config.continuity?.memoryMaxRecords != null || config.continuity?.memoryMaxChars != null;
  const memory = new MemoryStore({
    workspaceDir: profileRoot,
    ...(hasRollingWindow && {
      rollingWindow: {
        ...(config.continuity!.memoryMaxRecords != null && { maxRecords: config.continuity!.memoryMaxRecords }),
        ...(config.continuity!.memoryMaxChars != null && { maxChars: config.continuity!.memoryMaxChars }),
        ...(config.continuity!.memoryArchivePath != null && { archivePath: config.continuity!.memoryArchivePath }),
        onTrim: async () => {
          if (memoryEmbeddingIndex) {
            const records = await memory.readAll();
            await memoryEmbeddingIndex.upsertFromRecords(records, config.memory.includeSecretsInPrompt);
          }
        }
      }
    })
  });
  if (config.continuity?.memoryEmbeddingsEnabled) {
    memoryEmbeddingIndex = new MemoryEmbeddingIndex({
      stateFile: join(profileRoot, "tmp", "memory-embeddings.json"),
      maxRecords: config.continuity.memoryEmbeddingsMaxRecords ?? 3_000
    });
    await memoryEmbeddingIndex.load();
  }
  const configuredDetectors = config.privacy.detectors.filter(
    (detector): detector is SecretDetectorName => VALID_SECRET_DETECTORS.has(detector as SecretDetectorName)
  );
  const privacyScrubber = new PrivacyScrubber({
    enabled: config.privacy.scanBeforeEgress,
    failClosedOnError: devMode ? config.privacy.failClosedOnScannerError : true,
    detectors: configuredDetectors.length > 0 ? configuredDetectors : DEFAULT_SECRET_SCANNER_DETECTORS
  });
  const pmr = config.providerModelResilience;
  const adapter = new CursorAgentModelAdapter({
    models: config.models,
    defaultModel: config.defaultModel,
    ...(pmr?.useOnlyValidatedFallbacks === true && {
      providerModelResilience: {
        useOnlyValidatedFallbacks: true,
        ...(pmr.validationStorePath !== undefined &&
          pmr.validationStorePath !== "" && {
            validationStorePath: pmr.validationStorePath
          })
      }
    }),
    cwd: process.cwd()
  });
  const pluginHost = new PluginHost({
    defaultTimeoutMs: 2_500
  });
  pluginHost.registerCollector(new MemoryCollectorPlugin(memory, config.memory.includeSecretsInPrompt));
  pluginHost.registerCollector(new ObservationCollectorPlugin(observationStore));
  if (config.contextCompression.semanticRetrievalEnabled) {
    pluginHost.registerCollector(
      new SemanticContextCollectorPlugin({
        retriever,
        topK: config.contextCompression.topK,
        allowSecret: config.memory.includeSecretsInPrompt,
        ensureFreshIndex: async () => contextIndexService.ensureFreshIndex(),
        resolveCrossRepoSuspects: (repo) => {
          const graph = contextIndexService.getCrossRepoGraph();
          return graph.edges
            .filter((edge) => edge.fromRepo === repo && edge.confidence >= 0.6)
            .map((edge) => edge.toRepo)
            .slice(0, 6);
        }
      })
    );
  }
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

  const approvalGate = new CapabilityApprovalGate({
    devMode,
    approvalWorkflow: defaultCtx.approvalWorkflow!,
    capabilityStore: defaultCtx.capabilityStore!,
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
  toolRouter.register(
    createExecTool({
      allowedBins: allowedExecBins,
      approvalGate,
      ...(config.tools.exec.maxBufferBytes != null && { maxBufferBytes: config.tools.exec.maxBufferBytes }),
      ...(config.tools.exec.maxChildProcessesPerTurn != null && {
        maxChildProcessesPerTurn: config.tools.exec.maxChildProcessesPerTurn
      })
    })
  );
  toolRouter.register(createWebFetchTool({ approvalGate }));
  toolRouter.register(createWebFetchTool({ approvalGate, toolName: "mcp_web_fetch" }));
  toolRouter.register(createWebSearchTool({ approvalGate }));
  toolRouter.register(createWebSearchTool({ approvalGate, toolName: "mcp_web_search" }));
  if (config.mcp.enabled) {
    toolRouter.register(createMcpListResourcesTool({ registry: mcpRegistry }));
    toolRouter.register(createMcpReadResourceTool({ registry: mcpRegistry }));
    toolRouter.register(createMcpCallTool({ registry: mcpRegistry, approvalGate }));
  }
  if (config.continuity?.memoryEmbeddingsEnabled && memoryEmbeddingIndex) {
    const defaultProfileRoot = profileRoot;
    toolRouter.register(
      createRecallMemoryTool({
        getRecallResults: async (root, query, topK) => {
          if (root !== defaultProfileRoot) return [];
          const records = await memory.readAll();
          await memoryEmbeddingIndex!.upsertFromRecords(records, config.memory.includeSecretsInPrompt);
          return memoryEmbeddingIndex!.query({ query, topK });
        }
      })
    );
  }
  toolRouter.register(
    createRememberThisTool({
      appendRecord: (record) => memory.append(record)
    })
  );
  if (config.substrate?.allowSoulIdentityEvolution) {
    const getSubstrateContent = (profileRoot: string): SubstrateContent | undefined => {
      if (profileContextMap) {
        for (const ctx of profileContextMap.values()) {
          if (ctx.profileRoot === profileRoot && ctx.substrateStore) return ctx.substrateStore.get();
        }
      }
      if (defaultCtx.profileRoot === profileRoot && defaultCtx.substrateStore) return defaultCtx.substrateStore.get();
      return undefined;
    };
    toolRouter.register(createProposeSoulIdentityUpdateTool({ getSubstrateContent }));
  }
  if (config.tools.gh?.enabled) {
    const ghRepoScope = config.tools.gh.repoScope && String(config.tools.gh.repoScope).trim() ? config.tools.gh.repoScope : undefined;
    toolRouter.register(
      createGhPrReadTool({
        approvalGate,
        workspaceCwd: profileRoot,
        ...(ghRepoScope != null && { repoScope: ghRepoScope }),
        ...(config.tools.exec.maxBufferBytes != null && { maxBufferBytes: config.tools.exec.maxBufferBytes })
      })
    );
    if (config.tools.gh.allowWrite) {
      toolRouter.register(
        createGhPrWriteTool({
          approvalGate,
          workspaceCwd: profileRoot,
          ...(ghRepoScope != null && { repoScope: ghRepoScope }),
          ...(config.tools.exec.maxBufferBytes != null && { maxBufferBytes: config.tools.exec.maxBufferBytes })
        })
      );
    }
  }

  const confidenceModel = new ConfidenceModel();
  const deepScanService = new DeepScanService({
    workspaceDir: profileRoot,
    maxFiles: 600,
    maxDurationMs: 7_000
  });
  const reasoningResetController = new ReasoningResetController({
    iterationThreshold: config.reliability.reasoningResetIterations
  });
  let recentBackgroundTestsPassing = false;

  const getSubstrate = (): SubstrateContent => defaultCtx.substrateStore!.get();

  const runStore = new RunStore({
    stateFile: join(profileRoot, "tmp", "run-store.json"),
    maxCompletedRuns: 10_000
  });
  await runStore.load();
  await runStore.markInFlightInterrupted();

  let interruptedNoticeShown = false;
  const getInterruptedRunNotice = async (): Promise<string | undefined> => {
    if (interruptedNoticeShown) return undefined;
    const had = await runStore.hasInterruptedRuns();
    if (!had) return undefined;
    interruptedNoticeShown = true;
    return "Previous run was interrupted by process restart.";
  };

  const lifecycleStream = new InMemoryLifecycleStream();
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
    reasoningResetController,
    deepScanService,
    confidenceModel,
    lowConfidenceThreshold: config.reliability.lowConfidenceThreshold,
    hasRecentTestsPassing: async () => recentBackgroundTestsPassing,
    ...(config.reliability.checkpoint.enabled
      ? {
          gitCheckpointManager: new GitCheckpointManager({
            workspaceDir: profileRoot,
            reliabilityCheckCommands: config.reliability.checkpoint.reliabilityCommands,
            commandTimeoutMs: config.reliability.checkpoint.commandTimeoutMs,
            decisionJournal
          })
        }
      : {}),
    privacyScrubber,
    lifecycleStream,
    snapshotDir: join(profileRoot, "tmp", "snapshots"),
    getSubstrate,
    getProfileRoot: (profileId: string) => profileContextMap.get(profileId)?.profileRoot ?? defaultCtx.profileRoot,
    getSessionMemoryContext: (root: string) => {
      const c = configRef.current.continuity;
      if (c?.sessionMemoryEnabled === false) return Promise.resolve(undefined);
      const cap = c?.sessionMemoryCap;
      return loadSessionMemoryContext(root, cap != null ? { capChars: cap } : undefined);
    },
    getInterruptedRunNotice
  });

  const heartbeat = new HeartbeatRunner(() => configRef.current.heartbeat);
  const budget = new AutonomyBudget(config.autonomyBudget);
  const workflow = new WorkflowRuntime(join(profileRoot, "tmp", "workflow-state"));

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
  const functionExplainer = new FunctionExplainer({
    workspaceDir: profileRoot
  });
  const networkTraceCollector = new NetworkTraceCollector({
    enabled: config.networkTrace.enabled,
    allowHosts: config.networkTrace.allowHosts.map((host) => host.toLowerCase()),
    observationStore,
    getIndexedModulePaths: async () => {
      const indexed = await contextIndexService.listIndexedFiles(4_000);
      return indexed.map((entry) => entry.modulePath);
    }
  });
  const idleScheduler = new IdleReflectionScheduler({
    idleAfterMs: config.reflection.idleAfterMs,
    tickMs: config.reflection.tickMs,
    maxConcurrentJobs: 1
  });
  let orchestratorRef: AutonomyOrchestrator | null = null;
  let ensureReflectionJobQueued: (() => void) | null = null;
  /** When a heartbeat produces a proactive message, it is stored here so clients can retrieve it via heartbeat.poll or /status. */
  let pendingProactiveMessage: string | null = null;
  if (config.reflection.enabled) {
    const speculativeTestRunner = new SpeculativeTestRunner({
      workspaceDir: profileRoot,
      command: config.reflection.flakyTestCommand,
      runs: config.reflection.flakyRuns,
      timeoutMs: config.reflection.maxJobMs
    });
    const scheduleFlakyScan = (): void => {
      if (idleScheduler.hasJob("reflection:flaky-scan")) {
        return;
      }
      idleScheduler.enqueue({
        id: "reflection:flaky-scan",
        run: async () => {
          const result = await speculativeTestRunner.run();
          const changedModules = (await contextIndexService.listIndexedFiles(12)).map((entry) => entry.modulePath);
          recentBackgroundTestsPassing = result.failCount === 0;
          await observationStore.append({
            source: "reflection",
            kind: "flaky-scan",
            sensitivity: "operational",
            payload: {
              command: result.command,
              outcomes: result.outcomes,
              flakyScore: result.flakyScore,
              confidence: result.confidence,
              durationMs: result.durationMs,
              changedModules: changedModules.slice(0, 8)
            }
          });
          await decisionJournal.append({
            type: "idle-reflection",
            summary: "Background flaky scan completed",
            metadata: {
              flakyScore: result.flakyScore,
              confidence: result.confidence,
              passCount: result.passCount,
              failCount: result.failCount,
              changedModules: changedModules.slice(0, 8)
            }
          });
          if (
            result.flakyScore >= 35 &&
            orchestratorRef &&
            !incidentCommander.isProactiveSendsDisabled()
          ) {
            await orchestratorRef.queueProactiveIntent({
              channelId: "system",
              text: `Background reflection detected flaky behavior (score ${result.flakyScore}) around: ${changedModules
                .slice(0, 4)
                .join(", ")}. Consider rerunning targeted tests and isolating nondeterministic dependencies.`
            });
          }
          scheduleFlakyScan();
        }
      });
    };
    ensureReflectionJobQueued = scheduleFlakyScan;
    scheduleFlakyScan();
    idleScheduler.start();
  }
  const uiDist = join(workspaceDir, "ui", "dist");
  const gateway = buildGateway({
    getConfig: () => configRef.current,
    setConfig: (c) => {
      configRef.current = c;
    },
    runtime,
    cronService: defaultCtx.cronService,
    ...(runStore !== undefined ? { runStore } : {}),
    threadStore: { getThread, setThread, appendMessage },
    ...(channelHub !== undefined ? { channelHub } : {}),
    auth,
    rateLimiter,
    policyLogs,
    incidentCommander,
    ...(behavior !== undefined ? { behavior } : {}),
    ...(defaultCtx.approvalWorkflow !== undefined ? { approvalWorkflow: defaultCtx.approvalWorkflow } : {}),
    ...(defaultCtx.capabilityStore !== undefined ? { capabilityStore: defaultCtx.capabilityStore } : {}),
    defaultProfileId: getDefaultProfileId(configRef.current),
    getProfileContext: (profileId) => profileContextMap.get(profileId),
    lifecycleStream,
    workspaceDir: profileRoot,
    workspaceRoot: workspaceDir,
    ...(defaultCtx.substrateStore !== undefined ? { substrateStore: defaultCtx.substrateStore } : {}),
    markHeartbeatInterrupted: () => {
      heartbeatInterruptedByUserRef.current = true;
    },
    ...(existsSync(uiDist) ? { uiDistPath: uiDist } : {}),
    onRestart: async () => {
      // Exit with RESTART_EXIT_CODE so run-with-restart wrapper runs build then start in the same terminal.
      process.exit(RESTART_EXIT_CODE);
      return { buildRan: true };
    },
    onActivity: () => {
      idleScheduler.noteActivity();
      ensureReflectionJobQueued?.();
    },
    onFileChangeSuggestions: async ({ channelId, files, enqueue }) => {
      const suggestionResult = suggestionEngine.suggestForChannel(channelId, { files });
      const suggestions = suggestionResult.suggestions;
      let queued = 0;
      if (enqueue && orchestratorRef && suggestions.length > 0 && !incidentCommander.isProactiveSendsDisabled()) {
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
          queued,
          throttled: suggestionResult.throttled
        }
      });
      return {
        suggestions,
        queued
      };
    },
    onWorkspaceStatus: async () => {
      await contextIndexService.ensureFreshIndex();
      const health = await workspaceCatalog.healthCheck();
      const indexed = await contextIndexService.listIndexedFiles(6_000);
      const graph = contextIndexService.getCrossRepoGraph();
      return {
        roots: health,
        indexedFiles: indexed.length,
        crossRepoEdges: graph.edges.length,
        graphBuiltAt: graph.builtAt
      };
    },
    onWorkspaceSemanticSearch: async ({ query, topK, workspace, repo }) => {
      await contextIndexService.ensureFreshIndex();
      const hits = await retriever.retrieve({
        query,
        topK,
        ...(workspace ? { workspace } : {}),
        ...(repo ? { repo } : {}),
        allowSecret: config.memory.includeSecretsInPrompt
      });
      const grouped = retriever.rankByModule(hits).slice(0, topK);
      const graph = contextIndexService.getCrossRepoGraph();
      const suspectRepos = new Set<string>();
      for (const entry of grouped) {
        for (const edge of graph.edges) {
          if (edge.fromRepo === entry.repo && edge.confidence >= 0.6) {
            suspectRepos.add(edge.toRepo);
          }
        }
      }
      return {
        query,
        results: grouped.map((entry) => ({
          workspace: entry.workspace,
          repo: entry.repo,
          modulePath: entry.modulePath,
          maxScore: entry.maxScore,
          averageScore: entry.averageScore,
          summary: entry.summary?.summary ?? "",
          symbols: entry.summary?.symbols ?? [],
          chunks: entry.chunks.slice(0, 2).map((chunk) => ({
            score: chunk.score,
            chunkIndex: chunk.chunkIndex,
            text: chunk.chunkText
          }))
        })),
        crossRepoSuspects: [...suspectRepos]
      };
    },
    onTraceIngest: async (trace) => {
      await contextIndexService.ensureFreshIndex();
      return networkTraceCollector.ingest(trace);
    },
    onExplainFunction: async ({ modulePath, symbol }) => {
      await contextIndexService.ensureFreshIndex();
      const indexed = await contextIndexService.listIndexedFiles(8_000);
      const match = indexed.find((entry) => entry.modulePath === modulePath || entry.path.endsWith(modulePath));
      if (!match) {
        return {
          error: `module not indexed: ${modulePath}`,
          confidence: 0
        };
      }
      const sourceText = await safeReadUtf8(match.path);
      if (sourceText == null || sourceText === "") {
        return {
          error: `could not read file (missing or invalid encoding): ${match.path}`,
          confidence: 0
        };
      }
      const graph = contextIndexService.getCrossRepoGraph();
      const callerHints = graph.edges
        .filter((edge) => edge.signal.includes(symbol) || edge.fromModule.endsWith(modulePath))
        .map((edge) => `${edge.fromRepo}:${edge.fromModule}`)
        .slice(0, 10);
      const explanation = await functionExplainer.explain({
        modulePath: match.modulePath,
        symbol,
        sourceText,
        callerHints
      });
      return {
        ...explanation,
        provenance: {
          workspace: match.workspaceId,
          repo: match.repo,
          modulePath: match.modulePath
        }
      };
    },
  });

  if (existsSync(uiDist)) {
    const fastifyStatic = (await import("@fastify/static")).default;
    await gateway.register(fastifyStatic, { root: uiDist });
    gateway.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.includes(".")) {
        return reply.sendFile("index.html", uiDist);
      }
      return reply.code(404).send({ error: "Not found" });
    });
  }

  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  const bindHost =
    config.gateway.bindAddress?.trim() ||
    (config.gateway.bind === "loopback" ? "127.0.0.1" : "0.0.0.0");
  if (config.gateway.bindAddress?.trim()) {
    await validateBindAddress(config.gateway.bindAddress.trim());
  }
  await gateway.listen({
    host: bindHost,
    port
  });

  // Config file watcher: reload when openclaw.json (or CURSORCLAW_CONFIG_PATH) changes so edits from another device apply without clicking Reload.
  if (existsSync(configPath)) {
    let configReloadTimeout: ReturnType<typeof setTimeout> | null = null;
    watch(configPath, { persistent: false }, () => {
      if (configReloadTimeout) clearTimeout(configReloadTimeout);
      configReloadTimeout = setTimeout(() => {
        configReloadTimeout = null;
        try {
          configRef.current = loadConfigFromDisk({ cwd: workspaceDir });
          // eslint-disable-next-line no-console
          console.log("[CursorClaw] config reloaded from disk (file change)");
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[CursorClaw] config reload from file change failed:", (err as Error).message);
        }
      }, 500);
    });
  }

  // C.1 BOOT.md: run once at process startup when enabled and file exists
  const bootEnabled = configRef.current.continuity?.bootEnabled !== false;
  const bootPath = join(profileRoot, "BOOT.md");
  if (bootEnabled && existsSync(bootPath)) {
    try {
      const bootContent = await safeReadUtf8(bootPath);
      const trimmed = bootContent?.trim() ?? "";
      if (trimmed.length > 0) {
        const bootInstruction =
          "[BOOT] Process just started. Execute the following once. If you have a welcome or status message for the user, write it in your reply; it will be delivered to the main chat. End your reply with BOOT_DONE.\n\n" +
          trimmed;
        const result = await runtime.runTurn({
          session: {
            sessionId: "boot:main",
            channelId: "heartbeat:main",
            channelKind: "web",
            profileId: getDefaultProfileId(configRef.current)
          },
          messages: [{ role: "user", content: bootInstruction }]
        });
        const reply = result.assistantText.trim();
        const doneMarker = "BOOT_DONE";
        const doneIndex = reply.indexOf(doneMarker);
        const messageToUser = doneIndex >= 0 ? reply.slice(0, doneIndex).trim() : reply;
        if (messageToUser.length > 0) {
          await channelHub.send({
            channelId: "heartbeat:main",
            text: messageToUser,
            proactive: true
          });
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[CursorClaw] BOOT.md run failed:", (err as Error).message);
    }
  }

  const birthPath = join(profileRoot, config.substrate?.birthPath ?? "BIRTH.md");
  const heartbeatPathForStartup = join(profileRoot, "HEARTBEAT.md");
  let heartbeatHasSubstantiveContent = false;
  try {
    if (existsSync(heartbeatPathForStartup)) {
      const fc = await safeReadUtf8(heartbeatPathForStartup);
      const trimmed = (fc ?? "").trim();
      heartbeatHasSubstantiveContent = trimmed
        .split("\n")
        .some((line) => {
          const s = line.trim();
          return s.length > 0 && !s.startsWith("#");
        });
    }
  } catch {
    /* ignore */
  }
  const useShortFirstHeartbeat =
    existsSync(birthPath) || heartbeatHasSubstantiveContent;
  const orchestrator = new AutonomyOrchestrator({
    cronService: defaultCtx.cronService,
    heartbeat,
    budget,
    workflow,
    memory,
    autonomyStateStore: new AutonomyStateStore({
      stateFile: join(profileRoot, "tmp", "autonomy-state.json")
    }),
    heartbeatChannelId: "heartbeat:main",
    cronTickMs: 1_000,
    integrityScanEveryMs: config.memory.integrityScanEveryMs,
    intentTickMs: 1_000,
    ...(useShortFirstHeartbeat ? { firstHeartbeatDelayMs: 10_000 } : {}),
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
      const heartbeatPath = join(profileRoot, "HEARTBEAT.md");
      const birthPending = existsSync(birthPath);
      const fallbackMessage =
        "Hi — BIRTH is pending for this workspace. I'm here to help you set up: who you are (USER.md), who I am here (IDENTITY.md), and how you want to use this agent. What's your main use case, and what would you like to call me?";
      try {
      const heartbeatConfig = configRef.current.heartbeat;
      const skipWhenEmpty = heartbeatConfig.skipWhenEmpty === true;
      // Do not skip heartbeat when BIRTH.md exists — agent must get a chance to send a proactive BIRTH message.
      if (skipWhenEmpty && !birthPending) {
        if (!existsSync(heartbeatPath)) {
          return "HEARTBEAT_OK";
        }
        const fileContent = await safeReadUtf8(heartbeatPath);
        const trimmed = (fileContent ?? "").trim();
        const hasSubstantiveLine = trimmed
          .split(/\n/)
          .some((line) => {
            const s = line.trim();
            return s.length > 0 && !s.startsWith("#");
          });
        if (!hasSubstantiveLine) {
          return "HEARTBEAT_OK";
        }
      }
      const baseInstruction =
        heartbeatConfig.prompt ?? "If no action needed, reply HEARTBEAT_OK.";
      let content: string;
      if (existsSync(heartbeatPath)) {
        const fileContent = await safeReadUtf8(heartbeatPath);
        const deliveryNote =
          "Anything you write before HEARTBEAT_OK will be delivered to the user as a proactive message in the CursorClaw web Chat. So if HEARTBEAT.md asks for an update or message, write it first, then end with HEARTBEAT_OK.";
        content =
          `Instructions for this heartbeat (from HEARTBEAT.md):\n\n${(fileContent ?? "").trim()}\n\n${deliveryNote}\n\n${baseInstruction}`;
      } else {
        content = `Read HEARTBEAT.md if present. ${baseInstruction}`;
      }
      if (heartbeatInterruptedByUserRef.current) {
        heartbeatInterruptedByUserRef.current = false;
        content =
          "The previous heartbeat was interrupted by a user message. Continue with ROADMAP.md and HEARTBEAT.md as appropriate.\n\n" +
          content;
      }
      if (birthPending) {
        content =
          `BIRTH.md is present. You must complete BIRTH proactively: reply with your message to the user (e.g. introduce yourself and ask for their use case and identity). Do not reply HEARTBEAT_OK — your reply will be delivered as a proactive message in the CursorClaw web UI Chat tab (the user is there, not in Cursor IDE).\n\n${content}`;
      }
      const result = await runtime.runTurn({
        session: {
          sessionId: "heartbeat:main",
          channelId,
          channelKind: "web",
          profileId: getDefaultProfileId(configRef.current)
        },
        messages: [{ role: "user", content }]
      });
      const reply = result.assistantText.trim();
      const okMarker = "HEARTBEAT_OK";
      const okIndex = reply.indexOf(okMarker);
      const messageToUser =
        okIndex >= 0 ? reply.slice(0, okIndex).trim() : reply;
      const hasProactiveContent =
        messageToUser.length > 0 && reply !== okMarker;
      const heartbeatHadContent = existsSync(heartbeatPath);
      if (process.env.NODE_ENV !== "test") {
        console.warn(
          "[CursorClaw] heartbeat reply length:",
          reply.length,
          "hasProactiveContent:",
          hasProactiveContent
        );
      }
      if (hasProactiveContent) {
        const textToDeliver = okIndex >= 0 ? messageToUser : result.assistantText;
        await channelHub.send({
          channelId,
          text: textToDeliver,
          proactive: true
        });
        pendingProactiveMessage = textToDeliver;
        pendingProactiveRef.current = textToDeliver;
      } else if (birthPending) {
        // Fallback: model returned HEARTBEAT_OK or empty; still deliver a BIRTH prompt so the user sees a proactive message
        const fallbackMessage =
          "Hi — BIRTH is pending for this workspace. I’m here to help you set up: who you are (USER.md), who I am here (IDENTITY.md), and how you want to use this agent. What’s your main use case, and what would you like to call me?";
        await channelHub.send({
          channelId,
          text: fallbackMessage,
          proactive: true
        });
        pendingProactiveMessage = fallbackMessage;
        pendingProactiveRef.current = fallbackMessage;
      } else if (heartbeatHadContent) {
        const heartbeatFallback =
          "Heartbeat ran. No update from the agent this time.";
        await channelHub.send({
          channelId,
          text: heartbeatFallback,
          proactive: true
        });
        pendingProactiveMessage = heartbeatFallback;
        pendingProactiveRef.current = heartbeatFallback;
      }
      return reply === "" ? "HEARTBEAT_OK" : result.assistantText;
      } catch (err) {
        console.error("[CursorClaw] heartbeat turn error:", err);
        if (birthPending) {
          pendingProactiveMessage = fallbackMessage;
          pendingProactiveRef.current = fallbackMessage;
        }
        return "HEARTBEAT_OK";
      }
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

  const metricsIntervalSeconds = config.metrics.intervalSeconds ?? 60;
  const metricsExportHandle =
    config.metrics.export === "log"
      ? setInterval(() => {
          const adapterMetrics = runtime.getAdapterMetrics();
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({ ts: new Date().toISOString(), adapterMetrics }));
        }, metricsIntervalSeconds * 1000)
      : null;

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (metricsExportHandle !== null) {
      clearInterval(metricsExportHandle);
    }
    await orchestrator.stop();
    idleScheduler.stop();
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
