import { describe, expect, it } from "vitest";

import {
  applyMaxContextTokens,
  estimateTokens,
  summarizePrefix
} from "../src/max-context-tokens.js";

describe("max-context-tokens (TU.2)", () => {
  it("estimateTokens uses ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });

  it("returns messages unchanged when under cap", () => {
    const messages = [
      { role: "system", content: "short" },
      { role: "user", content: "hi" }
    ];
    expect(applyMaxContextTokens(messages, 100)).toEqual(messages);
  });

  it("trims oldest messages when over cap (system first)", () => {
    // 400 chars ≈ 100 tokens; cap 100. Two system blocks of 200 chars = 50 each, one user 200 = 50 → 150 tokens.
    const system1 = "x".repeat(200);
    const system2 = "y".repeat(200);
    const user = "z".repeat(200);
    const messages = [
      { role: "system", content: system1 },
      { role: "system", content: system2 },
      { role: "user", content: user }
    ];
    const result = applyMaxContextTokens(messages, 100);
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toBe(system2);
    expect(result[1]!.content).toBe(user);
    const est = result.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
    expect(est).toBeLessThanOrEqual(100);
  });

  it("keeps last message even when it alone exceeds cap", () => {
    const huge = "a".repeat(500);
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: huge }
    ];
    const result = applyMaxContextTokens(messages, 100);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe(huge);
  });

  it("message list passed to adapter is under cap when possible", () => {
    const messages = [
      { role: "system", content: "s1".repeat(100) },
      { role: "system", content: "s2".repeat(100) },
      { role: "user", content: "u1".repeat(80) }
    ];
    const result = applyMaxContextTokens(messages, 100);
    const totalTokens = result.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
    expect(totalTokens).toBeLessThanOrEqual(100);
    expect(result[result.length - 1]!.role).toBe("user");
  });

  describe("TU.3 priority-aware truncation", () => {
    it("with no truncationPriority uses oldest-first (same as TU.2)", () => {
      const system1 = "x".repeat(200);
      const system2 = "y".repeat(200);
      const user = "z".repeat(200);
      const messages = [
        { role: "system", content: system1 },
        { role: "system", content: system2 },
        { role: "user", content: user }
      ];
      const result = applyMaxContextTokens(messages, 100);
      expect(result).toHaveLength(2);
      expect(result[0]!.content).toBe(system2);
      expect(result[1]!.content).toBe(user);
    });

    it("with truncationPriority drops assistant first then user then system", () => {
      // Each long message ≈100 tokens; cap 150. Last "last" ≈1. We keep last + fill by priority (system before user before assistant).
      const a = "a".repeat(400);
      const u = "u".repeat(400);
      const s = "s".repeat(400);
      const messages = [
        { role: "system", content: s },
        { role: "user", content: u },
        { role: "assistant", content: a },
        { role: "user", content: "last" }
      ];
      const result = applyMaxContextTokens(messages, 150, ["assistant", "user", "system"]);
      // Drop order: assistant first, then user, then system. So we keep last (1) + one of system/user/assistant. First we add system (100), then user would exceed 150, so we get system + last.
      expect(result.map((m) => m.role)).toEqual(["system", "user"]);
      expect(result[result.length - 1]!.content).toBe("last");
      const totalTokens = result.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
      expect(totalTokens).toBeLessThanOrEqual(150);
    });

    it("always keeps last message regardless of role when using priority", () => {
      const huge = "a".repeat(500);
      const messages = [
        { role: "system", content: "sys" },
        { role: "assistant", content: huge }
      ];
      const result = applyMaxContextTokens(messages, 10, ["assistant", "user", "system"]);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe(huge);
    });
  });

  describe("TU.4 summarization of old turns", () => {
    it("summarizePrefix with 0 or 1 message returns last only or (none)", () => {
      const empty = summarizePrefix([], 200);
      expect(empty.summaryMessage.role).toBe("system");
      expect(empty.summaryMessage.content).toContain("Summary of earlier turns:");
      expect(empty.remainingMessages).toEqual([]);

      const one = [{ role: "user" as const, content: "hi" }];
      const r = summarizePrefix(one, 200);
      expect(r.summaryMessage.content).toContain("(none)");
      expect(r.remainingMessages).toEqual(one);
    });

    it("summarizePrefix replaces prefix with one system summary and keeps last message", () => {
      const messages = [
        { role: "user", content: "What is X?" },
        { role: "assistant", content: "X is a thing." },
        { role: "user", content: "last" }
      ];
      const { summaryMessage, remainingMessages } = summarizePrefix(messages, 200);
      expect(summaryMessage.role).toBe("system");
      expect(summaryMessage.content).toMatch(/^Summary of earlier turns:\n/);
      expect(summaryMessage.content).toContain("User: What is X?");
      expect(summaryMessage.content).toContain("Assistant: X is a thing.");
      expect(remainingMessages).toHaveLength(1);
      expect(remainingMessages[0]!.content).toBe("last");
    });

    it("summary length never exceeds maxSummaryTokens (body) plus fixed prefix", () => {
      const long = "a".repeat(2000);
      const messages = [
        { role: "user", content: long },
        { role: "assistant", content: long },
        { role: "user", content: "last" }
      ];
      const maxSummaryTokens = 50;
      const { summaryMessage } = summarizePrefix(messages, maxSummaryTokens);
      const prefixTokens = estimateTokens("Summary of earlier turns:\n");
      expect(estimateTokens(summaryMessage.content)).toBeLessThanOrEqual(
        maxSummaryTokens + prefixTokens + 1
      );
    });
  });
});
