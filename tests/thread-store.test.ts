import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getThread, setThread, appendMessage, sanitizeSessionId } from "../src/thread-store.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("thread-store", () => {
  it("returns empty thread when no file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thread-store-"));
    cleanupPaths.push(dir);
    const messages = await getThread(dir, "demo-session");
    expect(messages).toEqual([]);
  });

  it("setThread and getThread round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thread-store-"));
    cleanupPaths.push(dir);
    await setThread(dir, "s1", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" }
    ]);
    const messages = await getThread(dir, "s1");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("Hello");
    expect(messages[0]!.id).toBeDefined();
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe("Hi there");
  });

  it("appendMessage adds one message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thread-store-"));
    cleanupPaths.push(dir);
    await setThread(dir, "s2", [{ role: "user", content: "One" }]);
    await appendMessage(dir, "s2", { role: "assistant", content: "Two" });
    const messages = await getThread(dir, "s2");
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toBe("Two");
  });

  it("sanitizeSessionId produces safe filenames", () => {
    expect(sanitizeSessionId("demo-session")).toBe("demo-session");
    expect(sanitizeSessionId("a/b/c")).toBe("a_b_c");
    expect(sanitizeSessionId("")).toBe("_empty");
    expect(sanitizeSessionId("..")).toBe("__");
  });
});
