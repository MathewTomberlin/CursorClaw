import { describe, expect, it } from "vitest";

import type { ExecSandbox } from "../src/exec/types.js";
import {
  AlwaysAllowApprovalGate,
  AlwaysDenyApprovalGate,
  createGhPrReadTool
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

describe("gh_pr_read tool", () => {
  it("calls gh pr list with correct args and uses workspace cwd", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/workspace",
      sandbox: mockSandbox(capture)
    });
    const result = await tool.execute({ action: "list" });
    expect(capture.command).toBe("gh");
    expect(capture.args).toEqual(["pr", "list"]);
    expect(capture.cwd).toBe("/workspace");
    expect(result).toEqual({ stdout: "mock stdout", stderr: "" });
  });

  it("adds --state and --limit for list when provided", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture)
    });
    await tool.execute({ action: "list", state: "closed", limit: 10 });
    expect(capture.args).toEqual(["pr", "list", "--state", "closed", "--limit", "10"]);
  });

  it("caps list limit at 100", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture)
    });
    await tool.execute({ action: "list", limit: 500 });
    expect(capture.args).toContain("100");
  });

  it("calls gh pr view <number> for action view with number", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture)
    });
    await tool.execute({ action: "view", number: 42 });
    expect(capture.args).toEqual(["pr", "view", "42"]);
  });

  it("calls gh pr view <branch> for action view with branch", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture)
    });
    await tool.execute({ action: "view", branch: "feature/foo" });
    expect(capture.args).toEqual(["pr", "view", "feature/foo"]);
  });

  it("adds --repo when repoScope is set", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      repoScope: "owner/repo",
      sandbox: mockSandbox(capture)
    });
    await tool.execute({ action: "list" });
    expect(capture.args).toEqual(["pr", "list", "--repo", "owner/repo"]);
  });

  it("adds --repo before view target for view", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      repoScope: "org/proj",
      sandbox: mockSandbox(capture)
    });
    await tool.execute({ action: "view", number: 1 });
    expect(capture.args).toEqual(["pr", "view", "--repo", "org/proj", "1"]);
  });

  it("throws when action view has neither number nor branch", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture)
    });
    await expect(tool.execute({ action: "view" })).rejects.toThrow("for action view provide number or branch");
  });

  it("throws when approval is denied", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysDenyApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture)
    });
    await expect(tool.execute({ action: "list" })).rejects.toThrow("gh_pr_read requires approval");
  });

  it("rejects invalid branch (injection attempt)", async () => {
    const capture: { command: string; args: string[]; cwd?: string } = { command: "", args: [] };
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w",
      sandbox: mockSandbox(capture)
    });
    await expect(tool.execute({ action: "view", branch: "x; rm -rf /" })).rejects.toThrow(
      "for action view provide number or branch"
    );
  });

  it("has expected schema and name", () => {
    const tool = createGhPrReadTool({
      approvalGate: new AlwaysAllowApprovalGate(),
      workspaceCwd: "/w"
    });
    expect(tool.name).toBe("gh_pr_read");
    const schema = tool.schema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toContain("action");
    expect(schema.properties?.action).toEqual({ type: "string", enum: ["list", "view"] });
  });
});
