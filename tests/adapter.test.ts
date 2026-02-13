import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { describe, expect, it, afterEach } from "vitest";

import { CursorAgentModelAdapter } from "../src/model-adapter.js";
import type { ToolDefinition } from "../src/types.js";

const simpleTool: ToolDefinition = {
  name: "echo_tool",
  description: "echo",
  schema: {
    type: "object",
    properties: {
      value: { type: "string" }
    },
    required: ["value"],
    additionalProperties: false
  },
  riskLevel: "low",
  execute: async (args) => args
};

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe("CursorAgentModelAdapter", () => {
  it("streams NDJSON events from subprocess", async () => {
    const script = [
      "process.stdout.write(JSON.stringify({type:'assistant_delta',data:{content:'hello '}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'assistant_delta',data:{content:'world'}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'done',data:{finishReason:'stop'}})+'\\n');"
    ].join("");

    const adapter = new CursorAgentModelAdapter({
      defaultModel: "cursor-auto",
      models: {
        "cursor-auto": {
          provider: "cursor-agent-cli",
          command: process.execPath,
          args: ["-e", script],
          timeoutMs: 20_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      }
    });

    const session = await adapter.createSession({
      sessionId: "s1",
      channelId: "c1",
      channelKind: "dm"
    });

    const events: string[] = [];
    for await (const event of adapter.sendTurn(
      session,
      [{ role: "user", content: "hi" }],
      [simpleTool],
      { turnId: "t-1" }
    )) {
      events.push(event.type);
    }
    expect(events).toEqual(["assistant_delta", "assistant_delta", "done"]);
  });

  it("fails closed on malformed JSON frame", async () => {
    const script = "process.stdout.write('not-json\\n')";
    const adapter = new CursorAgentModelAdapter({
      defaultModel: "cursor-auto",
      models: {
        "cursor-auto": {
          provider: "cursor-agent-cli",
          command: process.execPath,
          args: ["-e", script],
          timeoutMs: 5_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      }
    });
    const session = await adapter.createSession({
      sessionId: "s2",
      channelId: "c2",
      channelKind: "dm"
    });

    const collect = async (): Promise<void> => {
      for await (const _event of adapter.sendTurn(
        session,
        [{ role: "user", content: "hi" }],
        [simpleTool],
        { turnId: "t-2" }
      )) {
        // no-op
      }
    };
    await expect(collect()).rejects.toThrow(/malformed frame/i);
  });

  it("falls back to secondary model on auth-like transport failure", async () => {
    const script = [
      "process.stderr.write('auth failed');",
      "process.exit(1);"
    ].join("");
    const adapter = new CursorAgentModelAdapter({
      defaultModel: "cursor-auto",
      models: {
        "cursor-auto": {
          provider: "cursor-agent-cli",
          command: process.execPath,
          args: ["-e", script],
          timeoutMs: 5_000,
          authProfiles: ["default", "backup"],
          fallbackModels: ["fallback-model-a"],
          enabled: true
        },
        "fallback-model-a": {
          provider: "fallback-model",
          timeoutMs: 5_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      }
    });
    const session = await adapter.createSession({
      sessionId: "s3",
      channelId: "c3",
      channelKind: "dm"
    });
    const outputs: string[] = [];
    for await (const event of adapter.sendTurn(
      session,
      [{ role: "user", content: "hello fallback" }],
      [simpleTool],
      { turnId: "t-3" }
    )) {
      outputs.push(event.type);
    }
    expect(outputs).toContain("assistant_delta");
    expect(outputs[outputs.length - 1]).toBe("done");
  });

  it("rejects unknown tool call names", async () => {
    const script = [
      "process.stdout.write(JSON.stringify({type:'tool_call',data:{name:'missing',args:{}}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'done',data:{}})+'\\n');"
    ].join("");
    const adapter = new CursorAgentModelAdapter({
      defaultModel: "cursor-auto",
      models: {
        "cursor-auto": {
          provider: "cursor-agent-cli",
          command: process.execPath,
          args: ["-e", script],
          timeoutMs: 5_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      }
    });
    const session = await adapter.createSession({
      sessionId: "s4",
      channelId: "c4",
      channelKind: "dm"
    });
    const collect = async (): Promise<void> => {
      for await (const _event of adapter.sendTurn(
        session,
        [{ role: "user", content: "call tool" }],
        [simpleTool],
        { turnId: "t-4" }
      )) {
        // no-op
      }
    };
    await expect(collect()).rejects.toThrow(/unknown tool call/i);
  });
});
