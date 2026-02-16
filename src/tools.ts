import { appendFile, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { platform } from "node:os";

import { Ajv, type ValidateFunction } from "ajv";

import type { ExecSandbox } from "./exec/types.js";
import { HostExecSandbox } from "./exec/host-sandbox.js";
import type { DecisionJournal } from "./decision-journal.js";
import { McpRegistry } from "./mcp.js";
import { isDestructiveCommand } from "./security/destructive-denylist.js";
import { ApprovalWorkflow } from "./security/approval-workflow.js";
import {
  CapabilityStore,
  type Capability,
  requiredCapabilitiesForApproval
} from "./security/capabilities.js";
import { fetchWithPinnedDns } from "./network/ssrf-pin.js";
import { redactSecrets, resolveSafeFetchTarget, wrapUntrustedContent } from "./security.js";
import type { MemoryStore } from "./memory.js";
import type {
  DecisionReasonCode,
  PolicyDecisionLog,
  ToolCall,
  ToolDefinition,
  ToolExecuteContext
} from "./types.js";
import type { SensitivityLabel } from "./types.js";
import type { SubstrateContent } from "./substrate/types.js";

/** Return true if resolvedPath is under profileRoot (so agent can only touch its own profile files). */
function pathUnderProfileRoot(resolvedPath: string, profileRoot: string): boolean {
  const a = resolve(resolvedPath);
  const b = resolve(profileRoot);
  const prefix = b.endsWith(sep) ? b : b + sep;
  return a === b || (a.startsWith(prefix));
}

const WEB_FETCH_MAX_REDIRECTS = 5;
const WEB_FETCH_MAX_BODY_BYTES = 20_000;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPE_PATTERN =
  /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml))/i;

export type ExecIntent = "read-only" | "mutating" | "network-impacting" | "privilege-impacting";

/** Shell metacharacters that must not be used as path arguments (e.g. ls -R | yields path "|"). */
const SHELL_META = new Set(["|", "&", ";", ">", ">>", "<", "&&", "||"]);

/**
 * Parse sed -i 's/pattern/replacement/[g]' file (or double-quoted) from a command string. Returns null if not matched.
 * Handles the common in-place substitute form; delimiter must be / and pattern/replacement must not contain /.
 */
function parseSedInPlace(command: string): { pattern: string; replacement: string; global: boolean; filePath: string } | null {
  const m = command.match(/sed\s+-i\s+['"]s\/([^/]*)\/([^/]*)\/(g?)['"]\s+(\S+)/);
  if (!m || m[1] === undefined || m[2] === undefined || m[4] === undefined) return null;
  return { pattern: m[1], replacement: m[2], global: m[3] === "g", filePath: m[4] };
}

/**
 * Parse sed -i '/pattern/c\replacement' file (change command). Returns null if not matched.
 */
function parseSedInPlaceChange(command: string): { pattern: string; replacement: string; filePath: string } | null {
  const m = command.match(/sed\s+-i\s+['"]\/([^/]*)\/c\\([^'"]*)['"]\s+(\S+)/);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return { pattern: m[1], replacement: m[2], filePath: m[3] };
}

/**
 * Parse sed -i '/pattern/d' file (delete lines matching pattern). Returns null if not matched.
 */
function parseSedInPlaceDelete(command: string): { pattern: string; filePath: string } | null {
  const m = command.match(/sed\s+-i\s+['"]\/([^/]*)\/d['"]\s+(\S+)/);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { pattern: m[1], filePath: m[2] };
}

/**
 * Parse sed -i '/pattern/a\line' file or sed -i '/pattern/a line' file (append after matching line). Returns null if not matched.
 */
function parseSedInPlaceAppend(command: string): { pattern: string; line: string; filePath: string } | null {
  const m = command.match(/sed\s+-i\s+['"]\/([^/]*)\/a\s*(?:\\([^'"]*)|([^'"]*))['"]\s+(\S+)/);
  if (!m || m[1] === undefined || m[4] === undefined) return null;
  const lineRaw = (m[2] ?? m[3] ?? "") as string;
  const line = lineRaw.replace(/\\n/g, "\n").trim();
  return { pattern: m[1], line, filePath: m[4] };
}

/**
 * Parse echo ... > file or echo ... >> file from (bin, binArgs). Returns { content, filePath, append } or null.
 * Content is joined from args before ">" or ">>"; optional surrounding quotes are stripped.
 */
function parseEchoRedirect(bin: string, binArgs: string[]): { content: string; filePath: string; append?: boolean } | null {
  if (bin !== "echo" || binArgs.length < 2) return null;
  const idxRedirect = binArgs.findIndex((a) => a === ">" || a === ">>");
  if (idxRedirect === -1 || idxRedirect === binArgs.length - 1) return null;
  const content = binArgs.slice(0, idxRedirect).join(" ").replace(/^\s*['"]|['"]\s*$/g, "").trim();
  const filePath = binArgs[idxRedirect + 1];
  if (!filePath) return null;
  return { content, filePath, append: binArgs[idxRedirect] === ">>" };
}

export function classifyCommandIntent(command: string): ExecIntent {
  const normalized = command.trim().toLowerCase();
  if (/\b(sudo|chmod|chown|mount|passwd|useradd)\b/.test(normalized)) {
    return "privilege-impacting";
  }
  if (/\b(curl|wget|scp|ssh|nc|nmap)\b/.test(normalized)) {
    return "network-impacting";
  }
  if (/\b(rm|mv|cp|sed\s+-i|truncate|tee|mkdir|touch)\b/.test(normalized)) {
    return "mutating";
  }
  if (/>/.test(normalized)) {
    return "mutating";
  }
  return "read-only";
}

export { isDestructiveCommand } from "./security/destructive-denylist.js";
export type { ExecSandbox } from "./exec/types.js";

export interface ApprovalGate {
  approve(args: {
    tool: string;
    intent: ExecIntent | "high-risk-tool";
    plan: string;
    args: unknown;
    provenance?: Provenance;
  }): Promise<boolean>;
  getLastDenial?(): {
    reason: string;
    requestId?: string;
    requiredCapabilities?: Capability[];
  } | null;
  supportsDestructiveApproval?(): boolean;
}

export interface PolicyApprovalGateOptions {
  devMode: boolean;
  allowHighRiskTools: boolean;
  allowExecIntents: ExecIntent[];
}

export class AlwaysDenyApprovalGate implements ApprovalGate {
  async approve(): Promise<boolean> {
    return false;
  }

  getLastDenial(): { reason: string } {
    return { reason: "always-deny policy gate" };
  }
}

export class AlwaysAllowApprovalGate implements ApprovalGate {
  async approve(): Promise<boolean> {
    return true;
  }

  getLastDenial(): null {
    return null;
  }

  supportsDestructiveApproval(): boolean {
    return false;
  }
}

export class PolicyApprovalGate implements ApprovalGate {
  private lastDenial: {
    reason: string;
    requestId?: string;
    requiredCapabilities?: Capability[];
  } | null = null;

  constructor(private readonly options: PolicyApprovalGateOptions) {}

  async approve(args: {
    tool: string;
    intent: ExecIntent | "high-risk-tool";
    plan: string;
    args: unknown;
  }): Promise<boolean> {
    void args.plan;
    void args.args;
    if (this.options.devMode) {
      this.lastDenial = null;
      return true;
    }
    if (args.intent === "high-risk-tool") {
      const allow = this.options.allowHighRiskTools;
      this.lastDenial = allow ? null : { reason: "high-risk tool policy blocked" };
      return allow;
    }
    const allow = this.options.allowExecIntents.includes(args.intent);
    this.lastDenial = allow ? null : { reason: `intent blocked: ${args.intent}` };
    return allow;
  }

  getLastDenial(): {
    reason: string;
    requestId?: string;
    requiredCapabilities?: Capability[];
  } | null {
    return this.lastDenial;
  }

  supportsDestructiveApproval(): boolean {
    return false;
  }
}

export interface CapabilityApprovalGateOptions {
  devMode: boolean;
  approvalWorkflow: ApprovalWorkflow;
  capabilityStore: CapabilityStore;
  allowReadOnlyWithoutGrant?: boolean;
  /** When true, mutating exec (sed, tee, etc.) is approved without requiring a capability grant. Set from config for trusted/local setups. */
  allowMutatingWithoutGrant?: boolean;
  /** When true, web_search and web_fetch (net.fetch) are approved without requiring a capability grant. Set from config for trusted/local setups. */
  allowNetFetchWithoutGrant?: boolean;
}

export class CapabilityApprovalGate implements ApprovalGate {
  private lastDenial: {
    reason: string;
    requestId?: string;
    requiredCapabilities?: Capability[];
  } | null = null;

  constructor(private readonly options: CapabilityApprovalGateOptions) {}

  async approve(args: {
    tool: string;
    intent: ExecIntent | "high-risk-tool";
    plan: string;
    args: unknown;
    provenance?: Provenance;
  }): Promise<boolean> {
    if (this.options.devMode) {
      this.lastDenial = null;
      return true;
    }
    if ((this.options.allowReadOnlyWithoutGrant ?? true) && args.intent === "read-only") {
      this.lastDenial = null;
      return true;
    }
    if (this.options.allowMutatingWithoutGrant === true && args.intent === "mutating" && args.tool === "exec") {
      this.lastDenial = null;
      return true;
    }
    const requiredCapabilities = requiredCapabilitiesForApproval(args);
    if (
      this.options.allowNetFetchWithoutGrant === true &&
      requiredCapabilities.length === 1 &&
      requiredCapabilities[0] === "net.fetch"
    ) {
      this.lastDenial = null;
      return true;
    }
    if (requiredCapabilities.length === 0) {
      this.lastDenial = null;
      return true;
    }
    const scope =
      args.provenance === "untrusted"
        ? `untrusted:${args.tool}:${args.intent}`
        : `${args.tool}:${args.intent}`;
    const allowed = this.options.capabilityStore.consumeRequired(
      requiredCapabilities,
      scope
    );
    if (allowed) {
      this.lastDenial = null;
      return true;
    }
    const request = this.options.approvalWorkflow.request({
      ...args,
      ...(args.provenance !== undefined && { provenance: args.provenance })
    });
    this.lastDenial = {
      reason: "missing capability grant",
      requestId: request.id,
      requiredCapabilities
    };
    return false;
  }

  getLastDenial(): {
    reason: string;
    requestId?: string;
    requiredCapabilities?: Capability[];
  } | null {
    return this.lastDenial;
  }

  supportsDestructiveApproval(): boolean {
    return true;
  }
}

export type Provenance = "system" | "operator" | "untrusted";

export interface ToolRouterOptions {
  approvalGate: ApprovalGate;
  allowedExecBins: string[];
  isToolIsolationEnabled?: () => boolean;
  decisionJournal?: DecisionJournal;
}

export class ToolRouter {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly validatorCache = new Map<string, ValidateFunction<unknown>>();
  private readonly decisionCount = new Map<DecisionReasonCode, number>();

  constructor(private readonly options: ToolRouterOptions) {}

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async execute(call: ToolCall, context: ToolExecuteContext): Promise<unknown> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      this.logDecision(context, "deny", "TOOL_UNKNOWN", `unknown tool: ${call.name}`);
      throw new Error(`unknown tool: ${call.name}`);
    }
    if (this.options.isToolIsolationEnabled?.() && tool.riskLevel === "high") {
      this.logDecision(context, "deny", "TOOL_POLICY_BLOCKED", "incident tool isolation mode is active");
      throw new Error("tool execution blocked by incident tool isolation mode");
    }
    const validate = this.getValidator(tool);
    if (!validate(call.args)) {
      this.logDecision(context, "deny", "TOOL_SCHEMA_INVALID", JSON.stringify(validate.errors));
      throw new Error(`invalid tool args for ${call.name}`);
    }

    if (tool.riskLevel === "high" && call.name !== "exec") {
      const approved = await this.options.approvalGate.approve({
        tool: call.name,
        intent: "high-risk-tool",
        plan: "High-risk tool invocation proposed by model",
        args: call.args,
        ...(context.provenance !== undefined && { provenance: context.provenance })
      });
      if (!approved) {
        const denial = this.options.approvalGate.getLastDenial?.();
        const detail = denial?.requestId
          ? `high-risk tool denied; requestId=${denial.requestId}`
          : "high-risk tool denied";
        this.logDecision(context, "deny", "TOOL_APPROVAL_REQUIRED", "high-risk tool denied");
        throw new Error(detail);
      }
    }

    try {
      const result = await tool.execute(call.args, context);
      this.logDecision(context, "allow", "ALLOWED", `allow:${call.name}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logDecision(context, "deny", "TOOL_EXEC_DENIED", `deny:${call.name}:${message}`);
      throw error;
    }
  }

  getDecisionMetrics(): Record<DecisionReasonCode, number> {
    return Object.fromEntries(this.decisionCount.entries()) as Record<DecisionReasonCode, number>;
  }

  private getValidator(tool: ToolDefinition): ValidateFunction<unknown> {
    const key = `${tool.name}:${JSON.stringify(tool.schema)}`;
    const cached = this.validatorCache.get(key);
    if (cached) {
      return cached;
    }
    const validator = this.ajv.compile(tool.schema);
    this.validatorCache.set(key, validator);
    return validator;
  }

  private logDecision(
    context: ToolExecuteContext,
    decision: "allow" | "deny",
    reasonCode: DecisionReasonCode,
    detail: string
  ): void {
    this.decisionCount.set(reasonCode, (this.decisionCount.get(reasonCode) ?? 0) + 1);
    context.decisionLogs.push({
      at: new Date().toISOString(),
      auditId: context.auditId,
      tool: "tool-router",
      decision,
      reasonCode,
      detail
    });
    void this.options.decisionJournal?.append({
      type: "tool-policy-decision",
      summary: `${decision.toUpperCase()} ${reasonCode}`,
      detail: redactSecrets(detail),
      metadata: {
        auditId: context.auditId
      }
    });
  }
}

export interface ExecToolArgs {
  command: string;
  cwd?: string;
}

export function createExecTool(args: {
  allowedBins: string[];
  approvalGate: ApprovalGate;
  maxBufferBytes?: number;
  maxChildProcessesPerTurn?: number;
  sandbox?: ExecSandbox;
}): ToolDefinition {
  const maxBuffer = args.maxBufferBytes ?? 64 * 1024;
  const concurrencyCap = args.maxChildProcessesPerTurn ?? 100;
  const sandbox: ExecSandbox =
    args.sandbox ?? new HostExecSandbox();
  let concurrentExecs = 0;

  return {
    name: "exec",
    description:
      "Run a shell command. Use this to read files (e.g. cat, type, head), edit files (sed, echo, tee), run scripts, run tests, and execute any allowed binary. This is the primary way to read or modify substrate files (AGENTS.md, IDENTITY.md, ROADMAP.md, TOOLS.md) and the codebase. When editing an existing file (e.g. IDENTITY.md, SOUL.md): always read the file first with cat/type, then use sed to change only the specific line or section (e.g. sed -i 's/old exact text/new text/' FILE or sed -i '/pattern/c\\replacement' FILE). Do not overwrite the entire file with echo ... > FILE unless the user explicitly asked to replace the whole file. Policy controls apply (e.g. read-only vs mutating).",
    schema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        cwd: { type: "string" }
      },
      required: ["command"],
      additionalProperties: false
    },
    riskLevel: "high",
    execute: async (rawArgs: unknown, ctx?: ToolExecuteContext) => {
      if (concurrentExecs >= concurrencyCap) {
        throw new Error(`max concurrent execs reached (${concurrencyCap})`);
      }
      concurrentExecs += 1;
      try {
        const parsed = rawArgs as ExecToolArgs;
        const intent = classifyCommandIntent(parsed.command);
        const provenance = ctx?.provenance;
        if (isDestructiveCommand(parsed.command)) {
          if (!(args.approvalGate.supportsDestructiveApproval?.() ?? false)) {
            throw new Error("destructive command denied by default policy");
          }
          const approved = await args.approvalGate.approve({
            tool: "exec",
            intent: "privilege-impacting",
            plan: "destructive command signature matched",
            args: parsed,
            ...(provenance !== undefined && { provenance })
          });
          if (!approved) {
            const denial = args.approvalGate.getLastDenial?.();
            const suffix = denial?.requestId ? ` (requestId=${denial.requestId})` : "";
            throw new Error(`destructive command requires explicit approval${suffix}`);
          }
        }

        const [bin, ...binArgs] = parsed.command.split(/\s+/).filter(Boolean);
        if (!bin) {
          throw new Error("empty command");
        }
        if (!args.allowedBins.includes(bin)) {
          const approved = await args.approvalGate.approve({
            tool: "exec",
            intent,
            plan: `bin "${bin}" not in allowlist`,
            args: parsed,
            ...(provenance !== undefined && { provenance })
          });
          if (!approved) {
            const denial = args.approvalGate.getLastDenial?.();
            const suffix = denial?.requestId ? ` (requestId=${denial.requestId})` : "";
            throw new Error(`bin "${bin}" denied by allowlist policy${suffix}`);
          }
        }
        if (intent !== "read-only") {
          const approved = await args.approvalGate.approve({
            tool: "exec",
            intent,
            plan: `non-read command intent: ${intent}`,
            args: parsed,
            ...(provenance !== undefined && { provenance })
          });
          if (!approved) {
            const denial = args.approvalGate.getLastDenial?.();
            const suffix = denial?.requestId ? ` (requestId=${denial.requestId})` : "";
            throw new Error(`command intent "${intent}" requires approval${suffix}`);
          }
        }
        // Use current agent profile root so substrate/memory/heartbeat are profile-isolated. When profileRoot is set, cwd must stay under it.
        const profileRoot = ctx?.profileRoot;
        let cwd: string;
        if (profileRoot) {
          const base = resolve(profileRoot);
          const requestedCwd =
            parsed.cwd !== undefined && parsed.cwd !== "" ? resolve(base, parsed.cwd) : base;
          if (!pathUnderProfileRoot(requestedCwd, base)) {
            throw new Error("exec cwd must be under the current agent profile root");
          }
          cwd = requestedCwd;
        } else {
          cwd =
            parsed.cwd !== undefined && parsed.cwd !== ""
              ? parsed.cwd
              : process.cwd();
        }
        const ensureUnderProfile = (pathResolved: string): void => {
          if (profileRoot && !pathUnderProfileRoot(pathResolved, profileRoot)) {
            throw new Error("path must be under the current agent profile root (only this profile's substrate, memory, and files are allowed)");
          }
        };
        // On Windows, compound commands (cmd1 && cmd2) are run as separate segments so sed/echo run in Node instead of spawning missing binaries.
        if (platform() === "win32" && parsed.command.includes(" && ")) {
          const segments = parsed.command.split(" && ").map((s) => s.trim()).filter(Boolean);
          let lastResult: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
          for (const seg of segments) {
            const [segBin, ...segBinArgs] = seg.split(/\s+/).filter(Boolean);
            if (!segBin) continue;
            if (!args.allowedBins.includes(segBin)) {
              throw new Error(`bin "${segBin}" not in allowlist`);
            }
            const segIntent = classifyCommandIntent(seg);
            if (segBin === "cat" || segBin === "type") {
              if (segBinArgs.length > 0 && segIntent === "read-only") {
                const fileArgs = segBinArgs.filter((a) => !SHELL_META.has(a) && a !== "");
                const chunks: string[] = [];
                for (const fileArg of fileArgs) {
                  const pathResolved = resolve(cwd, fileArg);
                  ensureUnderProfile(pathResolved);
                  const content = await readFile(pathResolved, "utf8");
                  chunks.push(content);
                }
                lastResult = { stdout: chunks.join(""), stderr: "" };
                continue;
              }
            }
            if (segBin === "sed" && segIntent === "mutating") {
              const sedSub = parseSedInPlace(seg);
              if (sedSub) {
                const pathResolved = resolve(cwd, sedSub.filePath);
                ensureUnderProfile(pathResolved);
                const content = await readFile(pathResolved, "utf8");
                const regex = new RegExp(sedSub.pattern, sedSub.global ? "g" : "");
                await writeFile(pathResolved, content.replace(regex, sedSub.replacement));
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
              const sedChange = parseSedInPlaceChange(seg);
              if (sedChange) {
                const pathResolved = resolve(cwd, sedChange.filePath);
                ensureUnderProfile(pathResolved);
                const content = await readFile(pathResolved, "utf8");
                const regex = new RegExp(sedChange.pattern);
                const newContent = content
                  .split(/\r?\n/)
                  .map((line) => (regex.test(line) ? sedChange.replacement : line))
                  .join("\n");
                await writeFile(pathResolved, newContent);
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
              const sedDelete = parseSedInPlaceDelete(seg);
              if (sedDelete) {
                const pathResolved = resolve(cwd, sedDelete.filePath);
                ensureUnderProfile(pathResolved);
                const content = await readFile(pathResolved, "utf8");
                const regex = new RegExp(sedDelete.pattern);
                const newContent = content.split(/\r?\n/).filter((line) => !regex.test(line)).join("\n");
                await writeFile(pathResolved, newContent);
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
              const sedAppend = parseSedInPlaceAppend(seg);
              if (sedAppend) {
                const pathResolved = resolve(cwd, sedAppend.filePath);
                ensureUnderProfile(pathResolved);
                const content = await readFile(pathResolved, "utf8");
                const regex = new RegExp(sedAppend.pattern);
                const newLines = content.split(/\r?\n/).flatMap((ln) =>
                  regex.test(ln) ? [ln, sedAppend.line] : [ln]
                );
                await writeFile(pathResolved, newLines.join("\n"));
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
            }
            if (segBin === "echo" && segIntent === "mutating") {
              const echo = parseEchoRedirect(segBin, segBinArgs);
              if (echo) {
                const pathResolved = resolve(cwd, echo.filePath);
                ensureUnderProfile(pathResolved);
                if (echo.append) {
                  const existing = await readFile(pathResolved, "utf8").catch(() => "");
                  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
                  await writeFile(pathResolved, existing + sep + echo.content);
                } else {
                  await writeFile(pathResolved, echo.content);
                }
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
            }
            if (segBin === "rm" && segIntent === "mutating") {
              const recursive = segBinArgs.some((a) => a === "-r" || a === "-rf" || a === "-fr" || a === "-R");
              const paths = segBinArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              if (paths.length > 0) {
                for (const p of paths) {
                  const pathResolved = resolve(cwd, p);
                  ensureUnderProfile(pathResolved);
                  const s = await stat(pathResolved).catch(() => null);
                  if (s?.isDirectory()) {
                    await rm(pathResolved, { recursive: true });
                  } else {
                    await unlink(pathResolved);
                  }
                }
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
            }
            if (segBin === "pwd" && segIntent === "read-only") {
              lastResult = { stdout: cwd + "\n", stderr: "" };
              continue;
            }
            if ((segBin === "ls" || segBin === "dir") && segIntent === "read-only") {
              const paths = segBinArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              const dirPath = paths.length > 0 ? resolve(cwd, paths[0]!) : cwd;
              ensureUnderProfile(dirPath);
              const long = segBinArgs.some((a) => a === "-l" || a === "-la" || a === "-al");
              const entries = await readdir(dirPath, { withFileTypes: true });
              const names = entries.map((e) => e.name);
              if (long) {
                const lines = await Promise.all(
                  entries.map(async (e) => {
                    const p = resolve(dirPath, e.name);
                    const s = await stat(p).catch(() => null);
                    const size = s?.isFile() ? (s.size ?? 0) : 0;
                    const mtime = s?.mtime ? s.mtime.toISOString().slice(0, 16).replace("T", " ") : "";
                    const type = e.isDirectory() ? "d" : "-";
                    return `${type}rw-r--r-- 1 1 ${String(size).padStart(8)} ${mtime} ${e.name}`;
                  })
                );
                lastResult = { stdout: lines.join("\n") + "\n", stderr: "" };
              } else {
                lastResult = { stdout: names.join("\n") + (names.length ? "\n" : ""), stderr: "" };
              }
              continue;
            }
            if (segBin === "head" && segIntent === "read-only" && segBinArgs.length > 0) {
              let n = 10;
              const nonFlags = segBinArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              const idxN = segBinArgs.findIndex((a) => a === "-n");
              const nArg = idxN !== -1 ? segBinArgs[idxN + 1] : undefined;
              if (nArg !== undefined) n = parseInt(nArg, 10) || 10;
              else {
                const dashN = segBinArgs.find((a) => /^-(\d+)$/.test(a));
                if (dashN) n = parseInt(dashN.slice(1), 10) || 10;
              }
              const filePath = nonFlags[nonFlags.length - 1] ?? nonFlags[0];
              if (filePath) {
                const pathResolved = resolve(cwd, filePath);
                ensureUnderProfile(pathResolved);
                const content = await readFile(pathResolved, "utf8");
                const lines = content.split(/\r?\n/);
                lastResult = { stdout: lines.slice(0, n).join("\n") + (lines.length ? "\n" : ""), stderr: "" };
              }
              continue;
            }
            if (segBin === "tail" && segIntent === "read-only" && segBinArgs.length > 0) {
              let n = 10;
              const nonFlags = segBinArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              const idxN = segBinArgs.findIndex((a) => a === "-n");
              const nArg = idxN !== -1 ? segBinArgs[idxN + 1] : undefined;
              if (nArg !== undefined) n = parseInt(nArg, 10) || 10;
              else {
                const dashN = segBinArgs.find((a) => /^-(\d+)$/.test(a));
                if (dashN) n = parseInt(dashN.slice(1), 10) || 10;
              }
              const filePath = nonFlags[nonFlags.length - 1] ?? nonFlags[0];
              if (filePath) {
                const pathResolved = resolve(cwd, filePath);
                ensureUnderProfile(pathResolved);
                const content = await readFile(pathResolved, "utf8");
                const lines = content.split(/\r?\n/);
                lastResult = { stdout: lines.slice(-n).join("\n") + (lines.length ? "\n" : ""), stderr: "" };
              }
              continue;
            }
            if (segBin === "grep" && segIntent === "read-only" && segBinArgs.length >= 2) {
              const withNum = segBinArgs.includes("-n");
              const ignoreCase = segBinArgs.includes("-i");
              const nonFlags = segBinArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              const pattern = nonFlags[0];
              const files = nonFlags.slice(1);
              if (pattern && files.length > 0) {
                const regex = new RegExp(pattern, ignoreCase ? "i" : "");
                const out: string[] = [];
                for (const f of files) {
                  const pathResolved = resolve(cwd, f);
                  ensureUnderProfile(pathResolved);
                  const content = await readFile(pathResolved, "utf8").catch(() => "");
                  const lines = content.split(/\r?\n/);
                  lines.forEach((line, i) => {
                    if (regex.test(line)) out.push(withNum ? `${i + 1}:${line}` : line);
                  });
                }
                lastResult = { stdout: out.join("\n") + (out.length ? "\n" : ""), stderr: "" };
              }
              continue;
            }
            if (segBin === "wc" && segIntent === "read-only" && segBinArgs.length > 0) {
              const flags = { lines: segBinArgs.includes("-l"), words: segBinArgs.includes("-w"), bytes: segBinArgs.includes("-c") };
              const files = segBinArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              if (files.length > 0) {
                const out: string[] = [];
                let totalL = 0, totalW = 0, totalC = 0;
                for (const f of files) {
                  const pathResolved = resolve(cwd, f);
                  ensureUnderProfile(pathResolved);
                  const content = await readFile(pathResolved, "utf8").catch(() => "");
                  const lines = content.split(/\r?\n/);
                  const l = lines.length;
                  const w = content.split(/\s+/).filter(Boolean).length;
                  const c = Buffer.byteLength(content, "utf8");
                  totalL += l; totalW += w; totalC += c;
                  const parts: string[] = [];
                  if (flags.lines && !flags.words && !flags.bytes) parts.push(String(l));
                  else if (flags.words && !flags.lines && !flags.bytes) parts.push(String(w));
                  else if (flags.bytes && !flags.lines && !flags.words) parts.push(String(c));
                  else parts.push(String(l), String(w), String(c));
                  out.push(parts.map((p) => p.padStart(8)).join("") + " " + f);
                }
                if (files.length > 1) {
                  const parts = flags.lines && !flags.words && !flags.bytes ? [String(totalL)] : flags.words && !flags.lines && !flags.bytes ? [String(totalW)] : flags.bytes && !flags.lines && !flags.words ? [String(totalC)] : [String(totalL), String(totalW), String(totalC)];
                  out.push(parts.map((p) => p.padStart(8)).join("") + " total");
                }
                lastResult = { stdout: out.join("\n") + "\n", stderr: "" };
              }
              continue;
            }
            if (segBin === "tee" && segIntent === "mutating" && segBinArgs.length > 0) {
              const append = segBinArgs.includes("-a");
              const paths = segBinArgs.filter((a) => a !== "-a" && !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              if (paths.length > 0) {
                for (const p of paths) {
                  const pathResolved = resolve(cwd, p);
                  ensureUnderProfile(pathResolved);
                  if (append) await appendFile(pathResolved, "");
                  else await writeFile(pathResolved, "");
                }
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
            }
            if (segBin === "mv" && segIntent === "mutating" && segBinArgs.length >= 2) {
              const paths = segBinArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              if (paths.length >= 2) {
                const src = resolve(cwd, paths[0]!);
                const dest = resolve(cwd, paths[1]!);
                ensureUnderProfile(src);
                ensureUnderProfile(dest);
                await rename(src, dest);
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
            }
            if (segBin === "cp" && segIntent === "mutating" && segBinArgs.length >= 2) {
              const paths = segBinArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              if (paths.length >= 2) {
                const src = resolve(cwd, paths[0]!);
                const dest = resolve(cwd, paths[1]!);
                ensureUnderProfile(src);
                ensureUnderProfile(dest);
                const s = await stat(src).catch(() => null);
                if (s?.isDirectory()) await cp(src, dest, { recursive: true });
                else await copyFile(src, dest);
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
            }
            if (segBin === "mkdir" && segIntent === "mutating" && segBinArgs.length > 0) {
              const paths = segBinArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              if (paths.length > 0) {
                for (const p of paths) {
                  const pathResolved = resolve(cwd, p);
                  ensureUnderProfile(pathResolved);
                  await mkdir(pathResolved, { recursive: true });
                }
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
            }
            if (segBin === "touch" && segIntent === "mutating" && segBinArgs.length > 0) {
              const paths = segBinArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
              if (paths.length > 0) {
                for (const p of paths) {
                  const pathResolved = resolve(cwd, p);
                  ensureUnderProfile(pathResolved);
                  const exists = await stat(pathResolved).catch(() => null);
                  if (exists) await utimes(pathResolved, exists.mtime, new Date());
                  else await writeFile(pathResolved, "");
                }
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
            }
            if (segBin === "test" && segIntent === "read-only" && segBinArgs.length >= 2) {
              const flag = segBinArgs[0];
              const pathArg = segBinArgs[1];
              if (pathArg && !SHELL_META.has(pathArg) && (flag === "-f" || flag === "-d" || flag === "-e" || flag === "-s")) {
                const pathResolved = resolve(cwd, pathArg);
                ensureUnderProfile(pathResolved);
                const s = await stat(pathResolved).catch(() => null);
                const ok =
                  flag === "-f" ? (s?.isFile() ?? false) :
                  flag === "-d" ? (s?.isDirectory() ?? false) :
                  flag === "-e" ? (s != null) :
                  flag === "-s" ? (s != null && (s.size ?? 0) > 0) : false;
                if (!ok) throw new Error("test: condition false");
                lastResult = { stdout: "", stderr: "" };
                continue;
              }
            }
            if (profileRoot) {
              for (const arg of segBinArgs) {
                const pathResolved = resolve(cwd, arg);
                ensureUnderProfile(pathResolved);
              }
            }
            lastResult = await sandbox.run(segBin, segBinArgs, {
              cwd,
              maxBufferBytes: maxBuffer,
              timeoutMs: 15_000
            });
          }
          return { stdout: lastResult.stdout, stderr: lastResult.stderr };
        }
        if (platform() === "win32" && (bin === "cat" || bin === "type") && binArgs.length > 0 && intent === "read-only") {
          const fileArgs = binArgs.filter((a) => !SHELL_META.has(a) && a !== "");
          const chunks: string[] = [];
          for (const fileArg of fileArgs) {
            const pathResolved = resolve(cwd, fileArg);
            ensureUnderProfile(pathResolved);
            const content = await readFile(pathResolved, "utf8");
            chunks.push(content);
          }
          const result = { stdout: chunks.join(""), stderr: "", code: 0 as const };
          return { stdout: result.stdout, stderr: result.stderr };
        }
        if (platform() === "win32" && bin === "sed" && intent === "mutating") {
          const sedSub = parseSedInPlace(parsed.command);
          if (sedSub) {
            const pathResolved = resolve(cwd, sedSub.filePath);
            ensureUnderProfile(pathResolved);
            const content = await readFile(pathResolved, "utf8");
            const regex = new RegExp(sedSub.pattern, sedSub.global ? "g" : "");
            const newContent = content.replace(regex, sedSub.replacement);
            await writeFile(pathResolved, newContent);
            return { stdout: "", stderr: "" };
          }
          const sedChange = parseSedInPlaceChange(parsed.command);
          if (sedChange) {
            const pathResolved = resolve(cwd, sedChange.filePath);
            ensureUnderProfile(pathResolved);
            const content = await readFile(pathResolved, "utf8");
            const regex = new RegExp(sedChange.pattern);
            const newContent = content
              .split(/\r?\n/)
              .map((line) => (regex.test(line) ? sedChange.replacement : line))
              .join("\n");
            await writeFile(pathResolved, newContent);
            return { stdout: "", stderr: "" };
          }
          const sedDelete = parseSedInPlaceDelete(parsed.command);
          if (sedDelete) {
            const pathResolved = resolve(cwd, sedDelete.filePath);
            ensureUnderProfile(pathResolved);
            const content = await readFile(pathResolved, "utf8");
            const regex = new RegExp(sedDelete.pattern);
            const newContent = content
              .split(/\r?\n/)
              .filter((line) => !regex.test(line))
              .join("\n");
            await writeFile(pathResolved, newContent);
            return { stdout: "", stderr: "" };
          }
          const sedAppend = parseSedInPlaceAppend(parsed.command);
          if (sedAppend) {
            const pathResolved = resolve(cwd, sedAppend.filePath);
            ensureUnderProfile(pathResolved);
            const content = await readFile(pathResolved, "utf8");
            const regex = new RegExp(sedAppend.pattern);
            const newLines = content.split(/\r?\n/).flatMap((ln) =>
              regex.test(ln) ? [ln, sedAppend.line] : [ln]
            );
            await writeFile(pathResolved, newLines.join("\n"));
            return { stdout: "", stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "echo" && intent === "mutating") {
          const echo = parseEchoRedirect(bin, binArgs);
          if (echo) {
            const pathResolved = resolve(cwd, echo.filePath);
            ensureUnderProfile(pathResolved);
            if (echo.append) {
              const existing = await readFile(pathResolved, "utf8").catch(() => "");
              const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
              await writeFile(pathResolved, existing + sep + echo.content);
            } else {
              await writeFile(pathResolved, echo.content);
            }
            return { stdout: "", stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "rm" && intent === "mutating") {
          const recursive = binArgs.some((a) => a === "-r" || a === "-rf" || a === "-fr" || a === "-R");
          const paths = binArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          if (paths.length > 0) {
            for (const p of paths) {
              const pathResolved = resolve(cwd, p);
              ensureUnderProfile(pathResolved);
              const s = await stat(pathResolved).catch(() => null);
              if (s?.isDirectory()) {
                await rm(pathResolved, { recursive: true });
              } else {
                await unlink(pathResolved);
              }
            }
            return { stdout: "", stderr: "" };
          }
        }
        if (platform() === "win32" && (bin === "pwd") && intent === "read-only") {
          return { stdout: cwd + "\n", stderr: "" };
        }
        if (platform() === "win32" && (bin === "ls" || bin === "dir") && intent === "read-only") {
          const paths = binArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          const dirPath = paths.length > 0 ? resolve(cwd, paths[0]!) : cwd;
          ensureUnderProfile(dirPath);
          const long = binArgs.some((a) => a === "-l" || a === "-la" || a === "-al");
          const entries = await readdir(dirPath, { withFileTypes: true });
          const names = entries.map((e) => e.name);
          if (long) {
            const lines = await Promise.all(
              entries.map(async (e) => {
                const p = resolve(dirPath, e.name);
                const s = await stat(p).catch(() => null);
                const size = s?.isFile() ? (s.size ?? 0) : 0;
                const mtime = s?.mtime ? s.mtime.toISOString().slice(0, 16).replace("T", " ") : "";
                const type = e.isDirectory() ? "d" : "-";
                return `${type}rw-r--r-- 1 1 ${String(size).padStart(8)} ${mtime} ${e.name}`;
              })
            );
            return { stdout: lines.join("\n") + "\n", stderr: "" };
          }
          return { stdout: names.join("\n") + (names.length ? "\n" : ""), stderr: "" };
        }
        if (platform() === "win32" && bin === "head" && intent === "read-only" && binArgs.length > 0) {
          let n = 10;
          const nonFlags = binArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          const idxN = binArgs.findIndex((a) => a === "-n");
          const nArg = idxN !== -1 ? binArgs[idxN + 1] : undefined;
          if (nArg !== undefined) n = parseInt(nArg, 10) || 10;
          else {
            const dashN = binArgs.find((a) => /^-(\d+)$/.test(a));
            if (dashN) n = parseInt(dashN.slice(1), 10) || 10;
          }
          const filePath = nonFlags[nonFlags.length - 1] ?? nonFlags[0];
          if (filePath) {
            const pathResolved = resolve(cwd, filePath);
            ensureUnderProfile(pathResolved);
            const content = await readFile(pathResolved, "utf8");
            const lines = content.split(/\r?\n/);
            return { stdout: lines.slice(0, n).join("\n") + (lines.length ? "\n" : ""), stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "tail" && intent === "read-only" && binArgs.length > 0) {
          let n = 10;
          const nonFlags = binArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          const idxN = binArgs.findIndex((a) => a === "-n");
          const nArg = idxN !== -1 ? binArgs[idxN + 1] : undefined;
          if (nArg !== undefined) n = parseInt(nArg, 10) || 10;
          else {
            const dashN = binArgs.find((a) => /^-(\d+)$/.test(a));
            if (dashN) n = parseInt(dashN.slice(1), 10) || 10;
          }
          const filePath = nonFlags[nonFlags.length - 1] ?? nonFlags[0];
          if (filePath) {
            const pathResolved = resolve(cwd, filePath);
            ensureUnderProfile(pathResolved);
            const content = await readFile(pathResolved, "utf8");
            const lines = content.split(/\r?\n/);
            return { stdout: lines.slice(-n).join("\n") + (lines.length ? "\n" : ""), stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "grep" && intent === "read-only" && binArgs.length >= 2) {
          const withNum = binArgs.includes("-n");
          const ignoreCase = binArgs.includes("-i");
          const nonFlags = binArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          const pattern = nonFlags[0];
          const files = nonFlags.slice(1);
          if (pattern && files.length > 0) {
            const regex = new RegExp(pattern, ignoreCase ? "i" : "");
            const out: string[] = [];
            for (const f of files) {
              const pathResolved = resolve(cwd, f);
              ensureUnderProfile(pathResolved);
              const content = await readFile(pathResolved, "utf8").catch(() => "");
              const lines = content.split(/\r?\n/);
              lines.forEach((line, i) => {
                if (regex.test(line)) out.push(withNum ? `${i + 1}:${line}` : line);
              });
            }
            return { stdout: out.join("\n") + (out.length ? "\n" : ""), stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "wc" && intent === "read-only" && binArgs.length > 0) {
          const flags = { lines: binArgs.includes("-l"), words: binArgs.includes("-w"), bytes: binArgs.includes("-c") };
          const files = binArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          if (files.length > 0) {
            const out: string[] = [];
            let totalL = 0, totalW = 0, totalC = 0;
            for (const f of files) {
              const pathResolved = resolve(cwd, f);
              ensureUnderProfile(pathResolved);
              const content = await readFile(pathResolved, "utf8").catch(() => "");
              const lines = content.split(/\r?\n/);
              const l = lines.length;
              const w = content.split(/\s+/).filter(Boolean).length;
              const c = Buffer.byteLength(content, "utf8");
              totalL += l; totalW += w; totalC += c;
              const parts: string[] = flags.lines && !flags.words && !flags.bytes ? [String(l)] : flags.words && !flags.lines && !flags.bytes ? [String(w)] : flags.bytes && !flags.lines && !flags.words ? [String(c)] : [String(l), String(w), String(c)];
              out.push(parts.map((p) => p.padStart(8)).join("") + " " + f);
            }
            if (files.length > 1) {
              const parts = flags.lines && !flags.words && !flags.bytes ? [String(totalL)] : flags.words && !flags.lines && !flags.bytes ? [String(totalW)] : flags.bytes && !flags.lines && !flags.words ? [String(totalC)] : [String(totalL), String(totalW), String(totalC)];
              out.push(parts.map((p) => p.padStart(8)).join("") + " total");
            }
            return { stdout: out.join("\n") + "\n", stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "tee" && intent === "mutating" && binArgs.length > 0) {
          const append = binArgs.includes("-a");
          const paths = binArgs.filter((a) => a !== "-a" && !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          if (paths.length > 0) {
            for (const p of paths) {
              const pathResolved = resolve(cwd, p);
              ensureUnderProfile(pathResolved);
              if (append) await appendFile(pathResolved, "");
              else await writeFile(pathResolved, "");
            }
            return { stdout: "", stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "mv" && intent === "mutating" && binArgs.length >= 2) {
          const paths = binArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          if (paths.length >= 2) {
            const src = resolve(cwd, paths[0]!);
            const dest = resolve(cwd, paths[1]!);
            ensureUnderProfile(src);
            ensureUnderProfile(dest);
            await rename(src, dest);
            return { stdout: "", stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "cp" && intent === "mutating" && binArgs.length >= 2) {
          const paths = binArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          if (paths.length >= 2) {
            const src = resolve(cwd, paths[0]!);
            const dest = resolve(cwd, paths[1]!);
            ensureUnderProfile(src);
            ensureUnderProfile(dest);
            const s = await stat(src).catch(() => null);
            if (s?.isDirectory()) await cp(src, dest, { recursive: true });
            else await copyFile(src, dest);
            return { stdout: "", stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "mkdir" && intent === "mutating" && binArgs.length > 0) {
          const paths = binArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          if (paths.length > 0) {
            for (const p of paths) {
              const pathResolved = resolve(cwd, p);
              ensureUnderProfile(pathResolved);
              await mkdir(pathResolved, { recursive: true });
            }
            return { stdout: "", stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "touch" && intent === "mutating" && binArgs.length > 0) {
          const paths = binArgs.filter((a) => !a.startsWith("-") && !SHELL_META.has(a) && a !== "");
          if (paths.length > 0) {
            for (const p of paths) {
              const pathResolved = resolve(cwd, p);
              ensureUnderProfile(pathResolved);
              const exists = await stat(pathResolved).catch(() => null);
              if (exists) await utimes(pathResolved, exists.mtime, new Date());
              else await writeFile(pathResolved, "");
            }
            return { stdout: "", stderr: "" };
          }
        }
        if (platform() === "win32" && bin === "test" && intent === "read-only" && binArgs.length >= 2) {
          const flag = binArgs[0];
          const pathArg = binArgs[1];
          if (pathArg && !SHELL_META.has(pathArg) && (flag === "-f" || flag === "-d" || flag === "-e" || flag === "-s")) {
            const pathResolved = resolve(cwd, pathArg);
            ensureUnderProfile(pathResolved);
            const s = await stat(pathResolved).catch(() => null);
            const ok =
              flag === "-f" ? (s?.isFile() ?? false) :
              flag === "-d" ? (s?.isDirectory() ?? false) :
              flag === "-e" ? (s != null) :
              flag === "-s" ? (s != null && (s.size ?? 0) > 0) : false;
            if (!ok) throw new Error("test: condition false");
            return { stdout: "", stderr: "" };
          }
        }
        if (profileRoot) {
          for (const arg of binArgs) {
            const pathResolved = resolve(cwd, arg);
            ensureUnderProfile(pathResolved);
          }
        }
        const result = await sandbox.run(bin, binArgs, {
          cwd,
          maxBufferBytes: maxBuffer,
          timeoutMs: 15_000
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr
        };
      } finally {
        concurrentExecs -= 1;
      }
    }
  };
}

/** Read-only GitHub PR tool: gh pr list and gh pr view. Auth via host `gh auth` or GH_TOKEN in env; no token in args. */
export function createGhPrReadTool(args: {
  approvalGate: ApprovalGate;
  workspaceCwd: string;
  repoScope?: string;
  sandbox?: ExecSandbox;
  maxBufferBytes?: number;
}): ToolDefinition {
  const sandbox: ExecSandbox = args.sandbox ?? new HostExecSandbox();
  const maxBuffer = args.maxBufferBytes ?? 64 * 1024;
  const repoFlag = args.repoScope ? ["--repo", args.repoScope] : [];

  return {
    name: "gh_pr_read",
    description:
      "Read pull request information via GitHub CLI. List open PRs or view a single PR by number or branch. Uses host-configured auth (gh auth login or GH_TOKEN in env). Only pr list and pr view are allowed.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "view"] },
        number: { type: "number", description: "PR number (for action view)" },
        branch: { type: "string", description: "Branch name (for action view, alternative to number)" },
        state: { type: "string", enum: ["open", "closed", "all"], description: "For list: filter by state (default open)" },
        limit: { type: "number", description: "For list: max number of PRs to return (e.g. 30)" }
      },
      required: ["action"],
      additionalProperties: false
    },
    riskLevel: "low",
    execute: async (rawArgs: unknown, ctx?: ToolExecuteContext) => {
      const parsed = rawArgs as { action: string; number?: number; branch?: string; state?: string; limit?: number };
      if (parsed.action !== "list" && parsed.action !== "view") {
        throw new Error("gh_pr_read: action must be list or view");
      }
      let ghArgs: string[];
      if (parsed.action === "list") {
        ghArgs = ["pr", "list", ...repoFlag];
        if (parsed.state) ghArgs.push("--state", parsed.state);
        if (parsed.limit != null && Number.isInteger(parsed.limit) && parsed.limit > 0) {
          ghArgs.push("--limit", String(Math.min(parsed.limit, 100)));
        }
      } else {
        if (parsed.number != null && Number.isInteger(parsed.number)) {
          ghArgs = ["pr", "view", ...repoFlag, String(parsed.number)];
        } else if (parsed.branch && typeof parsed.branch === "string" && /^[\w./-]+$/.test(parsed.branch)) {
          ghArgs = ["pr", "view", ...repoFlag, parsed.branch];
        } else {
          throw new Error("gh_pr_read: for action view provide number or branch");
        }
      }
      const approved = await args.approvalGate.approve({
        tool: "gh_pr_read",
        intent: "network-impacting",
        plan: "read-only GitHub PR (list or view)",
        args: parsed,
        ...(ctx?.provenance !== undefined && { provenance: ctx.provenance })
      });
      if (!approved) {
        const denial = args.approvalGate.getLastDenial?.();
        const suffix = denial?.requestId ? ` (requestId=${denial.requestId})` : "";
        throw new Error(`gh_pr_read requires approval${suffix}`);
      }
      const result = await sandbox.run("gh", ghArgs, {
        cwd: args.workspaceCwd,
        maxBufferBytes: maxBuffer,
        timeoutMs: 15_000
      });
      return { stdout: result.stdout, stderr: result.stderr };
    }
  };
}

const GH_PR_WRITE_BODY_MAX_BYTES = 32 * 1024;
const GH_PR_WRITE_TITLE_MAX_CHARS = 256;
const GH_PR_WRITE_BODY_MAX_CHARS = GH_PR_WRITE_BODY_MAX_BYTES; // UTF-8 safe for ASCII

const GH_PR_WRITE_RATE_LIMIT_MSG = "gh_pr_write rate limit exceeded";

/** In-process rate limiter for gh_pr_write: optional per-minute (sliding) and per-run caps. */
export interface GhPrWriteRateLimiter {
  checkLimit(): void;
  recordSuccess(): void;
}

export function createGhPrWriteRateLimiter(options: {
  maxWritesPerMinute?: number;
  maxWritesPerRun?: number;
}): GhPrWriteRateLimiter | null {
  const { maxWritesPerMinute, maxWritesPerRun } = options;
  if (maxWritesPerMinute == null && maxWritesPerRun == null) return null;
  const windowMs = 60_000;
  const minuteTimestamps: number[] = [];
  let runCount = 0;
  return {
    checkLimit(): void {
      const now = Date.now();
      if (maxWritesPerMinute != null) {
        const since = now - windowMs;
        const recent = minuteTimestamps.filter((t) => t > since);
        if (recent.length >= maxWritesPerMinute) {
          throw new Error(
            `${GH_PR_WRITE_RATE_LIMIT_MSG} (max ${maxWritesPerMinute} per minute); try again later`
          );
        }
      }
      if (maxWritesPerRun != null && runCount >= maxWritesPerRun) {
        throw new Error(
          `${GH_PR_WRITE_RATE_LIMIT_MSG} (max ${maxWritesPerRun} per run); limit resets when process restarts`
        );
      }
    },
    recordSuccess(): void {
      const now = Date.now();
      if (maxWritesPerMinute != null) {
        minuteTimestamps.push(now);
        const since = now - windowMs;
        while (minuteTimestamps.length > 0 && (minuteTimestamps[0] ?? 0) <= since) {
          minuteTimestamps.shift();
        }
      }
      if (maxWritesPerRun != null) runCount += 1;
    }
  };
}

function sanitizeGhPrWriteString(s: string, maxChars: number, field: string): string {
  const noControl = s.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (noControl.length === 0) {
    throw new Error(`gh_pr_write: ${field} must be non-empty after trimming`);
  }
  if (noControl.length > maxChars) {
    throw new Error(`gh_pr_write: ${field} exceeds ${maxChars} characters`);
  }
  return noControl;
}

/** Parses Retry-After (seconds) from gh stderr if present. Returns undefined if not found. */
function parseRetryAfterSeconds(stderr: string): number | undefined {
  const m = stderr.match(/retry[- ]after[:\s]+(\d+)/i);
  const sec = m?.[1];
  if (sec == null) return undefined;
  return Math.min(300, Math.max(1, Number.parseInt(sec, 10)));
}

/** GitHub PR write tool: comment on PR and create PR. Auth via host `gh auth` or GH_TOKEN in env; no token in args. Requires mutating approval. */
export function createGhPrWriteTool(args: {
  approvalGate: ApprovalGate;
  workspaceCwd: string;
  repoScope?: string;
  sandbox?: ExecSandbox;
  maxBufferBytes?: number;
  rateLimiter?: GhPrWriteRateLimiter | null;
  /** When true, on 403 rate-limit response retry once after suggested delay (or 60s). Default false. */
  respectRetryAfter?: boolean;
}): ToolDefinition {
  const sandbox: ExecSandbox = args.sandbox ?? new HostExecSandbox();
  const maxBuffer = args.maxBufferBytes ?? 64 * 1024;
  const repoFlag = args.repoScope ? ["--repo", args.repoScope] : [];
  const rateLimiter = args.rateLimiter ?? null;
  const respectRetryAfter = args.respectRetryAfter === true;

  return {
    name: "gh_pr_write",
    description:
      "Write to pull requests via GitHub CLI: post a comment on an existing PR or create a new PR. Uses host-configured auth (gh auth login or GH_TOKEN in env). Requires approval (mutating capability). Only comment and create are allowed; no merge.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["comment", "create"] },
        number: { type: "number", description: "PR number (for action comment)" },
        body: { type: "string", description: "Comment or PR body (for comment required; for create optional)" },
        title: { type: "string", description: "PR title (for action create)" },
        base: { type: "string", description: "Base branch for new PR (optional)" },
        head: { type: "string", description: "Head branch for new PR (optional; default current branch)" }
      },
      required: ["action"],
      additionalProperties: false
    },
    riskLevel: "high",
    execute: async (rawArgs: unknown, ctx?: ToolExecuteContext) => {
      const parsed = rawArgs as {
        action: string;
        number?: number;
        body?: string;
        title?: string;
        base?: string;
        head?: string;
      };
      if (parsed.action !== "comment" && parsed.action !== "create") {
        throw new Error("gh_pr_write: action must be comment or create");
      }
      let plan: string;
      let ghArgs: string[];
      if (parsed.action === "comment") {
        if (parsed.number == null || !Number.isInteger(parsed.number)) {
          throw new Error("gh_pr_write: for action comment provide number (PR number)");
        }
        const body =
          typeof parsed.body === "string"
            ? sanitizeGhPrWriteString(parsed.body, GH_PR_WRITE_BODY_MAX_CHARS, "body")
            : "";
        if (!body) {
          throw new Error("gh_pr_write: for action comment body is required and non-empty");
        }
        plan = `comment on PR #${parsed.number}`;
        ghArgs = ["pr", "comment", ...repoFlag, String(parsed.number), "--body", body];
      } else {
        const title =
          typeof parsed.title === "string"
            ? sanitizeGhPrWriteString(parsed.title, GH_PR_WRITE_TITLE_MAX_CHARS, "title")
            : "";
        if (!title) {
          throw new Error("gh_pr_write: for action create title is required and non-empty");
        }
        plan = "create PR";
        ghArgs = ["pr", "create", ...repoFlag, "--title", title];
        if (typeof parsed.body === "string" && parsed.body.trim().length > 0) {
          const body = sanitizeGhPrWriteString(parsed.body.trim(), GH_PR_WRITE_BODY_MAX_CHARS, "body");
          ghArgs.push("--body", body);
        }
        if (typeof parsed.base === "string" && /^[\w./-]+$/.test(parsed.base)) {
          ghArgs.push("--base", parsed.base);
        }
        if (typeof parsed.head === "string" && /^[\w./-]+$/.test(parsed.head)) {
          ghArgs.push("--head", parsed.head);
        }
      }
      const approved = await args.approvalGate.approve({
        tool: "gh_pr_write",
        intent: "mutating",
        plan,
        args: parsed,
        ...(ctx?.provenance !== undefined && { provenance: ctx.provenance })
      });
      if (!approved) {
        const denial = args.approvalGate.getLastDenial?.();
        const suffix = denial?.requestId ? ` (requestId=${denial.requestId})` : "";
        throw new Error(`gh_pr_write requires approval${suffix}`);
      }
      rateLimiter?.checkLimit();

      const runOnce = async () => {
        return await sandbox.run("gh", ghArgs, {
          cwd: args.workspaceCwd,
          maxBufferBytes: maxBuffer,
          timeoutMs: 15_000
        });
      };

      let result = await runOnce();
      const stderr = result.stderr ?? "";
      const isRateLimit =
        result.code !== 0 &&
        (stderr.includes("403") || /rate[- ]?limit/i.test(stderr));
      if (isRateLimit && respectRetryAfter) {
        const retryAfterSec = parseRetryAfterSeconds(stderr) ?? 60;
        await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
        result = await runOnce();
      }

      const resultStderr = result.stderr ?? "";
      if (result.code !== 0 && (resultStderr.includes("403") || /rate[- ]?limit/i.test(resultStderr))) {
        const retrySec = parseRetryAfterSeconds(resultStderr);
        const hint = retrySec != null ? `; retry after ${retrySec}s` : "";
        throw new Error(
          `gh_pr_write failed: GitHub API rate limit (403)${hint}. ${resultStderr.trim() || "See stderr for details."}`
        );
      }

      if (result.code !== 0) {
        const errOut = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || "unknown";
        throw new Error(`gh_pr_write failed (exit ${result.code}): ${errOut}`);
      }

      rateLimiter?.recordSuccess();
      return { stdout: result.stdout, stderr: result.stderr };
    }
  };
}

export interface WebFetchArgs {
  url: string;
}

/** Tool name to register (e.g. "web_fetch" or "mcp_web_fetch" for Cursor-Agent CLI). */
export function createWebFetchTool(args: {
  approvalGate: ApprovalGate;
  toolName?: string;
} = {
  approvalGate: new AlwaysAllowApprovalGate()
}): ToolDefinition {
  const toolName = args.toolName ?? "web_fetch";
  return {
    name: toolName,
    description: "Fetch external web content with SSRF guard and safe wrapping",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 8 }
      },
      required: ["url"],
      additionalProperties: false
    },
    riskLevel: "low",
    execute: async (rawArgs: unknown, ctx?: ToolExecuteContext) => {
      const parsed = rawArgs as WebFetchArgs;
      const approved = await args.approvalGate.approve({
        tool: toolName,
        intent: "network-impacting",
        plan: "network fetch of external content",
        args: parsed,
        ...(ctx?.provenance !== undefined && { provenance: ctx.provenance })
      });
      if (!approved) {
        const denial = args.approvalGate.getLastDenial?.();
        const suffix = denial?.requestId ? ` (requestId=${denial.requestId})` : "";
        throw new Error(`${toolName} requires approval${suffix}`);
      }
      const signal = AbortSignal.timeout(10_000);
      const dnsPins = new Map<string, string>();
      const pinDnsTarget = (target: { url: URL; resolvedAddresses: string[] }): typeof target => {
        const host = target.url.hostname.toLowerCase();
        const resolvedKey = target.resolvedAddresses
          .map((address) => address.toLowerCase())
          .sort()
          .join(",");
        const existing = dnsPins.get(host);
        if (existing && existing !== resolvedKey) {
          throw new Error(`DNS rebinding detected for host: ${host}`);
        }
        dnsPins.set(host, resolvedKey);
        return target;
      };
      let target = pinDnsTarget(await resolveSafeFetchTarget(parsed.url));
      for (let redirectCount = 0; redirectCount <= WEB_FETCH_MAX_REDIRECTS; redirectCount += 1) {
        const pathWithQuery = target.url.pathname + target.url.search;
        const response = await fetchWithPinnedDns(target, pathWithQuery, { signal, timeoutMs: 10_000 });
        if (!REDIRECT_STATUS_CODES.has(response.status)) {
          const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
          if (contentType && !ALLOWED_CONTENT_TYPE_PATTERN.test(contentType)) {
            throw new Error(`web_fetch content type not allowed: ${contentType}`);
          }
          const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
          if (!Number.isNaN(contentLength) && contentLength > WEB_FETCH_MAX_BODY_BYTES) {
            throw new Error(`web_fetch response exceeds byte limit (${WEB_FETCH_MAX_BODY_BYTES})`);
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > WEB_FETCH_MAX_BODY_BYTES) {
            throw new Error(`web_fetch response exceeds byte limit (${WEB_FETCH_MAX_BODY_BYTES})`);
          }
          const text = new TextDecoder().decode(bytes);
          return {
            status: response.status,
            contentType: contentType || "unknown",
            body: wrapUntrustedContent(text)
          };
        }
        if (redirectCount === WEB_FETCH_MAX_REDIRECTS) {
          throw new Error("web_fetch exceeded redirect limit");
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("redirect response missing location header");
        }
        let redirectedUrl: URL;
        try {
          redirectedUrl = new URL(location, target.url);
        } catch {
          throw new Error("redirect response contained invalid location");
        }
        target = pinDnsTarget(await resolveSafeFetchTarget(redirectedUrl));
      }
      throw new Error("web_fetch did not reach a terminal response");
    }
  };
}

export interface WebSearchArgs {
  query: string;
}

const WEB_SEARCH_DUCKDUCKGO_HOST = "api.duckduckgo.com";
const WEB_SEARCH_TIMEOUT_MS = 10_000;
const WEB_SEARCH_MAX_ABSTRACT_LEN = 2_000;

export function createWebSearchTool(args: {
  approvalGate: ApprovalGate;
  toolName?: string;
} = {
  approvalGate: new AlwaysAllowApprovalGate()
}): ToolDefinition {
  const toolName = args.toolName ?? "web_search";
  return {
    name: toolName,
    description: "Search the web and return snippets/abstracts (DuckDuckGo Instant Answer API). Use for factual lookups, not full page content.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 }
      },
      required: ["query"],
      additionalProperties: false
    },
    riskLevel: "low",
    execute: async (rawArgs: unknown, ctx?: ToolExecuteContext) => {
      const parsed = rawArgs as WebSearchArgs;
      const approved = await args.approvalGate.approve({
        tool: toolName,
        intent: "network-impacting",
        plan: "web search (DuckDuckGo API)",
        args: parsed,
        ...(ctx?.provenance !== undefined && { provenance: ctx.provenance })
      });
      if (!approved) {
        const denial = args.approvalGate.getLastDenial?.();
        const suffix = denial?.requestId ? ` (requestId=${denial.requestId})` : "";
        throw new Error(`${toolName} requires approval${suffix}`);
      }
      const target = await resolveSafeFetchTarget(
        `https://${WEB_SEARCH_DUCKDUCKGO_HOST}/?q=${encodeURIComponent(parsed.query)}&format=json`
      );
      if (target.url.hostname.toLowerCase() !== WEB_SEARCH_DUCKDUCKGO_HOST) {
        throw new Error("web_search: host validation failed");
      }
      const pathWithQuery = target.url.pathname + target.url.search;
      const signal = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS);
      const response = await fetchWithPinnedDns(target, pathWithQuery, {
        signal,
        timeoutMs: WEB_SEARCH_TIMEOUT_MS
      });
      if (response.status !== 200) {
        return {
          error: `search API returned ${response.status}`,
          results: [],
          abstract: ""
        };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      type DDGResult = { Text?: string; FirstURL?: string };
      let data: {
        Abstract?: string;
        AbstractText?: string;
        RelatedTopics?: Array<{ Text?: string } | { Topics?: DDGResult[] }>;
        Results?: DDGResult[];
        Answer?: string;
        Definition?: string;
        DefinitionSource?: string;
      };
      try {
        data = JSON.parse(text) as typeof data;
      } catch {
        return { error: "search API returned invalid JSON", results: [], abstract: "" };
      }
      const abstract = (data.AbstractText ?? data.Abstract ?? "").slice(0, WEB_SEARCH_MAX_ABSTRACT_LEN);
      const relatedTopicsRaw = data.RelatedTopics ?? [];
      const relatedTexts: string[] = [];
      for (const t of relatedTopicsRaw) {
        const item = t as { Text?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> };
        if (typeof item?.Text === "string") {
          relatedTexts.push(item.Text.slice(0, 500));
        } else if (Array.isArray(item?.Topics)) {
          for (const sub of item.Topics) {
            if (typeof sub?.Text === "string") {
              relatedTexts.push((sub.FirstURL ? `${sub.Text} (${sub.FirstURL})` : sub.Text).slice(0, 500));
            }
          }
        }
      }
      const resultsArray = (data.Results ?? []).filter(
        (r): r is { Text: string; FirstURL?: string } => typeof (r as DDGResult)?.Text === "string"
      );
      const resultsFromResults = resultsArray.map((r) =>
        (r.FirstURL ? `${r.Text} (${r.FirstURL})` : r.Text).slice(0, 500)
      );
      const answer = (data.Answer ?? "").trim();
      const definition = (data.Definition ?? "").trim();
      const definitionSource = (data.DefinitionSource ?? "").trim();
      const combinedResults = [
        ...relatedTexts,
        ...resultsFromResults,
        ...(answer ? [answer] : []),
        ...(definition ? [definition + (definitionSource ? ` — ${definitionSource}` : "")] : [])
      ];
      const hasAny = abstract.length > 0 || combinedResults.length > 0;
      const hint = !hasAny
        ? "The DuckDuckGo Instant Answer API returned no data for this query. It often returns empty for general or conversational queries; it works best for specific topic names (e.g. 'NASA', 'Python programming') and factual lookups. Try a more specific or noun-focused search."
        : undefined;
      return {
        abstract: wrapUntrustedContent(abstract),
        results: combinedResults.map((r) => wrapUntrustedContent(r)),
        ...(hint !== undefined && { hint })
      };
    }
  };
}

export function createMcpListResourcesTool(args: {
  registry: McpRegistry;
}): ToolDefinition {
  return {
    name: "mcp_list_resources",
    description: "List MCP resources from configured servers",
    schema: {
      type: "object",
      properties: {
        server: { type: "string" }
      },
      additionalProperties: false
    },
    riskLevel: "low",
    execute: async (rawArgs: unknown) => {
      const server = (rawArgs as { server?: string })?.server;
      return {
        resources: await args.registry.listResources(server)
      };
    }
  };
}

export function createMcpReadResourceTool(args: {
  registry: McpRegistry;
}): ToolDefinition {
  return {
    name: "mcp_read_resource",
    description: "Read a specific MCP resource",
    schema: {
      type: "object",
      properties: {
        server: { type: "string", minLength: 1 },
        uri: { type: "string", minLength: 1 }
      },
      required: ["server", "uri"],
      additionalProperties: false
    },
    riskLevel: "low",
    execute: async (rawArgs: unknown) => {
      const parsed = rawArgs as { server: string; uri: string };
      return args.registry.readResource({
        server: parsed.server,
        uri: parsed.uri
      });
    }
  };
}

export function createMcpCallTool(args: {
  registry: McpRegistry;
  approvalGate: ApprovalGate;
}): ToolDefinition {
  return {
    name: "mcp_call_tool",
    description: "Invoke an MCP tool on a configured server",
    schema: {
      type: "object",
      properties: {
        server: { type: "string", minLength: 1 },
        tool: { type: "string", minLength: 1 },
        input: {}
      },
      required: ["server", "tool"],
      additionalProperties: false
    },
    riskLevel: "high",
    execute: async (rawArgs: unknown, ctx?: ToolExecuteContext) => {
      const parsed = rawArgs as {
        server: string;
        tool: string;
        input?: unknown;
      };
      const approved = await args.approvalGate.approve({
        tool: "mcp_call_tool",
        intent: "network-impacting",
        plan: `invoke MCP tool ${parsed.server}:${parsed.tool}`,
        args: parsed,
        ...(ctx?.provenance !== undefined && { provenance: ctx.provenance })
      });
      if (!approved) {
        const denial = args.approvalGate.getLastDenial?.();
        const suffix = denial?.requestId ? ` (requestId=${denial.requestId})` : "";
        throw new Error(`mcp_call_tool requires approval${suffix}`);
      }
      return args.registry.callTool({
        server: parsed.server,
        tool: parsed.tool,
        input: parsed.input
      });
    }
  };
}

export interface RecallMemoryResult {
  recordId: string;
  text: string;
  category: string;
  score: number;
}

/** Main-session-only tool: recall memory by semantic similarity. Requires profileRoot and channelKind in context. */
export function createRecallMemoryTool(args: {
  getRecallResults: (profileRoot: string, query: string, topK: number) => Promise<RecallMemoryResult[]>;
}): ToolDefinition {
  return {
    name: "recall_memory",
    description: "Recall relevant entries from long-term memory by semantic similarity. Use when you need to find past context (decisions, preferences, facts) without loading the full memory file. Only available in the main web session.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Natural language query (e.g. 'Operator preferences about deployments')" },
        top_k: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Max number of memory entries to return (default 5)" }
      },
      required: ["query"],
      additionalProperties: false
    },
    riskLevel: "low",
    execute: async (rawArgs: unknown, ctx?: ToolExecuteContext) => {
      const parsed = rawArgs as { query: string; top_k?: number };
      const profileRoot = ctx?.profileRoot;
      const allowedChannel =
        ctx?.channelKind === "web" ||
        ctx?.channelKind === "dm" ||
        ctx?.channelKind === "mobile" ||
        ctx?.sessionId?.startsWith?.("heartbeat:") === true;
      const canRecall = profileRoot && allowedChannel;
      if (!canRecall) {
        return { error: "recall_memory is only available in the main or heartbeat session." };
      }
      const results = await args.getRecallResults(profileRoot, parsed.query, parsed.top_k ?? 5);
      return { results };
    }
  };
}

const SENSITIVITY_LABELS: SensitivityLabel[] = ["public", "private-user", "secret", "operational"];

/** Main-session-only tool: append a "remember this" entry to long-term memory. Requires profileId (or profileRoot), channelKind, and sessionId in context. Use getMemoryStore when each agent profile has its own memory; otherwise use appendRecord. */
export function createRememberThisTool(args: {
  appendRecord?: (record: {
    sessionId: string;
    category: string;
    text: string;
    provenance: { sourceChannel: string; confidence: number; timestamp: string; sensitivity: SensitivityLabel };
  }) => Promise<{ id: string }>;
  /** When set, the tool uses this store for the run's profile so each agent gets its own MEMORY.md. Requires profileId in context. */
  getMemoryStore?: (profileId: string) => MemoryStore;
}): ToolDefinition {
  return {
    name: "remember_this",
    description:
      "Store something in long-term memory so it can be recalled later. Use when the user says 'remember this', 'remember that', or asks you to keep a fact, preference, or decision. Use category 'learned' when storing a lesson inferred from feedback or a repeated pattern. Available in the main web session and during heartbeat.",
    schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "What to remember (concise fact, preference, or decision)"
        },
        category: {
          type: "string",
          description: "Optional category (default: note). E.g. note, user-preference, decision, learned",
          default: "note"
        },
        sensitivity: {
          type: "string",
          enum: SENSITIVITY_LABELS,
          description: "Optional sensitivity (default: private-user). Use private-user for personal preferences.",
          default: "private-user"
        }
      },
      required: ["text"],
      additionalProperties: false
    },
    riskLevel: "low",
    execute: async (rawArgs: unknown, ctx?: ToolExecuteContext) => {
      const parsed = rawArgs as { text: string; category?: string; sensitivity?: string };
      const allowedChannel =
        ctx?.channelKind === "web" ||
        ctx?.channelKind === "dm" ||
        ctx?.channelKind === "mobile" ||
        ctx?.sessionId?.startsWith?.("heartbeat:") === true;
      const hasValidContext =
        (ctx?.profileRoot ?? ctx?.profileId) != null && ctx?.sessionId != null && allowedChannel;
      if (!hasValidContext) {
        return { error: "remember_this is only available in the main or heartbeat session." };
      }
      const category = (parsed.category ?? "note").trim() || "note";
      const sensitivity = SENSITIVITY_LABELS.includes((parsed.sensitivity ?? "private-user") as SensitivityLabel)
        ? (parsed.sensitivity as SensitivityLabel)
        : "private-user";
      const record = {
        sessionId: ctx!.sessionId!,
        category,
        text: parsed.text.trim(),
        provenance: {
          sourceChannel: "operator",
          confidence: 1,
          timestamp: new Date().toISOString(),
          sensitivity
        }
      };
      if (args.getMemoryStore && ctx?.profileId) {
        const store = args.getMemoryStore(ctx.profileId);
        const appended = await store.append(record);
        return { ok: true, id: appended.id };
      }
      if (args.appendRecord) {
        const { id } = await args.appendRecord(record);
        return { ok: true, id };
      }
      return { error: "remember_this is not configured with a memory store." };
    }
  };
}

const SOUL_IDENTITY_KEYS = ["soul", "identity"] as const;

/** Proposal-only tool for SOUL.md/IDENTITY.md evolution. Does not write; returns current + proposed for user to apply. */
export function createProposeSoulIdentityUpdateTool(args: {
  getSubstrateContent: (profileRoot: string) => SubstrateContent | undefined;
}): ToolDefinition {
  return {
    name: "propose_soul_identity_update",
    description:
      "Propose an update to SOUL.md or IDENTITY.md. Use when you infer a lasting change in how you want to be or how you present in this workspace. This tool does not write to disk; it returns the current content and your proposed content so the user can review and apply manually (e.g. via substrate.update in the UI). Only available in the main web session.",
    schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          enum: SOUL_IDENTITY_KEYS,
          description: "Which file: soul (SOUL.md) or identity (IDENTITY.md)"
        },
        proposed_content: {
          type: "string",
          description: "Full proposed content for the file (replaces entire file when user applies)"
        }
      },
      required: ["key", "proposed_content"],
      additionalProperties: false
    },
    riskLevel: "low",
    execute: async (rawArgs: unknown, ctx?: ToolExecuteContext) => {
      if (ctx?.channelKind !== "web" || !ctx?.profileRoot) {
        return { error: "propose_soul_identity_update is only available in the main session." };
      }
      const parsed = rawArgs as { key: string; proposed_content: string };
      const key = parsed.key?.trim();
      if (!SOUL_IDENTITY_KEYS.includes(key as (typeof SOUL_IDENTITY_KEYS)[number])) {
        return { error: "key must be 'soul' or 'identity'." };
      }
      const proposedContent = typeof parsed.proposed_content === "string" ? parsed.proposed_content.trim() : "";
      if (!proposedContent) {
        return { error: "proposed_content is required and must be non-empty." };
      }
      const content = args.getSubstrateContent(ctx.profileRoot);
      if (!content) {
        return { error: "Substrate not available for this profile." };
      }
      const currentContent = (content as Record<string, string | undefined>)[key] ?? "";
      const fileLabel = key === "soul" ? "SOUL.md" : "IDENTITY.md";
      return {
        key,
        file: fileLabel,
        current_content: currentContent,
        proposed_content: proposedContent,
        message: `Proposed update to ${fileLabel}. Review the proposed_content above; apply manually (e.g. via Settings or substrate.update) if you want to save it. No file was written.`
      };
    }
  };
}
