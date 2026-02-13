import { randomUUID } from "node:crypto";

import type { ExecIntent } from "../tools.js";

export type Capability =
  | "tool.high-risk"
  | "net.fetch"
  | "fs.write"
  | "process.exec"
  | "process.exec.mutate"
  | "process.exec.privileged";

export interface CapabilityGrant {
  id: string;
  capability: Capability;
  issuedAt: string;
  expiresAt: string;
  usesRemaining: number;
}

export interface CapabilityApprovalInput {
  tool: string;
  intent: ExecIntent | "high-risk-tool";
  plan: string;
  args: unknown;
}

export class CapabilityStore {
  private readonly grants = new Map<Capability, CapabilityGrant[]>();

  grant(args: {
    capability: Capability;
    ttlMs: number;
    uses?: number;
  }): CapabilityGrant {
    const now = Date.now();
    const grant: CapabilityGrant = {
      id: randomUUID(),
      capability: args.capability,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + args.ttlMs).toISOString(),
      usesRemaining: Math.max(1, args.uses ?? 1)
    };
    const existing = this.grants.get(args.capability) ?? [];
    existing.push(grant);
    this.grants.set(args.capability, existing);
    return grant;
  }

  listActive(now = Date.now()): CapabilityGrant[] {
    this.pruneExpired(now);
    return [...this.grants.values()].flatMap((entries) => entries.map((entry) => ({ ...entry })));
  }

  consumeRequired(capabilities: Capability[], now = Date.now()): boolean {
    this.pruneExpired(now);
    const required = [...new Set(capabilities)];
    if (required.length === 0) {
      return true;
    }
    for (const capability of required) {
      const entries = this.grants.get(capability) ?? [];
      const hasConsumable = entries.some((entry) => entry.usesRemaining > 0);
      if (!hasConsumable) {
        return false;
      }
    }
    for (const capability of required) {
      this.consumeOne(capability);
    }
    return true;
  }

  private consumeOne(capability: Capability): void {
    const entries = this.grants.get(capability) ?? [];
    for (const entry of entries) {
      if (entry.usesRemaining <= 0) {
        continue;
      }
      entry.usesRemaining -= 1;
      break;
    }
    this.grants.set(
      capability,
      entries.filter((entry) => entry.usesRemaining > 0)
    );
  }

  private pruneExpired(now: number): void {
    for (const [capability, entries] of this.grants.entries()) {
      const filtered = entries.filter((entry) => Date.parse(entry.expiresAt) > now && entry.usesRemaining > 0);
      this.grants.set(capability, filtered);
    }
  }
}

export function requiredCapabilitiesForApproval(input: CapabilityApprovalInput): Capability[] {
  if (input.intent === "high-risk-tool") {
    if (input.tool === "exec") {
      return ["process.exec"];
    }
    return ["tool.high-risk"];
  }
  if (input.tool === "web_fetch") {
    return ["net.fetch"];
  }
  if (input.tool !== "exec") {
    return [];
  }
  if (input.intent === "read-only") {
    return [];
  }
  if (input.intent === "network-impacting") {
    return ["process.exec", "net.fetch"];
  }
  if (input.intent === "mutating") {
    return ["process.exec", "fs.write", "process.exec.mutate"];
  }
  return ["process.exec", "process.exec.privileged"];
}
