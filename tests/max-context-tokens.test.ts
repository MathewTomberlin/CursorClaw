import { describe, expect, it } from "vitest";

import { applyMaxContextTokens, estimateTokens } from "../src/max-context-tokens.js";

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
});
