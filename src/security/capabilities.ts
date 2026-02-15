import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  scope: string;
  issuedAt: string;
  expiresAt: string;
  usesRemaining: number;
}

export type Provenance = "system" | "operator" | "untrusted";

export interface CapabilityApprovalInput {
  tool: string;
  intent: ExecIntent | "high-risk-tool";
  plan: string;
  args: unknown;
  provenance?: Provenance;
}

const CAPABILITY_GRANTS_FILE = "capability-grants.json";

export interface CapabilityStoreOptions {
  /** When set, grants are loaded from and saved to this directory (per-profile persistence). */
  stateDir?: string;
}

export class CapabilityStore {
  private readonly grants = new Map<Capability, CapabilityGrant[]>();
  private readonly stateDir: string | undefined;

  constructor(options: CapabilityStoreOptions = {}) {
    this.stateDir = options.stateDir;
  }

  /** Load persisted grants from stateDir. No-op if stateDir not set or file missing. */
  async load(): Promise<void> {
    if (!this.stateDir) {
      return;
    }
    const path = join(this.stateDir, CAPABILITY_GRANTS_FILE);
    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw) as { grants: CapabilityGrant[] };
      if (Array.isArray(data.grants)) {
        for (const grant of data.grants) {
          if (grant.capability && typeof grant.usesRemaining === "number") {
            const existing = this.grants.get(grant.capability as Capability) ?? [];
            existing.push({
              id: grant.id,
              capability: grant.capability as Capability,
              scope: grant.scope,
              issuedAt: grant.issuedAt,
              expiresAt: grant.expiresAt,
              usesRemaining: grant.usesRemaining
            });
            this.grants.set(grant.capability as Capability, existing);
          }
        }
      }
    } catch {
      // No file or invalid: start fresh.
    }
  }

  private persist(): void {
    if (!this.stateDir) {
      return;
    }
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const grants = this.listActive();
      writeFileSync(
        join(this.stateDir, CAPABILITY_GRANTS_FILE),
        JSON.stringify({ grants }, null, 0),
        "utf-8"
      );
    } catch {
      // Best-effort; do not throw into grant/consume paths.
    }
  }

  grant(args: {
    capability: Capability;
    scope: string;
    ttlMs: number;
    uses?: number;
  }): CapabilityGrant {
    const now = Date.now();
    const grant: CapabilityGrant = {
      id: randomUUID(),
      capability: args.capability,
      scope: args.scope,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + args.ttlMs).toISOString(),
      usesRemaining: Math.max(1, args.uses ?? 1)
    };
    const existing = this.grants.get(args.capability) ?? [];
    existing.push(grant);
    this.grants.set(args.capability, existing);
    this.persist();
    return grant;
  }

  listActive(now = Date.now()): CapabilityGrant[] {
    this.pruneExpired(now);
    return [...this.grants.values()].flatMap((entries) => entries.map((entry) => ({ ...entry })));
  }

  consumeRequired(capabilities: Capability[], scope: string, now = Date.now()): boolean {
    this.pruneExpired(now);
    const required = [...new Set(capabilities)];
    if (required.length === 0) {
      return true;
    }
    for (const capability of required) {
      const entries = this.grants.get(capability) ?? [];
      const hasConsumable = entries.some((entry) => entry.scope === scope && entry.usesRemaining > 0);
      if (!hasConsumable) {
        return false;
      }
    }
    for (const capability of required) {
      this.consumeOne(capability, scope);
    }
    return true;
  }

  private consumeOne(capability: Capability, scope: string): void {
    const entries = this.grants.get(capability) ?? [];
    for (const entry of entries) {
      if (entry.scope !== scope || entry.usesRemaining <= 0) {
        continue;
      }
      entry.usesRemaining -= 1;
      break;
    }
    this.grants.set(
      capability,
      entries.filter((entry) => entry.usesRemaining > 0)
    );
    this.persist();
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
  if (input.tool === "web_fetch" || input.tool === "mcp_web_fetch") {
    return ["net.fetch"];
  }
  if (input.tool === "web_search" || input.tool === "mcp_web_search") {
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
