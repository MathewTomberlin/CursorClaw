import { describe, expect, it } from "vitest";

import { createProposeSoulIdentityUpdateTool } from "../src/tools.js";
import type { ToolExecuteContext } from "../src/types.js";

const mainSessionCtx: ToolExecuteContext = {
  auditId: "a",
  decisionLogs: [],
  profileRoot: "/profile",
  channelKind: "web"
};

describe("propose_soul_identity_update tool", () => {
  it("returns error when not in main session (no profileRoot)", async () => {
    const tool = createProposeSoulIdentityUpdateTool({
      getSubstrateContent: () => ({ soul: "x", identity: "y" })
    });
    const ctx: ToolExecuteContext = { auditId: "a", decisionLogs: [], channelKind: "web" };
    const result = await tool.execute(
      { key: "soul", proposed_content: "new soul" },
      ctx
    );
    expect(result).toEqual({
      error: "propose_soul_identity_update is only available in the main session."
    });
  });

  it("returns error when channelKind is not web", async () => {
    const tool = createProposeSoulIdentityUpdateTool({
      getSubstrateContent: () => ({ soul: "x" })
    });
    const ctx: ToolExecuteContext = {
      ...mainSessionCtx,
      channelKind: "slack"
    };
    const result = await tool.execute(
      { key: "soul", proposed_content: "new" },
      ctx
    );
    expect(result).toEqual({
      error: "propose_soul_identity_update is only available in the main session."
    });
  });

  it("returns error when key is not soul or identity", async () => {
    const tool = createProposeSoulIdentityUpdateTool({
      getSubstrateContent: () => ({})
    });
    const result = await tool.execute(
      { key: "agents", proposed_content: "x" },
      mainSessionCtx
    );
    expect(result).toEqual({ error: "key must be 'soul' or 'identity'." });
  });

  it("returns error when proposed_content is empty", async () => {
    const tool = createProposeSoulIdentityUpdateTool({
      getSubstrateContent: () => ({ soul: "current" })
    });
    const result = await tool.execute(
      { key: "soul", proposed_content: "   " },
      mainSessionCtx
    );
    expect(result).toEqual({
      error: "proposed_content is required and must be non-empty."
    });
  });

  it("returns error when substrate not available for profile", async () => {
    const tool = createProposeSoulIdentityUpdateTool({
      getSubstrateContent: () => undefined
    });
    const result = await tool.execute(
      { key: "soul", proposed_content: "new soul" },
      mainSessionCtx
    );
    expect(result).toEqual({ error: "Substrate not available for this profile." });
  });

  it("returns current and proposed content for soul (proposal-only, no write)", async () => {
    const tool = createProposeSoulIdentityUpdateTool({
      getSubstrateContent: (root) => {
        expect(root).toBe("/profile");
        return { soul: "# Current SOUL", identity: "# Current IDENTITY" };
      }
    });
    const result = await tool.execute(
      { key: "soul", proposed_content: "# Evolved SOUL\n\nNew section." },
      mainSessionCtx
    );
    expect(result).toEqual({
      key: "soul",
      file: "SOUL.md",
      current_content: "# Current SOUL",
      proposed_content: "# Evolved SOUL\n\nNew section.",
      message:
        "Proposed update to SOUL.md. Review the proposed_content above; apply manually (e.g. via Settings or substrate.update) if you want to save it. No file was written."
    });
  });

  it("returns current and proposed content for identity", async () => {
    const tool = createProposeSoulIdentityUpdateTool({
      getSubstrateContent: () => ({ identity: "Old identity" })
    });
    const result = await tool.execute(
      { key: "identity", proposed_content: "New identity" },
      mainSessionCtx
    );
    expect(result).toEqual({
      key: "identity",
      file: "IDENTITY.md",
      current_content: "Old identity",
      proposed_content: "New identity",
      message:
        "Proposed update to IDENTITY.md. Review the proposed_content above; apply manually (e.g. via Settings or substrate.update) if you want to save it. No file was written."
    });
  });
});
