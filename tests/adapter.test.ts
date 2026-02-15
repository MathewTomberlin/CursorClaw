import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { describe, expect, it, afterEach, vi } from "vitest";

import { CursorAgentModelAdapter } from "../src/model-adapter.js";
import { CursorAgentCliProvider } from "../src/providers/cursor-agent-cli.js";
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

  it("accepts protocol version 1.0 when sent as first event", async () => {
    const script = [
      "process.stdout.write(JSON.stringify({type:'protocol',data:{version:'1.0'}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'assistant_delta',data:{content:'ok'}})+'\\n');",
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
      sessionId: "s1v",
      channelId: "c1",
      channelKind: "dm"
    });
    const events: string[] = [];
    for await (const event of adapter.sendTurn(
      session,
      [{ role: "user", content: "hi" }],
      [simpleTool],
      { turnId: "t-v1" }
    )) {
      events.push(event.type);
    }
    expect(events).toEqual(["assistant_delta", "done"]);
  });

  it("rejects unsupported protocol version", async () => {
    const script = [
      "process.stdout.write(JSON.stringify({type:'protocol',data:{version:'99.0'}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'done',data:{finishReason:'stop'}})+'\\n');"
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
      sessionId: "s2v",
      channelId: "c2",
      channelKind: "dm"
    });
    const collect = async (): Promise<void> => {
      for await (const _event of adapter.sendTurn(
        session,
        [{ role: "user", content: "hi" }],
        [simpleTool],
        { turnId: "t-v99" }
      )) {
        // no-op
      }
    };
    await expect(collect()).rejects.toThrow(/unsupported protocol version/);
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
    expect(adapter.getMetrics().fallbackAttemptCount).toBeGreaterThanOrEqual(1);
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

  it("forces SIGKILL in cancel when process is still running after SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const killCalls: Array<number | NodeJS.Signals> = [];
      const fakeChild = {
        killed: false,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdin: {
          write: (_chunk: string): boolean => true
        },
        kill(signal?: number | NodeJS.Signals): boolean {
          const resolvedSignal = signal ?? "SIGTERM";
          killCalls.push(resolvedSignal);
          return true;
        }
      } as unknown as import("node:child_process").ChildProcessWithoutNullStreams;

      const provider = new CursorAgentCliProvider();
      (provider as unknown as { processes: Map<string, unknown> }).processes = new Map();
      (provider as unknown as { processes: Map<string, unknown> }).processes.set(
        "cancel-turn",
        fakeChild
      );

      await provider.cancel("cancel-turn");
      await vi.advanceTimersByTimeAsync(300);

      expect(killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces SIGKILL in stageTerminate when process has not exited", async () => {
    vi.useFakeTimers();
    try {
      const killCalls: Array<number | NodeJS.Signals> = [];
      const fakeChild = {
        killed: false,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdin: {
          write: (_chunk: string): boolean => true
        },
        kill(signal?: number | NodeJS.Signals): boolean {
          const resolvedSignal = signal ?? "SIGTERM";
          killCalls.push(resolvedSignal);
          return true;
        }
      } as unknown as import("node:child_process").ChildProcessWithoutNullStreams;

      const provider = new CursorAgentCliProvider();
      (provider as unknown as {
        stageTerminate: (
          child: import("node:child_process").ChildProcessWithoutNullStreams,
          turnId: string
        ) => void;
      }).stageTerminate(fakeChild, "timeout-turn");
      await vi.advanceTimersByTimeAsync(500);

      expect(killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds adapter redacted logs to avoid unbounded memory growth", async () => {
    const provider = new CursorAgentCliProvider();
    const internal = provider as unknown as { pushEventLog: (entry: string) => void };
    for (let idx = 0; idx < 6_000; idx += 1) {
      internal.pushEventLog(`entry-${idx}`);
    }
    const logs = provider.getRedactedLogs();
    expect(logs.length).toBe(5_000);
    expect(logs[0]).toBe("entry-1000");
  });

  it("ollama provider streams events when fetch returns Ollama-format NDJSON", async () => {
    const ollamaChunks = [
      JSON.stringify({ message: { content: "Hello " }, done: false }) + "\n",
      JSON.stringify({ message: { content: "from Ollama" }, done: false }) + "\n",
      JSON.stringify({ done: true, eval_count: 12 }) + "\n"
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of ollamaChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      }
    });

    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
      text: () => Promise.resolve("")
    });
    vi.stubGlobal("fetch", fetchStub);

    try {
      const adapter = new CursorAgentModelAdapter({
        defaultModel: "local",
        models: {
          local: {
            provider: "ollama",
            ollamaModelName: "test-model",
            baseURL: "http://localhost:11434",
            timeoutMs: 10_000,
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
      const events: Array<{ type: string; data?: unknown }> = [];
      for await (const event of adapter.sendTurn(
        session,
        [{ role: "user", content: "hi" }],
        [simpleTool],
        { turnId: "ollama-turn-1" }
      )) {
        events.push({ type: event.type, data: event.data });
      }
      expect(events.map((e) => e.type)).toEqual(["assistant_delta", "assistant_delta", "usage", "done"]);
      const deltas = events.filter((e) => e.type === "assistant_delta").map((e) => (e.data as { content?: string })?.content);
      expect(deltas).toEqual(["Hello ", "from Ollama"]);
      expect(fetchStub).toHaveBeenCalledWith(
        "http://localhost:11434/api/chat",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            model: "test-model",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            tools: [
              {
                type: "function",
                function: {
                  name: "echo_tool",
                  description: "echo",
                  parameters: simpleTool.schema
                }
              }
            ]
          })
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ollama provider emits tool_call events when response includes message.tool_calls", async () => {
    const ollamaChunks = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "echo_tool", arguments: { value: "hello" } } }
          ]
        },
        done: false
      }) + "\n",
      JSON.stringify({ done: true, eval_count: 10 }) + "\n"
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of ollamaChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      }
    });

    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
      text: () => Promise.resolve("")
    });
    vi.stubGlobal("fetch", fetchStub);

    try {
      const adapter = new CursorAgentModelAdapter({
        defaultModel: "local",
        models: {
          local: {
            provider: "ollama",
            ollamaModelName: "test-model",
            baseURL: "http://localhost:11434",
            timeoutMs: 10_000,
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
      const events: Array<{ type: string; data?: unknown }> = [];
      for await (const event of adapter.sendTurn(
        session,
        [{ role: "user", content: "use echo" }],
        [simpleTool],
        { turnId: "ollama-tool-turn" }
      )) {
        events.push({ type: event.type, data: event.data });
      }
      expect(events.map((e) => e.type)).toEqual(["tool_call", "usage", "done"]);
      const toolCall = events.find((e) => e.type === "tool_call")?.data as { name?: string; args?: unknown };
      expect(toolCall?.name).toBe("echo_tool");
      expect(toolCall?.args).toEqual({ value: "hello" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ollama provider accumulates streamed tool_calls by index (e.g. Granite3.2)", async () => {
    const ollamaChunks = [
      JSON.stringify({
        message: { role: "assistant", content: "", tool_calls: [{ function: { name: "echo_tool" } }] },
        done: false
      }) + "\n",
      JSON.stringify({
        message: {
          tool_calls: [{ function: { arguments: '{"value":"streamed"}' } }]
        },
        done: false
      }) + "\n",
      JSON.stringify({ done: true, eval_count: 5 }) + "\n"
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of ollamaChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      }
    });
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
      text: () => Promise.resolve("")
    });
    vi.stubGlobal("fetch", fetchStub);

    try {
      const adapter = new CursorAgentModelAdapter({
        defaultModel: "local",
        models: {
          local: {
            provider: "ollama",
            ollamaModelName: "test-model",
            baseURL: "http://localhost:11434",
            timeoutMs: 10_000,
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
      const events: Array<{ type: string; data?: unknown }> = [];
      for await (const event of adapter.sendTurn(
        session,
        [{ role: "user", content: "call echo_tool" }],
        [simpleTool],
        { turnId: "ollama-stream-tool" }
      )) {
        events.push({ type: event.type, data: event.data });
      }
      expect(events.map((e) => e.type)).toContain("tool_call");
      const toolCall = events.find((e) => e.type === "tool_call")?.data as { name?: string; args?: unknown };
      expect(toolCall?.name).toBe("echo_tool");
      expect(toolCall?.args).toEqual({ value: "streamed" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ollama provider omits tools from request when tools array is empty", async () => {
    const ollamaChunks = [
      JSON.stringify({ message: { content: "Hi" }, done: false }) + "\n",
      JSON.stringify({ done: true, eval_count: 1 }) + "\n"
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of ollamaChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      }
    });
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
      text: () => Promise.resolve("")
    });
    vi.stubGlobal("fetch", fetchStub);

    try {
      const adapter = new CursorAgentModelAdapter({
        defaultModel: "local",
        models: {
          local: {
            provider: "ollama",
            ollamaModelName: "test-model",
            baseURL: "http://localhost:11434",
            timeoutMs: 10_000,
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
      for await (const _event of adapter.sendTurn(
        session,
        [{ role: "user", content: "hi" }],
        [],
        { turnId: "ollama-no-tools" }
      )) {
        // consume
      }
      const call = fetchStub.mock.calls[0];
      expect(call).toBeDefined();
      const body = JSON.parse((call as [string, RequestInit])[1].body as string);
      expect(body.tools).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("openai-compatible provider streams events when fetch returns OpenAI-format SSE and apiKeyRef resolves", async () => {
    const sseChunks = [
      "data: " + JSON.stringify({ choices: [{ delta: { content: "Hi " } }] }) + "\n",
      "data: " + JSON.stringify({ choices: [{ delta: { content: "from API" } }] }) + "\n",
      "data: " + JSON.stringify({ choices: [{ finish_reason: "stop" }] }) + "\n",
      "data: [DONE]\n"
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      }
    });

    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
      text: () => Promise.resolve("")
    });
    vi.stubGlobal("fetch", fetchStub);

    const envKey = "TEST_OPENAI_KEY_" + Date.now();
    const originalEnv = process.env[envKey];
    process.env[envKey] = "sk-test-secret";

    try {
      const adapter = new CursorAgentModelAdapter({
        defaultModel: "api",
        models: {
          api: {
            provider: "openai-compatible",
            apiKeyRef: "env:" + envKey,
            openaiModelId: "gpt-4o-mini",
            baseURL: "https://api.openai.com/v1",
            timeoutMs: 10_000,
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
      const events: Array<{ type: string; data?: unknown }> = [];
      for await (const event of adapter.sendTurn(
        session,
        [{ role: "user", content: "hi" }],
        [simpleTool],
        { turnId: "openai-turn-1" }
      )) {
        events.push({ type: event.type, data: event.data });
      }
      expect(events.map((e) => e.type)).toEqual(["assistant_delta", "assistant_delta", "usage", "done"]);
      const deltas = events
        .filter((e) => e.type === "assistant_delta")
        .map((e) => (e.data as { content?: string })?.content);
      expect(deltas).toEqual(["Hi ", "from API"]);
      expect(fetchStub).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test-secret"
          }),
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
            stream: true
          })
        })
      );
    } finally {
      if (originalEnv !== undefined) {
        process.env[envKey] = originalEnv;
      } else {
        delete process.env[envKey];
      }
      vi.unstubAllGlobals();
    }
  });
});
