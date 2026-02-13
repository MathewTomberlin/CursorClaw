import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Ajv } from "ajv";

import { enforceSafeFetchUrl, wrapUntrustedContent } from "./security.js";
import type {
  DecisionReasonCode,
  PolicyDecisionLog,
  ToolCall,
  ToolDefinition
} from "./types.js";

const execFileAsync = promisify(execFile);
const WEB_FETCH_MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export type ExecIntent = "read-only" | "mutating" | "network-impacting" | "privilege-impacting";

export function classifyCommandIntent(command: string): ExecIntent {
  const normalized = command.trim().toLowerCase();
  if (/\b(sudo|chmod|chown|mount|passwd|useradd)\b/.test(normalized)) {
    return "privilege-impacting";
  }
  if (/\b(curl|wget|scp|ssh|nc|nmap)\b/.test(normalized)) {
    return "network-impacting";
  }
  if (/\b(rm|mv|cp|sed\s+-i|truncate|tee)\b/.test(normalized)) {
    return "mutating";
  }
  return "read-only";
}

export function isDestructiveCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return (
    /\brm\s+-rf\b/.test(normalized) ||
    /\bdd\s+if=/.test(normalized) ||
    /\bmkfs\b/.test(normalized) ||
    />\s*\/dev\//.test(normalized)
  );
}

export interface ApprovalGate {
  approve(args: {
    tool: string;
    intent: ExecIntent | "high-risk-tool";
    plan: string;
    args: unknown;
  }): Promise<boolean>;
}

export class AlwaysDenyApprovalGate implements ApprovalGate {
  async approve(): Promise<boolean> {
    return false;
  }
}

export class AlwaysAllowApprovalGate implements ApprovalGate {
  async approve(): Promise<boolean> {
    return true;
  }
}

export interface ToolExecutionContext {
  auditId: string;
  decisionLogs: PolicyDecisionLog[];
}

export interface ToolRouterOptions {
  approvalGate: ApprovalGate;
  allowedExecBins: string[];
}

export class ToolRouter {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(private readonly options: ToolRouterOptions) {}

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<unknown> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      this.logDecision(context, "deny", "TOOL_UNKNOWN", `unknown tool: ${call.name}`);
      throw new Error(`unknown tool: ${call.name}`);
    }
    const validate = this.ajv.compile(tool.schema);
    if (!validate(call.args)) {
      this.logDecision(context, "deny", "TOOL_SCHEMA_INVALID", JSON.stringify(validate.errors));
      throw new Error(`invalid tool args for ${call.name}`);
    }

    if (tool.riskLevel === "high") {
      const approved = await this.options.approvalGate.approve({
        tool: call.name,
        intent: "high-risk-tool",
        plan: "High-risk tool invocation proposed by model",
        args: call.args
      });
      if (!approved) {
        this.logDecision(context, "deny", "TOOL_APPROVAL_REQUIRED", "high-risk tool denied");
        throw new Error("tool execution denied by approval gate");
      }
    }

    try {
      const result = await tool.execute(call.args);
      this.logDecision(context, "allow", "ALLOWED", `allow:${call.name}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logDecision(context, "deny", "TOOL_EXEC_DENIED", `deny:${call.name}:${message}`);
      throw error;
    }
  }

  private logDecision(
    context: ToolExecutionContext,
    decision: "allow" | "deny",
    reasonCode: DecisionReasonCode,
    detail: string
  ): void {
    context.decisionLogs.push({
      at: new Date().toISOString(),
      auditId: context.auditId,
      tool: "tool-router",
      decision,
      reasonCode,
      detail
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
}): ToolDefinition {
  return {
    name: "exec",
    description: "Execute a command with strict policy controls",
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
    execute: async (rawArgs: unknown) => {
      const parsed = rawArgs as ExecToolArgs;
      const intent = classifyCommandIntent(parsed.command);
      if (isDestructiveCommand(parsed.command)) {
        throw new Error("destructive command denied by default policy");
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
          args: parsed
        });
        if (!approved) {
          throw new Error(`bin "${bin}" denied by allowlist policy`);
        }
      }
      if (intent !== "read-only") {
        const approved = await args.approvalGate.approve({
          tool: "exec",
          intent,
          plan: `non-read command intent: ${intent}`,
          args: parsed
        });
        if (!approved) {
          throw new Error(`command intent "${intent}" requires approval`);
        }
      }
      const { stdout, stderr } = await execFileAsync(bin, binArgs, {
        cwd: parsed.cwd,
        shell: false,
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 64 * 1024
      });
      return {
        stdout,
        stderr
      };
    }
  };
}

export interface WebFetchArgs {
  url: string;
}

export function createWebFetchTool(): ToolDefinition {
  return {
    name: "web_fetch",
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
    execute: async (rawArgs: unknown) => {
      const args = rawArgs as WebFetchArgs;
      const signal = AbortSignal.timeout(10_000);
      let currentUrl = await enforceSafeFetchUrl(args.url);
      for (let redirectCount = 0; redirectCount <= WEB_FETCH_MAX_REDIRECTS; redirectCount += 1) {
        const response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal
        });
        if (!REDIRECT_STATUS_CODES.has(response.status)) {
          const text = await response.text();
          return {
            status: response.status,
            body: wrapUntrustedContent(text.slice(0, 20_000))
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
          redirectedUrl = new URL(location, currentUrl);
        } catch {
          throw new Error("redirect response contained invalid location");
        }
        currentUrl = await enforceSafeFetchUrl(redirectedUrl);
      }
      throw new Error("web_fetch did not reach a terminal response");
    }
  };
}
