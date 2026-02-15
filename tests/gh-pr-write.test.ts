import { describe, expect, it } from "vitest";

import type { ExecSandbox } from "../src/exec/types.js";
import {
  AlwaysAllowApprovalGate,
  AlwaysDenyApprovalGate,
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
});
