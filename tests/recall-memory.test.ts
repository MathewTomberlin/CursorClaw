import { describe, expect, it } from "vitest";

import { createRecallMemoryTool } from "../src/tools.js";
import type { ToolExecuteContext } from "../src/types.js";

describe("recall_memory tool", () => {
  it("returns error when not in main session (no profileRoot)", async () => {
    const tool = createRecallMemoryTool({
      getRecallResults: async () => [{ recordId: "1", text: "x", category: "note", score: 1 }]
    });
    const ctx: ToolExecuteContext = { auditId: "a", decisionLogs: [], channelKind: "web" };
    const result = await tool.execute({ query: "test", top_k: 5 }, ctx);
    expect(result).toEqual({ error: "recall_memory is only available in the main or heartbeat session." });
  });

  it("returns error when not in main session (channelKind not web)", async () => {
    const tool = createRecallMemoryTool({
      getRecallResults: async () => []
    });
    const ctx: ToolExecuteContext = {
      auditId: "a",
      decisionLogs: [],
      profileRoot: "/profile",
      channelKind: "slack"
    };
    const result = await tool.execute({ query: "test" }, ctx);
    expect(result).toEqual({ error: "recall_memory is only available in the main or heartbeat session." });
  });

  it("calls getRecallResults and returns results when in main session", async () => {
    const tool = createRecallMemoryTool({
      getRecallResults: async (root, query, topK) => {
        expect(root).toBe("/profile");
        expect(query).toBe("deploy");
        expect(topK).toBe(3);
        return [
          { recordId: "r1", text: "We deploy on Fridays", category: "note", score: 0.9 }
        ];
      }
    });
    const ctx: ToolExecuteContext = {
      auditId: "a",
      decisionLogs: [],
      profileRoot: "/profile",
      channelKind: "web"
    };
    const result = await tool.execute({ query: "deploy", top_k: 3 }, ctx);
    expect(result).toEqual({
      results: [{ recordId: "r1", text: "We deploy on Fridays", category: "note", score: 0.9 }]
    });
  });

  it("defaults top_k to 5", async () => {
    let capturedTopK = 0;
    const tool = createRecallMemoryTool({
      getRecallResults: async (_root, _query, topK) => {
        capturedTopK = topK;
        return [];
      }
    });
    const ctx: ToolExecuteContext = { auditId: "a", decisionLogs: [], profileRoot: "/p", channelKind: "web" };
    await tool.execute({ query: "q" }, ctx);
    expect(capturedTopK).toBe(5);
  });
});
