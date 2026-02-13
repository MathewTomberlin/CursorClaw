import Fastify, { type FastifyInstance } from "fastify";

import type { CursorClawConfig } from "./config.js";
import type { AgentRuntime, TurnResult } from "./runtime.js";
import type { CronService } from "./scheduler.js";
import {
  AuthService,
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

export interface GatewayDependencies {
  config: CursorClawConfig;
  runtime: AgentRuntime;
  cronService: CronService;
  auth: AuthService;
  rateLimiter: MethodRateLimiter;
  policyLogs: PolicyDecisionLogger;
}

const METHOD_SCOPES: Record<string, Array<"local" | "remote" | "admin">> = {
  "agent.run": ["local", "remote", "admin"],
  "agent.wait": ["local", "remote", "admin"],
  "chat.send": ["local", "remote", "admin"],
  "cron.add": ["admin", "local"],
  "incident.bundle": ["admin"]
};

export function buildGateway(deps: GatewayDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
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
      schedulerBacklog: deps.cronService.listJobs().length,
      policyDecisions: deps.policyLogs.getAll().length
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
        const messages = parseMessages(body.params?.messages);
        const started = deps.runtime.startTurn({ session, messages });
        pendingRuns.set(started.runId, {
          promise: started.promise
            .then((resolved) => {
              pendingRuns.set(started.runId, {
                promise: started.promise,
                result: resolved
              });
              return resolved;
            })
            .catch((error: unknown) => {
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
          throw new Error(`runId not found: ${runId}`);
        }
        if (pending.result) {
          result = pending.result;
        } else if (pending.error) {
          throw new Error(pending.error);
        } else {
          const resolved = await pending.promise;
          result = resolved;
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
        result = {
          delivered: true,
          channelId: String(body.params?.channelId ?? "unknown"),
          text: String(body.params?.text ?? "")
        };
      } else {
        throw new Error(`unknown method: ${body.method}`);
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send(errorResponse(body.id, auditId, "TOOL_POLICY_BLOCKED", message));
    }
  });

  return app;
}

function parseSessionContext(value: unknown): SessionContext {
  const session = value as Partial<SessionContext>;
  if (!session?.sessionId || !session.channelId || !session.channelKind) {
    throw new Error("invalid session context");
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

function parseMessages(value: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(value)) {
    throw new Error("messages must be array");
  }
  return value.map((entry) => {
    const item = entry as { role?: unknown; content?: unknown };
    return {
      role: String(item.role ?? "user"),
      content: String(item.content ?? "")
    };
  });
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
