import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

import type { ChannelHub } from "./channels.js";
import {
  type CursorClawConfig,
  getDefaultProfileId,
  resolveProfileRoot,
  writeConfigToDisk
} from "./config.js";
import type { BehaviorPolicyEngine } from "./responsiveness.js";
import type { RunStore } from "./run-store.js";
import type { AgentRuntime, TurnResult } from "./runtime.js";
import type { CronService } from "./scheduler.js";
import type { ApprovalWorkflow } from "./security/approval-workflow.js";
import type { CapabilityStore } from "./security/capabilities.js";
import {
  AuthService,
  IncidentCommander,
  MethodRateLimiter,
  PolicyDecisionLogger,
  createAuditId,
  scoreInboundRisk
} from "./security.js";
import type { LifecycleStream } from "./lifecycle-stream/types.js";
import type { SubstrateStore } from "./substrate/index.js";
import { DEFAULT_SUBSTRATE_PATHS, SUBSTRATE_DEFAULTS, SUBSTRATE_KEYS } from "./substrate/index.js";
import type { RpcRequest, RpcResponse, SessionContext } from "./types.js";

interface PendingRun {
  promise: Promise<TurnResult>;
  result?: TurnResult;
  error?: string;
}

class RpcGatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly rpcCode: string,
    readonly clientMessage: string
  ) {
    super(clientMessage);
  }
}

/** Per-profile context for profile-scoped RPCs (substrate, memory, heartbeat, approval, cron). */
export interface ProfileContext {
  profileRoot: string;
  substrateStore?: SubstrateStore;
  approvalWorkflow?: ApprovalWorkflow;
  capabilityStore?: CapabilityStore;
  cronService: CronService;
  getPendingProactiveMessage?: () => string | null;
  takePendingProactiveMessage?: () => string | null;
}

export interface GatewayDependencies {
  config: CursorClawConfig;
  runtime: AgentRuntime;
  cronService: CronService;
  runStore?: RunStore;
  channelHub?: ChannelHub;
  auth: AuthService;
  rateLimiter: MethodRateLimiter;
  policyLogs: PolicyDecisionLogger;
  incidentCommander: IncidentCommander;
  behavior?: BehaviorPolicyEngine;
  approvalWorkflow?: ApprovalWorkflow;
  capabilityStore?: CapabilityStore;
  /** When set, profile-scoped RPCs use this context for the resolved profileId. Single-profile mode: omit or return one context for "default". */
  getProfileContext?: (profileId: string) => ProfileContext | undefined;
  onFileChangeSuggestions?: (args: {
    channelId: string;
    files: string[];
    enqueue: boolean;
  }) => Promise<{
    suggestions: string[];
    queued: number;
  }>;
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
  onExplainFunction?: (args: {
    modulePath: string;
    symbol: string;
  }) => Promise<unknown>;
  onActivity?: () => void;
  lifecycleStream?: LifecycleStream;
  /** If provided, called before channelHub.send; return false to skip delivery. */
  onBeforeSend?: (channelId: string, text: string) => Promise<boolean>;
  /** If set, GET / serves index.html from this path; otherwise GET / serves a simple "UI not built" page. */
  uiDistPath?: string;
  /** When admin.restart is called, exit with RESTART_EXIT_CODE so the start:watch wrapper runs build then start. */
  onRestart?: () => Promise<{ buildRan?: boolean } | void>;
  /** Default agent profile id when no profileId is supplied in the RPC. Enables profile-scoped RPCs when multiple profiles exist. */
  defaultProfileId?: string;
  /** Workspace root (for substrate.update path resolution). */
  workspaceDir?: string;
  /** Process workspace root (cwd); required for profile.create/delete and path validation. */
  workspaceRoot?: string;
  /** When substrate config is present, store for list/get/update/reload. */
  substrateStore?: SubstrateStore;
  /** If set, used by heartbeat.poll and /status to expose proactive messages from heartbeat turns. */
  getPendingProactiveMessage?: () => string | null;
  /** If set, heartbeat.poll calls this to return and clear the pending proactive message. */
  takePendingProactiveMessage?: () => string | null;
}

/** Resolve profile context for profile-scoped RPCs. Uses getProfileContext when present, otherwise builds a one-off context from deps (single-profile). */
function getEffectiveProfileContext(deps: GatewayDependencies, resolvedProfileId: string): ProfileContext {
  const fromGetter = deps.getProfileContext?.(resolvedProfileId);
  if (fromGetter) return fromGetter;
  return {
    profileRoot: deps.workspaceDir ?? "",
    ...(deps.substrateStore !== undefined ? { substrateStore: deps.substrateStore } : {}),
    ...(deps.approvalWorkflow !== undefined ? { approvalWorkflow: deps.approvalWorkflow } : {}),
    ...(deps.capabilityStore !== undefined ? { capabilityStore: deps.capabilityStore } : {}),
    cronService: deps.cronService,
    ...(deps.getPendingProactiveMessage !== undefined ? { getPendingProactiveMessage: deps.getPendingProactiveMessage } : {}),
    ...(deps.takePendingProactiveMessage !== undefined ? { takePendingProactiveMessage: deps.takePendingProactiveMessage } : {})
  };
}

const METHOD_SCOPES: Record<string, Array<"local" | "remote" | "admin">> = {
  "agent.run": ["local", "remote", "admin"],
  "agent.wait": ["local", "remote", "admin"],
  "chat.send": ["local", "remote", "admin"],
  "cron.add": ["admin", "local"],
  "cron.list": ["admin", "local"],
  "incident.bundle": ["admin"],
  "approval.list": ["admin", "local"],
  "approval.resolve": ["admin", "local"],
  "approval.capabilities": ["admin", "local"],
  "advisor.file_change": ["local", "remote", "admin"],
  "workspace.status": ["local", "remote", "admin"],
  "workspace.semantic_search": ["local", "remote", "admin"],
  "trace.ingest": ["local", "remote", "admin"],
  "advisor.explain_function": ["local", "remote", "admin"],
  "config.get": ["admin", "local"],
  "profile.list": ["admin", "local"],
  "profile.create": ["admin", "local"],
  "profile.delete": ["admin", "local"],
  "admin.restart": ["admin", "local"],
  "substrate.list": ["admin", "local"],
  "substrate.get": ["admin", "local"],
  "substrate.update": ["admin", "local"],
  "substrate.reload": ["admin", "local"],
  "memory.listLogs": ["admin", "local"],
  "memory.getFile": ["admin", "local"],
  "memory.writeFile": ["admin", "local"],
  "heartbeat.poll": ["local", "remote", "admin"],
  "heartbeat.getFile": ["local", "remote", "admin"],
  "heartbeat.update": ["local", "remote", "admin"]
};

export function buildGateway(deps: GatewayDependencies): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: deps.config.gateway.bodyLimitBytes
  });
  const pendingRuns = new Map<string, PendingRun>();

  app.get("/health", async () => {
    return {
      ok: true,
      time: new Date().toISOString()
    };
  });

  app.get("/", async (_request, reply) => {
    if (deps.uiDistPath) {
      const html = await readFile(join(deps.uiDistPath, "index.html"), "utf8");
      return reply.type("text/html").send(html);
    }
    return reply.type("text/html").send(
      "<!DOCTYPE html><html><head><title>CursorClaw</title></head><body><p>UI not built. Run <code>npm run build</code>.</p><p><a href=\"/health\">Health</a> | <a href=\"/status\">Status</a></p></body></html>"
    );
  });

  const streamConnectionsBySubject = new Map<string, number>();
  const MAX_STREAM_CONNECTIONS_PER_SUBJECT = 2;

  app.get("/stream", async (request, reply) => {
    const auth = deps.auth.authorize({
      isLocal: request.ip === "127.0.0.1" || request.ip === "::1",
      remoteIp: request.ip,
      headers: mapHeaders(request.headers)
    });
    if (!auth.ok) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    if (!deps.lifecycleStream) {
      return reply.code(503).send({ error: "Lifecycle stream not configured" });
    }
    const sessionId = (request.query as { sessionId?: string }).sessionId;
    const subject = sessionId ?? request.ip ?? "unknown";
    const count = streamConnectionsBySubject.get(subject) ?? 0;
    if (count >= MAX_STREAM_CONNECTIONS_PER_SUBJECT) {
      return reply.code(429).send({ error: "Too many stream connections" });
    }
    streamConnectionsBySubject.set(subject, count + 1);
    request.raw.on("close", () => {
      const n = (streamConnectionsBySubject.get(subject) ?? 1) - 1;
      if (n <= 0) streamConnectionsBySubject.delete(subject);
      else streamConnectionsBySubject.set(subject, n);
    });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const raw = reply.raw as NodeJS.WritableStream & { flush?: () => void };
    const send = (event: unknown) => {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
      raw.flush?.();
    };
    void (async () => {
      try {
        for await (const event of deps.lifecycleStream!.subscribe(sessionId)) {
          send(event);
          if (request.raw.destroyed) break;
          await new Promise((r) => setImmediate(r));
        }
      } catch {
        // client disconnected or stream closed
      }
    })();
    return reply;
  });

  app.get("/status", async () => {
    const profiles =
      (deps.config.profiles?.length ?? 0) > 0
        ? deps.config.profiles!.map((p) => ({ id: p.id, root: p.root, modelId: p.modelId }))
        : [{ id: "default", root: "." }];
    const defaultProfileId = deps.defaultProfileId ?? getDefaultProfileId(deps.config);
    const defaultCtx = getEffectiveProfileContext(deps, defaultProfileId);
    const base = {
      gateway: "ok",
      defaultModel: deps.config.defaultModel,
      profiles,
      defaultProfileId,
      queueWarnings: deps.runtime.getQueueWarnings(),
      runtimeMetrics: deps.runtime.getMetrics(),
      reliability: {
        multiPathResolutionsLast24h: deps.runtime.getMultiPathResolutionsLast24h()
      },
      adapterMetrics: deps.runtime.getAdapterMetrics() ?? {},
      schedulerBacklog: defaultCtx.cronService.listJobs().length,
      policyDecisions: deps.policyLogs.getAll().length,
      approvals: {
        pending: defaultCtx.approvalWorkflow?.listRequests({ status: "pending" }).length ?? 0,
        activeCapabilities: defaultCtx.capabilityStore?.listActive().length ?? 0
      },
      incident: {
        proactiveSendsDisabled: deps.incidentCommander.isProactiveSendsDisabled(),
        toolIsolationEnabled: deps.incidentCommander.isToolIsolationEnabled()
      }
    };
    const pendingProactive = defaultCtx.getPendingProactiveMessage?.() ?? null;
    return pendingProactive !== null ? { ...base, pendingProactiveMessage: pendingProactive } : base;
  });

  app.post("/rpc", async (request, reply) => {
    deps.onActivity?.();
    const body = (request.body ?? {}) as RpcRequest;
    const auditId = createAuditId("req");
    if (!body.method || !body.version) {
      return reply.code(400).send(errorResponse(body.id, auditId, "PROTO_VERSION_UNSUPPORTED", "Invalid RPC envelope"));
    }

    if (body.version !== deps.config.gateway.protocolVersion) {
      deps.policyLogs.add({
        auditId,
        method: body.method,
        decision: "deny",
        reasonCode: "PROTO_VERSION_UNSUPPORTED"
      });
      return reply.code(400).send(errorResponse(body.id, auditId, "PROTO_VERSION_UNSUPPORTED", "Unsupported protocol version"));
    }

    const auth = deps.auth.authorize({
      isLocal: request.ip === "127.0.0.1" || request.ip === "::1",
      remoteIp: request.ip,
      headers: mapHeaders(request.headers)
    });
    if (!auth.ok) {
      deps.policyLogs.add({
        auditId,
        method: body.method,
        decision: "deny",
        reasonCode: auth.reason ?? "AUTH_INVALID"
      });
      return reply.code(401).send(errorResponse(body.id, auditId, auth.reason ?? "AUTH_INVALID", "Unauthorized"));
    }

    const allowedRoles = METHOD_SCOPES[body.method];
    if (!allowedRoles || !allowedRoles.includes(auth.role)) {
      deps.policyLogs.add({
        auditId,
        method: body.method,
        decision: "deny",
        reasonCode: "AUTH_ROLE_MISMATCH"
      });
      return reply.code(403).send(errorResponse(body.id, auditId, "AUTH_ROLE_MISMATCH", "Forbidden"));
    }

    const subject = request.ip || "unknown";
    if (!deps.rateLimiter.allow(body.method, subject)) {
      deps.policyLogs.add({
        auditId,
        method: body.method,
        decision: "deny",
        reasonCode: "RATE_LIMITED"
      });
      return reply.code(429).send(errorResponse(body.id, auditId, "RATE_LIMITED", "Rate limited"));
    }

    const promptText = typeof body.params?.text === "string" ? body.params.text : JSON.stringify(body.params ?? {});
    const risk = scoreInboundRisk({
      senderTrusted: auth.role !== "remote",
      recentTriggerCount: 0,
      text: promptText
    });
    if (risk >= 90) {
      deps.policyLogs.add({
        auditId,
        method: body.method,
        decision: "deny",
        reasonCode: "RISK_BLOCKED",
        detail: `risk score=${risk}`
      });
      return reply.code(400).send(errorResponse(body.id, auditId, "RISK_BLOCKED", "Request risk score too high"));
    }

    // Resolve profile for profile-scoped RPCs. When absent, use default (backward compatible).
    const resolvedProfileId =
      body.params?.profileId != null ? String(body.params.profileId) : (deps.defaultProfileId ?? "default");
    const profileCtx = getEffectiveProfileContext(deps, resolvedProfileId);

    try {
      let result: unknown;
      if (body.method === "agent.run") {
        const session = parseSessionContext(body.params?.session);
        session.profileId = resolvedProfileId;
        const messages = parseMessages(
          body.params?.messages,
          deps.config.session.maxMessagesPerTurn,
          deps.config.session.maxMessageChars
        );
        // Runtime compacts via applyUserMessageFreshness; no user-facing message limit.
        const started = deps.runtime.startTurn({ session, messages });
        if (deps.runStore) {
          await deps.runStore.createPending(started.runId, session.sessionId);
        }
        pendingRuns.set(started.runId, {
          promise: started.promise
            .then(async (resolved) => {
              if (deps.runStore) {
                await deps.runStore.markCompleted(started.runId, resolved);
              }
              pendingRuns.set(started.runId, {
                promise: started.promise,
                result: resolved
              });
              return resolved;
            })
            .catch(async (error: unknown) => {
              if (deps.runStore) {
                await deps.runStore.markFailed(started.runId, String(error));
              }
              pendingRuns.set(started.runId, {
                promise: started.promise,
                error: String(error)
              });
              throw error;
            })
        });
        const runId = started.runId;
        result = { runId };
      } else if (body.method === "agent.wait") {
        const runId = String(body.params?.runId ?? "");
        const pending = pendingRuns.get(runId);
        if (!pending) {
          const persisted = deps.runStore ? await deps.runStore.get(runId) : undefined;
          if (!persisted) {
            throw new RpcGatewayError(404, "NOT_FOUND", `runId not found: ${runId}`);
          }
          if (persisted.status === "completed" && persisted.result !== undefined) {
            await deps.runStore?.consume(runId);
            result = persisted.result;
          } else if (persisted.status === "pending") {
            throw new RpcGatewayError(409, "RUN_UNAVAILABLE", `runId is no longer active: ${runId}`);
          } else {
            await deps.runStore?.consume(runId);
            throw new Error(persisted.error ?? `run failed: ${runId}`);
          }
        } else if (pending.result !== undefined) {
          pendingRuns.delete(runId);
          await deps.runStore?.consume(runId);
          result = pending.result;
        } else if (pending.error !== undefined) {
          pendingRuns.delete(runId);
          await deps.runStore?.consume(runId);
          throw new Error(pending.error);
        }
        if (pending && pending.result === undefined && pending.error === undefined) {
          try {
            const resolved = await pending.promise;
            result = resolved;
            await deps.runStore?.consume(runId);
          } finally {
            pendingRuns.delete(runId);
          }
        }
      } else if (body.method === "cron.add") {
        const type = String(body.params?.type ?? "every") as "at" | "every" | "cron";
        const expression = String(body.params?.expression ?? "30m");
        const isolated = Boolean(body.params?.isolated ?? true);
        const job = profileCtx.cronService.addJob({
          type,
          expression,
          isolated,
          maxRetries: 3,
          backoffMs: 1_000
        });
        result = { job };
      } else if (body.method === "cron.list") {
        result = { jobs: profileCtx.cronService.listJobs() };
      } else if (body.method === "chat.send") {
        const channelId = String(body.params?.channelId ?? "unknown");
        const proactive = Boolean(body.params?.proactive ?? false);
        if (proactive && deps.incidentCommander.isProactiveSendsDisabled()) {
          throw new RpcGatewayError(403, "FORBIDDEN", "proactive sends disabled by incident mode");
        }
        const behaviorPlan = deps.behavior?.planSend({
          channelId,
          threadId: String(body.params?.threadId ?? channelId),
          isNewThread: Boolean(body.params?.isNewThread ?? false),
          isComplex: String(body.params?.text ?? "").length > 240,
          hasToolCalls: false,
          urgent: Boolean(body.params?.urgent ?? false)
        });
        if (behaviorPlan && !behaviorPlan.allowSend) {
          result = {
            delivered: false,
            channelId,
            text: String(body.params?.text ?? ""),
            reason: "paced"
          };
        } else {
          const text = String(body.params?.text ?? "");
          const finalText =
            behaviorPlan?.shouldGreet === true && !/^(hi|hello|hey)\b/i.test(text)
              ? `Hi! ${text}`
              : text;
          const allowSend =
            deps.onBeforeSend === undefined ? true : await deps.onBeforeSend(channelId, finalText);
          if (!allowSend) {
            result = {
              delivered: false,
              channelId,
              text: finalText,
              provider: "callback",
              detail: "onBeforeSend returned false"
            };
          } else if (deps.channelHub) {
            const dispatch = await deps.channelHub.send({
              channelId,
              text: finalText,
              threadId: String(body.params?.threadId ?? channelId),
              proactive,
              typingEvents: behaviorPlan?.typingEvents ?? [],
              urgent: Boolean(body.params?.urgent ?? false)
            });
            result = {
              ...dispatch,
              typingEvents: behaviorPlan?.typingEvents ?? []
            };
          } else {
            result = {
              delivered: true,
              channelId,
              text: finalText,
              typingEvents: behaviorPlan?.typingEvents ?? []
            };
          }
        }
      } else if (body.method === "incident.bundle") {
        const tokens = parseIncidentTokens(body.params?.tokens);
        if (tokens.length > 0) {
          deps.incidentCommander.revokeTokens(tokens);
        }
        deps.incidentCommander.disableProactiveSends();
        deps.incidentCommander.isolateToolHosts();
        result = deps.incidentCommander.exportForensicLog(deps.policyLogs);
      } else if (body.method === "approval.list") {
        if (!profileCtx.approvalWorkflow) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "approval workflow not configured");
        }
        const status = body.params?.status;
        if (status !== undefined && !["pending", "approved", "denied", "expired"].includes(String(status))) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "invalid approval status filter");
        }
        result = {
          requests: profileCtx.approvalWorkflow.listRequests(
            status !== undefined ? { status: String(status) as "pending" | "approved" | "denied" | "expired" } : undefined
          )
        };
      } else if (body.method === "approval.resolve") {
        if (!profileCtx.approvalWorkflow) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "approval workflow not configured");
        }
        const requestId = String(body.params?.requestId ?? "");
        if (!requestId) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "approval requestId is required");
        }
        const decision = String(body.params?.decision ?? "");
        if (!["approve", "deny"].includes(decision)) {
          throw new RpcGatewayError(400, "BAD_REQUEST", 'approval decision must be "approve" or "deny"');
        }
        const grantTtlMs = parseOptionalPositiveInteger(body.params?.grantTtlMs, "grantTtlMs");
        const grantUses = parseOptionalPositiveInteger(body.params?.grantUses, "grantUses");
        const reason = body.params?.reason !== undefined ? String(body.params.reason) : undefined;
        result = {
          request: profileCtx.approvalWorkflow.resolve({
            requestId,
            decision: decision as "approve" | "deny",
            ...(reason !== undefined ? { reason } : {}),
            ...(grantTtlMs !== undefined ? { grantTtlMs } : {}),
            ...(grantUses !== undefined ? { grantUses } : {})
          })
        };
      } else if (body.method === "approval.capabilities") {
        if (!profileCtx.capabilityStore) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "capability store not configured");
        }
        result = {
          grants: profileCtx.capabilityStore.listActive()
        };
      } else if (body.method === "advisor.file_change") {
        if (!deps.onFileChangeSuggestions) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "proactive suggestion engine not configured");
        }
        const channelId = String(body.params?.channelId ?? "system");
        const files = parseStringArray(body.params?.files, "files");
        const enqueue = Boolean(body.params?.enqueue ?? true);
        result = await deps.onFileChangeSuggestions({
          channelId,
          files,
          enqueue
        });
      } else if (body.method === "workspace.status") {
        if (!deps.onWorkspaceStatus) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "workspace status service not configured");
        }
        result = await deps.onWorkspaceStatus();
      } else if (body.method === "workspace.semantic_search") {
        if (!deps.onWorkspaceSemanticSearch) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "workspace semantic search not configured");
        }
        const query = String(body.params?.query ?? "").trim();
        if (!query) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "query is required");
        }
        const topK = parseOptionalPositiveInteger(body.params?.topK, "topK") ?? 8;
        const workspace = body.params?.workspace !== undefined ? String(body.params.workspace) : undefined;
        const repo = body.params?.repo !== undefined ? String(body.params.repo) : undefined;
        result = await deps.onWorkspaceSemanticSearch({
          query,
          topK,
          ...(workspace ? { workspace } : {}),
          ...(repo ? { repo } : {})
        });
      } else if (body.method === "trace.ingest") {
        if (!deps.onTraceIngest) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "trace ingestion service not configured");
        }
        const method = String(body.params?.method ?? "GET");
        const url = String(body.params?.url ?? "");
        if (!url) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "trace url is required");
        }
        const status = parseOptionalPositiveInteger(body.params?.status, "status") ?? 200;
        const latencyMs = parseOptionalPositiveInteger(body.params?.latencyMs, "latencyMs") ?? 0;
        const headers = parseOptionalStringRecord(body.params?.headers, "headers");
        result = await deps.onTraceIngest({
          ...(body.params?.sessionId !== undefined ? { sessionId: String(body.params.sessionId) } : {}),
          method,
          url,
          status,
          latencyMs,
          ...(body.params?.requestBody !== undefined ? { requestBody: body.params.requestBody } : {}),
          ...(body.params?.responseBody !== undefined ? { responseBody: body.params.responseBody } : {}),
          ...(headers ? { headers } : {})
        });
      } else if (body.method === "advisor.explain_function") {
        if (!deps.onExplainFunction) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "function explainer not configured");
        }
        const modulePath = String(body.params?.modulePath ?? "").trim();
        const symbol = String(body.params?.symbol ?? "").trim();
        if (!modulePath || !symbol) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "modulePath and symbol are required");
        }
        result = await deps.onExplainFunction({
          modulePath,
          symbol
        });
      } else if (body.method === "config.get") {
        const c = deps.config;
        result = {
          ...c,
          gateway: {
            ...c.gateway,
            auth: {
              ...c.gateway.auth,
              token:
                c.gateway.auth.token !== undefined
                  ? { redacted: true, length: c.gateway.auth.token.length }
                  : undefined,
              password:
                c.gateway.auth.password !== undefined
                  ? { redacted: true, length: c.gateway.auth.password.length }
                  : undefined
            }
          }
        };
      } else if (body.method === "profile.list") {
        const list = deps.config.profiles;
        const profiles =
          (list?.length ?? 0) > 0
            ? list!.map((p) => ({ id: p.id, root: p.root, modelId: p.modelId }))
            : [{ id: "default", root: "." }];
        result = {
          profiles,
          defaultProfileId: deps.defaultProfileId ?? getDefaultProfileId(deps.config)
        };
      } else if (body.method === "profile.create") {
        if (!deps.workspaceRoot) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "workspace root not configured");
        }
        const id = typeof body.params?.id === "string" ? body.params.id.trim() : "";
        const root = typeof body.params?.root === "string" ? body.params.root.trim() : "";
        if (!id) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "profile id is required");
        }
        if (!root) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "profile root is required");
        }
        const list = deps.config.profiles ?? [];
        if (list.some((p) => p.id === id)) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "profile id already exists");
        }
        let profileRootPath: string;
        try {
          profileRootPath = resolveProfileRoot(deps.workspaceRoot, { ...deps.config, profiles: [...list, { id, root }] }, id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "profile root must be under workspace";
          throw new RpcGatewayError(400, "BAD_REQUEST", msg);
        }
        const newProfiles =
          list.length === 0 ? [{ id: "default", root: "." }, { id, root }] : [...list, { id, root }];
        (deps.config as CursorClawConfig).profiles = newProfiles;
        await mkdir(profileRootPath, { recursive: true });
        const configPath = await writeConfigToDisk(deps.config, { cwd: deps.workspaceRoot });
        result = { profile: { id, root }, configPath };
      } else if (body.method === "profile.delete") {
        if (!deps.workspaceRoot) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "workspace root not configured");
        }
        const id = typeof body.params?.id === "string" ? body.params.id.trim() : "";
        if (!id) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "profile id is required");
        }
        const list = deps.config.profiles ?? [];
        if (list.length === 0) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "no profiles to delete (single default profile)");
        }
        const idx = list.findIndex((p) => p.id === id);
        if (idx < 0) {
          throw new RpcGatewayError(404, "NOT_FOUND", "profile not found");
        }
        if (list.length === 1) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "cannot delete the only profile");
        }
        const removeDirectory = body.params?.removeDirectory === true;
        const removed = list[idx]!;
        const newProfiles = list.filter((p) => p.id !== id);
        (deps.config as CursorClawConfig).profiles = newProfiles;
        await writeConfigToDisk(deps.config, { cwd: deps.workspaceRoot });
        if (removeDirectory) {
          try {
            const dirPath = resolveProfileRoot(deps.workspaceRoot, { ...deps.config, profiles: [removed] }, id);
            const base = resolve(deps.workspaceRoot);
            const prefix = base.endsWith(sep) ? base : base + sep;
            if (dirPath !== base && dirPath.startsWith(prefix)) {
              await rm(dirPath, { recursive: true, force: true });
            }
          } catch {
            // ignore cleanup errors
          }
        }
        result = { ok: true };
      } else if (body.method === "heartbeat.poll") {
        const message = profileCtx.takePendingProactiveMessage?.() ?? null;
        result = message !== null ? { result: "ok", proactiveMessage: message } : { result: "ok" };
      } else if (body.method === "heartbeat.getFile") {
        if (!profileCtx.profileRoot) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "workspace not configured");
        }
        const heartbeatPath = join(profileCtx.profileRoot, "HEARTBEAT.md");
        const content = await readFile(heartbeatPath, "utf8").catch(() => "");
        result = { content };
      } else if (body.method === "heartbeat.update") {
        if (!profileCtx.profileRoot) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "workspace not configured");
        }
        const content = typeof body.params?.content === "string" ? body.params.content : String(body.params?.content ?? "");
        const heartbeatPath = join(profileCtx.profileRoot, "HEARTBEAT.md");
        await writeFile(heartbeatPath, content, "utf8");
        result = { ok: true };
      } else if (body.method === "substrate.list") {
        if (!profileCtx.substrateStore) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "substrate not configured");
        }
        const pathKeys: Record<string, string> = { ...DEFAULT_SUBSTRATE_PATHS };
        const sub = deps.config.substrate;
        if (sub) {
          if (sub.agentsPath) pathKeys.agentsPath = sub.agentsPath;
          if (sub.identityPath) pathKeys.identityPath = sub.identityPath;
          if (sub.soulPath) pathKeys.soulPath = sub.soulPath;
          if (sub.birthPath) pathKeys.birthPath = sub.birthPath;
          if (sub.capabilitiesPath) pathKeys.capabilitiesPath = sub.capabilitiesPath;
          if (sub.userPath) pathKeys.userPath = sub.userPath;
          if (sub.toolsPath) pathKeys.toolsPath = sub.toolsPath;
        }
        result = {
          keys: SUBSTRATE_KEYS.map((key) => {
            const pathKey = `${key}Path`;
            const path = pathKeys[pathKey];
            const content = profileCtx.substrateStore!.get();
            return {
              key,
              path: path ?? DEFAULT_SUBSTRATE_PATHS[pathKey as keyof typeof DEFAULT_SUBSTRATE_PATHS],
              present: (content as Record<string, string | undefined>)[key] != null
            };
          })
        };
      } else if (body.method === "substrate.get") {
        if (!profileCtx.substrateStore) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "substrate not configured");
        }
        const key = body.params?.key !== undefined ? String(body.params.key) : undefined;
        const content = profileCtx.substrateStore.get();
        const withDefaults = (c: Record<string, string | undefined>) => {
          const out: Record<string, string> = {};
          for (const k of SUBSTRATE_KEYS) {
            const v = c[k];
            out[k] = (v != null && v.trim() !== "" ? v : SUBSTRATE_DEFAULTS[k]) ?? "";
          }
          return out;
        };
        if (key !== undefined) {
          const value = (content as Record<string, string | undefined>)[key];
          const resolved =
            value != null && value.trim() !== ""
              ? value
              : (SUBSTRATE_DEFAULTS[key] ?? "");
          result = { [key]: resolved };
        } else {
          result = withDefaults(content as Record<string, string | undefined>);
        }
      } else if (body.method === "substrate.update") {
        if (!profileCtx.substrateStore || !profileCtx.profileRoot) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "substrate not configured");
        }
        const key = String(body.params?.key ?? "").trim();
        const content = String(body.params?.content ?? "");
        if (!key) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "key is required");
        }
        try {
          await profileCtx.substrateStore.writeKey(
            profileCtx.profileRoot,
            deps.config.substrate,
            key,
            content
          );
          result = { ok: true };
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes("Invalid substrate key") || msg.includes("under workspace")) {
            throw new RpcGatewayError(400, "BAD_REQUEST", msg);
          }
          throw err;
        }
      } else if (body.method === "substrate.reload") {
        if (!profileCtx.substrateStore || !profileCtx.profileRoot) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "substrate not configured");
        }
        await profileCtx.substrateStore.reload(profileCtx.profileRoot, deps.config.substrate);
        await profileCtx.substrateStore.ensureDefaults(profileCtx.profileRoot, deps.config.substrate);
        result = { ok: true };
      } else if (body.method === "memory.listLogs") {
        if (!profileCtx.profileRoot) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "workspace not configured");
        }
        const memoryDir = join(profileCtx.profileRoot, "memory");
        const entries = await readdir(memoryDir, { withFileTypes: true }).catch(() => []);
        const files = entries
          .filter((e) => e.isFile() && e.name.endsWith(".md") && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name))
          .map((e) => ({ name: e.name, path: `memory/${e.name}` }))
          .sort((a, b) => b.name.localeCompare(a.name));
        result = { files };
      } else if (body.method === "memory.getFile") {
        if (!profileCtx.profileRoot) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "workspace not configured");
        }
        const pathParam = String(body.params?.path ?? "").trim();
        if (!pathParam) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "path is required");
        }
        const allowed = pathParam === "MEMORY.md" || /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(pathParam);
        if (!allowed) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "path must be MEMORY.md or memory/YYYY-MM-DD.md");
        }
        const fullPath = resolve(profileCtx.profileRoot, pathParam);
        const workspaceResolved = resolve(profileCtx.profileRoot);
        if (!fullPath.startsWith(workspaceResolved) || fullPath === workspaceResolved) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "invalid path");
        }
        const content = await readFile(fullPath, "utf8").catch(() => "");
        result = { path: pathParam, content };
      } else if (body.method === "memory.writeFile") {
        if (!profileCtx.profileRoot) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "workspace not configured");
        }
        const pathParam = String(body.params?.path ?? "").trim();
        const content = typeof body.params?.content === "string" ? body.params.content : String(body.params?.content ?? "");
        if (!pathParam) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "path is required");
        }
        const allowed = pathParam === "MEMORY.md" || /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(pathParam);
        if (!allowed) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "path must be MEMORY.md or memory/YYYY-MM-DD.md");
        }
        const fullPath = resolve(profileCtx.profileRoot, pathParam);
        const workspaceResolved = resolve(profileCtx.profileRoot);
        if (!fullPath.startsWith(workspaceResolved) || fullPath === workspaceResolved) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "invalid path");
        }
        const { mkdir } = await import("node:fs/promises");
        if (pathParam.startsWith("memory/")) {
          await mkdir(join(profileCtx.profileRoot, "memory"), { recursive: true });
        }
        await writeFile(fullPath, content, "utf8");
        result = { ok: true };
      } else if (body.method === "admin.restart") {
        if (!deps.onRestart) {
          throw new RpcGatewayError(400, "BAD_REQUEST", "restart not configured");
        }
        result = await deps.onRestart();
      } else {
        throw new RpcGatewayError(400, "BAD_REQUEST", `unknown method: ${body.method}`);
      }

      deps.policyLogs.add({
        auditId,
        method: body.method,
        decision: "allow",
        reasonCode: "ALLOWED",
        detail: "request completed"
      });
      const response: RpcResponse = {
        auditId,
        ok: true,
        result
      };
      if (body.id !== undefined) {
        response.id = body.id;
      }
      return response;
    } catch (error: unknown) {
      const mapped = mapRpcError(error);
      return reply.code(mapped.statusCode).send(errorResponse(body.id, auditId, mapped.rpcCode, mapped.clientMessage));
    }
  });

  return app;
}

function parseSessionContext(value: unknown): SessionContext {
  const session = value as Partial<SessionContext>;
  if (!session?.sessionId || !session.channelId || !session.channelKind) {
    throw new RpcGatewayError(400, "BAD_REQUEST", "invalid session context");
  }
  const out: SessionContext = {
    sessionId: session.sessionId,
    channelId: session.channelId,
    channelKind: session.channelKind
  };
  if (session.userId !== undefined) {
    out.userId = session.userId;
  }
  return out;
}

function parseMessages(
  value: unknown,
  maxMessagesPerTurn: number,
  maxMessageChars: number
): Array<{ role: string; content: string }> {
  if (!Array.isArray(value)) {
    throw new RpcGatewayError(400, "BAD_REQUEST", "messages must be array");
  }
  if (value.length > maxMessagesPerTurn) {
    throw new RpcGatewayError(
      400,
      "BAD_REQUEST",
      `message count exceeds server limit (${maxMessagesPerTurn}); reduce or clear thread`
    );
  }
  return value.map((entry) => {
    const item = entry as { role?: unknown; content?: unknown };
    const content = String(item.content ?? "");
    if (content.length > maxMessageChars) {
      throw new RpcGatewayError(400, "BAD_REQUEST", `message too long (limit=${maxMessageChars})`);
    }
    return {
      role: String(item.role ?? "user"),
      content
    };
  });
}

function parseIncidentTokens(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new RpcGatewayError(400, "BAD_REQUEST", "incident tokens must be array");
  }
  return value.map((token) => String(token));
}

function parseOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RpcGatewayError(400, "BAD_REQUEST", `${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new RpcGatewayError(400, "BAD_REQUEST", `${fieldName} must be array`);
  }
  return value.map((entry) => String(entry));
}

function parseOptionalStringRecord(
  value: unknown,
  fieldName: string
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcGatewayError(400, "BAD_REQUEST", `${fieldName} must be object`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = String(entry);
  }
  return out;
}

function errorResponse(id: string | undefined, auditId: string, code: string, message: string): RpcResponse {
  const response: RpcResponse = {
    auditId,
    ok: false,
    error: {
      code,
      message
    }
  };
  if (id !== undefined) {
    response.id = id;
  }
  return response;
}

function mapHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      out[key.toLowerCase()] = value.join(",");
    } else if (typeof value === "string") {
      out[key.toLowerCase()] = value;
    } else {
      out[key.toLowerCase()] = undefined;
    }
  }
  return out;
}

function mapRpcError(error: unknown): {
  statusCode: number;
  rpcCode: string;
  clientMessage: string;
} {
  if (error instanceof RpcGatewayError) {
    return {
      statusCode: error.statusCode,
      rpcCode: error.rpcCode,
      clientMessage: error.clientMessage
    };
  }
  if (error instanceof Error) {
    return {
      statusCode: 500,
      rpcCode: "INTERNAL",
      clientMessage: "Internal server error"
    };
  }
  return {
    statusCode: 500,
    rpcCode: "INTERNAL",
    clientMessage: "Internal server error"
  };
}
