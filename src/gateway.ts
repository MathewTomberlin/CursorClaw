import Fastify, { type FastifyInstance } from "fastify";

import type { ChannelHub } from "./channels.js";
import type { CursorClawConfig } from "./config.js";
import type { BehaviorPolicyEngine } from "./responsiveness.js";
import type { RunStore } from "./run-store.js";
import type { AgentRuntime, TurnResult } from "./runtime.js";
import type { CronService } from "./scheduler.js";
import {
  AuthService,
  IncidentCommander,
  MethodRateLimiter,
  PolicyDecisionLogger,
  createAuditId,
  scoreInboundRisk
} from "./security.js";
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
}

const METHOD_SCOPES: Record<string, Array<"local" | "remote" | "admin">> = {
  "agent.run": ["local", "remote", "admin"],
  "agent.wait": ["local", "remote", "admin"],
  "chat.send": ["local", "remote", "admin"],
  "cron.add": ["admin", "local"],
  "incident.bundle": ["admin"]
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

  app.get("/status", async () => {
    return {
      gateway: "ok",
      defaultModel: deps.config.defaultModel,
      queueWarnings: deps.runtime.getQueueWarnings(),
      runtimeMetrics: deps.runtime.getMetrics(),
      schedulerBacklog: deps.cronService.listJobs().length,
      policyDecisions: deps.policyLogs.getAll().length,
      incident: {
        proactiveSendsDisabled: deps.incidentCommander.isProactiveSendsDisabled(),
        toolIsolationEnabled: deps.incidentCommander.isToolIsolationEnabled()
      }
    };
  });

  app.post("/rpc", async (request, reply) => {
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

    try {
      let result: unknown;
      if (body.method === "agent.run") {
        const session = parseSessionContext(body.params?.session);
        const messages = parseMessages(
          body.params?.messages,
          deps.config.session.maxMessagesPerTurn,
          deps.config.session.maxMessageChars
        );
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
        const job = deps.cronService.addJob({
          type,
          expression,
          isolated,
          maxRetries: 3,
          backoffMs: 1_000
        });
        result = { job };
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
          if (deps.channelHub) {
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
    throw new RpcGatewayError(400, "BAD_REQUEST", `too many messages in turn (limit=${maxMessagesPerTurn})`);
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
