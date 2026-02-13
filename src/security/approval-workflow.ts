import { randomUUID } from "node:crypto";

import {
  type Capability,
  type CapabilityApprovalInput,
  type CapabilityGrant,
  type CapabilityStore,
  requiredCapabilitiesForApproval
} from "./capabilities.js";

export type ApprovalRequestStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRequest {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ApprovalRequestStatus;
  tool: string;
  intent: CapabilityApprovalInput["intent"];
  plan: string;
  args: unknown;
  requiredCapabilities: Capability[];
  grants?: CapabilityGrant[];
  deniedReason?: string;
}

export interface ApprovalWorkflowOptions {
  capabilityStore: CapabilityStore;
  defaultGrantTtlMs: number;
  defaultGrantUses: number;
}

export class ApprovalWorkflow {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly requestsByFingerprint = new Map<string, string>();

  constructor(private readonly options: ApprovalWorkflowOptions) {}

  request(input: CapabilityApprovalInput): ApprovalRequest {
    this.expireStaleRequests();
    const requiredCapabilities = requiredCapabilitiesForApproval(input);
    const fingerprint = stableFingerprint(input.tool, input.intent, input.plan, requiredCapabilities);
    const existingId = this.requestsByFingerprint.get(fingerprint);
    if (existingId) {
      const existing = this.requests.get(existingId);
      if (existing && existing.status === "pending") {
        return { ...existing };
      }
    }
    const now = new Date().toISOString();
    const request: ApprovalRequest = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      tool: input.tool,
      intent: input.intent,
      plan: input.plan,
      args: sanitizeArgs(input.args),
      requiredCapabilities
    };
    this.requests.set(request.id, request);
    this.requestsByFingerprint.set(fingerprint, request.id);
    return { ...request };
  }

  listRequests(args?: {
    status?: ApprovalRequestStatus;
  }): ApprovalRequest[] {
    this.expireStaleRequests();
    const all = [...this.requests.values()].sort((lhs, rhs) => lhs.createdAt.localeCompare(rhs.createdAt));
    if (!args?.status) {
      return all.map(cloneRequest);
    }
    return all.filter((request) => request.status === args.status).map(cloneRequest);
  }

  resolve(args: {
    requestId: string;
    decision: "approve" | "deny";
    reason?: string;
    grantTtlMs?: number;
    grantUses?: number;
  }): ApprovalRequest {
    this.expireStaleRequests();
    const request = this.requests.get(args.requestId);
    if (!request) {
      throw new Error(`approval request not found: ${args.requestId}`);
    }
    if (request.status !== "pending") {
      return cloneRequest(request);
    }
    const now = new Date().toISOString();
    request.updatedAt = now;
    if (args.decision === "deny") {
      request.status = "denied";
      request.deniedReason = args.reason ?? "denied";
      return cloneRequest(request);
    }
    const ttlMs = args.grantTtlMs ?? this.options.defaultGrantTtlMs;
    const uses = args.grantUses ?? this.options.defaultGrantUses;
    const grants: CapabilityGrant[] = [];
    const scope = requestScopeKey(request);
    for (const capability of request.requiredCapabilities) {
      grants.push(
        this.options.capabilityStore.grant({
          capability,
          scope,
          ttlMs,
          uses
        })
      );
    }
    request.status = "approved";
    request.grants = grants;
    return cloneRequest(request);
  }

  private expireStaleRequests(now = Date.now()): void {
    for (const request of this.requests.values()) {
      if (request.status !== "pending") {
        continue;
      }
      const ageMs = now - Date.parse(request.createdAt);
      // Pending approval requests are stale after 24 hours.
      if (ageMs > 24 * 60 * 60_000) {
        request.status = "expired";
        request.updatedAt = new Date(now).toISOString();
      }
    }
  }
}

function sanitizeArgs(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 400) {
      return `${value.slice(0, 400)}…`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map(sanitizeArgs);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 20)) {
      out[key] = sanitizeArgs(entry);
    }
    return out;
  }
  return value;
}

function stableFingerprint(
  tool: string,
  intent: CapabilityApprovalInput["intent"],
  plan: string,
  requiredCapabilities: Capability[]
): string {
  return `${tool}|${intent}|${plan}|${requiredCapabilities.sort().join(",")}`;
}

function requestScopeKey(request: ApprovalRequest): string {
  return `${request.tool}:${request.intent}`;
}

function cloneRequest(request: ApprovalRequest): ApprovalRequest {
  return {
    ...request,
    requiredCapabilities: [...request.requiredCapabilities],
    ...(request.grants !== undefined
      ? {
          grants: request.grants.map((grant) => ({ ...grant }))
        }
      : {})
  };
}
