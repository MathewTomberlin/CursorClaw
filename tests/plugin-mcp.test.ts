import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { InMemoryMcpServerAdapter, McpRegistry } from "../src/mcp.js";
import { PluginHost } from "../src/plugins/host.js";
import { AlwaysAllowApprovalGate, createMcpCallTool, createMcpListResourcesTool, createMcpReadResourceTool } from "../src/tools.js";

describe("plugin host and MCP integration", () => {
  it("runs collector/analyzer/synthesizer pipeline with diagnostics isolation", async () => {
    const host = new PluginHost({
      defaultTimeoutMs: 100
    });
    host.registerCollector({
      id: "collector-ok",
      collect: async () => [
        {
          sourcePlugin: "collector-ok",
          type: "fact",
          payload: "alpha"
        }
      ]
    });
    host.registerCollector({
      id: "collector-fail",
      collect: async () => {
        throw new Error("collector exploded");
      }
    });
    host.registerAnalyzer({
      id: "analyzer-ok",
      analyze: async (_context, artifacts) => [
        {
          sourcePlugin: "analyzer-ok",
          type: "summary",
          payload: artifacts.map((item) => item.payload).join(",")
        }
      ]
    });
    host.registerSynthesizer({
      id: "synth-ok",
      synthesize: async (_context, insights) => [
        {
          role: "system",
          content: String(insights[0]?.payload ?? "")
        }
      ]
    });
    const result = await host.run({
      runId: "run-1",
      sessionId: "session-1",
      inputMessages: [{ role: "user", content: "hi" }]
    });
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]?.content).toContain("alpha");
    expect(result.diagnostics.some((detail) => detail.includes("collector-fail"))).toBe(true);
  });

  it("supports MCP resource listing/reading and tool invocation via tool definitions", async () => {
    const registry = new McpRegistry({
      allowedServers: ["local"]
    });
    const local = new InMemoryMcpServerAdapter("local");
    local.defineResource("mcp://notes/1", "hello note", "text/plain", "note-1");
    local.defineTool("sum", async (args) => {
      const payload = args as { a: number; b: number };
      return {
        value: payload.a + payload.b
      };
    });
    registry.register(local);

    const listTool = createMcpListResourcesTool({ registry });
    const readTool = createMcpReadResourceTool({ registry });
    const callTool = createMcpCallTool({
      registry,
      approvalGate: new AlwaysAllowApprovalGate()
    });

    const listed = (await listTool.execute({
      server: "local"
    })) as { resources: Array<{ uri: string }> };
    expect(listed.resources.some((resource) => resource.uri === "mcp://notes/1")).toBe(true);

    const read = (await readTool.execute({
      server: "local",
      uri: "mcp://notes/1"
    })) as { text: string };
    expect(read.text).toBe("hello note");

    const called = (await callTool.execute({
      server: "local",
      tool: "sum",
      input: { a: 2, b: 5 }
    })) as { value: number };
    expect(called.value).toBe(7);
  });

  it("enforces MCP server allowlist policy", async () => {
    const registry = new McpRegistry({
      allowedServers: ["local"]
    });
    const local = new InMemoryMcpServerAdapter("local");
    local.defineResource("mcp://ok", "ok");
    registry.register(local);
    const blocked = new InMemoryMcpServerAdapter("blocked");
    blocked.defineResource("mcp://blocked", "blocked");
    registry.register(blocked);

    const listed = await registry.listResources();
    expect(listed.some((resource) => resource.server === "blocked")).toBe(false);
    await expect(
      registry.readResource({
        server: "blocked",
        uri: "mcp://blocked"
      })
    ).rejects.toThrow(/not allowed by policy/i);
  });

  it("keeps plugin host execution throughput within baseline", async () => {
    const host = new PluginHost({
      defaultTimeoutMs: 100
    });
    host.registerCollector({
      id: "collector",
      collect: async () => [
        {
          sourcePlugin: "collector",
          type: "fact",
          payload: "a"
        }
      ]
    });
    host.registerAnalyzer({
      id: "analyzer",
      analyze: async () => [
        {
          sourcePlugin: "analyzer",
          type: "summary",
          payload: "a"
        }
      ]
    });
    host.registerSynthesizer({
      id: "synth",
      synthesize: async () => [
        {
          role: "system",
          content: "a"
        }
      ]
    });

    const start = performance.now();
    for (let idx = 0; idx < 500; idx += 1) {
      await host.run({
        runId: `run-${idx}`,
        sessionId: "s1",
        inputMessages: [{ role: "user", content: "hi" }]
      });
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
