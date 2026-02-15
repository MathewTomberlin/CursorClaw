import { describe, expect, it } from "vitest";

import type { ExecSandbox } from "../src/exec/types.js";
import {
  AlwaysAllowApprovalGate,
  AlwaysDenyApprovalGate,
  createGhPrWriteRateLimiter,
  createGhPrWriteTool
} from "../src/tools.js";

function mockSandbox(capture: { command: string; args: string[]; cwd?: string }): ExecSandbox {
  return {
    run: async (command: string, args: string[], options) => {
      capture.command = command;
      capture.args = args;
      if (options.cwd !== undefined) capture.cwd = options.cwd;
      return { stdout: "mock stdout", stderr: "", code: 0 };
    }
  };
}

function mockSandboxWithCode(stderr: string, code: number): ExecSandbox {
  return {
    run: async () => ({ stdout: "", stderr, code })
  };
}

describe("gh_pr_write tool", () => {
  it("calls gh pr comment with number and body and uses workspace cwd", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/workspace",
      sandbox: mockSandbox(capture)
    });
    const result = await tool.execute({ action: "comment", number: 5, body: "LGTM" });
    expect(capture.command).toBe("gh");
    expect(capture.args).toEqual(["pr", "comment", "5", "--body", "LGTM"]);
    expect(capture.cwd).toBe("/workspace");
    expect(result).toEqual({ stdout: "mock stdout", stderr: "" });
  });

  it("adds --repo when repoScope is set for comment", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      repoScope: "owner/repo",
      sandbox: mockSandbox(capture)
    });
    await tool.execute({ action: "comment", number: 1, body: "Hi" });
    expect(capture.args).toEqual(["pr", "comment", "--repo", "owner/repo", "1", "--body", "Hi"]);
  });

  it("calls gh pr create with title and optional body", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture)
    });
    await tool.execute({ action: "create", title: "Add feature", body: "Description here" });
    expect(capture.args).toEqual(["pr", "create", "--title", "Add feature", "--body", "Description here"]);
  });

  it("create without body only sends title", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture)
    });
    await tool.execute({ action: "create", title: "WIP" });
    expect(capture.args).toEqual(["pr", "create", "--title", "WIP"]);
  });

  it("create with base and head", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture)
    });
    await tool.execute({
      action: "create",
      title: "Fix bug",
      base: "main",
      head: "feature/fix"
    });
    expect(capture.args).toContain("--base");
    expect(capture.args).toContain("main");
    expect(capture.args).toContain("--head");
    expect(capture.args).toContain("feature/fix");
  });

  it("throws when action comment has no number", async () => {
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox({ command: "", args: [] })
    });
    await expect(tool.execute({ action: "comment", body: "x" })).rejects.toThrow(
      "for action comment provide number"
    );
  });

  it("throws when action comment has empty body", async () => {
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox({ command: "", args: [] })
    });
    await expect(tool.execute({ action: "comment", number: 1, body: "   " })).rejects.toThrow(
      "body must be non-empty"
    );
  });

  it("throws when action create has empty title", async () => {
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox({ command: "", args: [] })
    });
    await expect(tool.execute({ action: "create", title: "  " })).rejects.toThrow(
      "title must be non-empty"
    );
  });

  it("throws when action is invalid", async () => {
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox({ command: "", args: [] })
    });
    await expect(tool.execute({ action: "merge" })).rejects.toThrow(
      "action must be comment or create"
    );
  });

  it("throws when approval is denied", async () => {
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysDenyApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox({ command: "", args: [] })
    });
    await expect(tool.execute({ action: "comment", number: 1, body: "x" })).rejects.toThrow(
      "gh_pr_write requires approval"
    );
  });

  it("rejects body exceeding length limit", async () => {
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox({ command: "", args: [] })
    });
    const longBody = "x".repeat(33 * 1024); // over 32 KiB
    await expect(tool.execute({ action: "comment", number: 1, body: longBody })).rejects.toThrow(
      "exceeds"
    );
  });

  it("has expected schema and name", () => {
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w"
    });
    expect(tool.name).toBe("gh_pr_write");
    expect(tool.riskLevel).toBe("high");
    const schema = tool.schema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toContain("action");
    expect(schema.properties?.action).toEqual({
      type: "string",
      enum: ["comment", "create"]
    });
  });

  it("throws when rate limiter per-run limit is reached", async () => {
    const limiter = createGhPrWriteRateLimiter({ maxWritesPerRun: 1 })!;
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox({ command: "", args: [] }),
      rateLimiter: limiter
    });
    await tool.execute({ action: "comment", number: 1, body: "first" });
    await expect(tool.execute({ action: "comment", number: 2, body: "second" })).rejects.toThrow(
      "gh_pr_write rate limit exceeded"
    );
    expect(() => limiter.checkLimit()).toThrow("max 1 per run");
  });

  it("allows writes when under per-run limit", async () => {
    const limiter = createGhPrWriteRateLimiter({ maxWritesPerRun: 3 })!;
    const capture = { command: "" as string, args: [] as string[] };
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture),
      rateLimiter: limiter
    });
    await tool.execute({ action: "comment", number: 1, body: "a" });
    await tool.execute({ action: "comment", number: 2, body: "b" });
    await tool.execute({ action: "comment", number: 3, body: "c" });
    expect(capture.args).toEqual(["pr", "comment", "3", "--body", "c"]);
    await expect(tool.execute({ action: "comment", number: 4, body: "d" })).rejects.toThrow(
      "rate limit exceeded"
    );
  });

  it("throws clear error when gh returns 403 rate limit", async () => {
    const tool = createGhPrWriteTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandboxWithCode("API rate limit exceeded (403)", 1)
    });
    await expect(tool.execute({ action: "comment", number: 1, body: "x" })).rejects.toThrow(
      "rate limit"
    );
    await expect(tool.execute({ action: "comment", number: 1, body: "x" })).rejects.toThrow("403");
  });
});

describe("createGhPrWriteRateLimiter", () => {
  it("returns null when no options", () => {
    expect(createGhPrWriteRateLimiter({})).toBeNull();
  });

  it("per-run: allows up to max then throws", () => {
    const limiter = createGhPrWriteRateLimiter({ maxWritesPerRun: 2 })!;
    limiter.checkLimit();
    limiter.recordSuccess();
    limiter.checkLimit();
    limiter.recordSuccess();
    expect(() => limiter.checkLimit()).toThrow("gh_pr_write rate limit exceeded");
    expect(() => limiter.checkLimit()).toThrow("max 2 per run");
  });

  it("per-minute: allows up to max within window", () => {
    const limiter = createGhPrWriteRateLimiter({ maxWritesPerMinute: 2 })!;
    limiter.checkLimit();
    limiter.recordSuccess();
    limiter.checkLimit();
    limiter.recordSuccess();
    expect(() => limiter.checkLimit()).toThrow("max 2 per minute");
  });
});
