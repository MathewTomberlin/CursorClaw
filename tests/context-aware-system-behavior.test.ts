import { describe, it, expect } from "vitest";
import { shouldUseMinimalToolContext } from "../src/runtime.js";
import type { ModelProviderConfig } from "../src/config.js";

const ollamaConfig: ModelProviderConfig = {
  provider: "ollama",
  timeoutMs: 60000,
  authProfiles: ["default"],
  fallbackModels: [],
  enabled: true
};

describe("shouldUseMinimalToolContext", () => {
  it("returns false when no tools are provided", () => {
    expect(shouldUseMinimalToolContext(0, "edit the file", ollamaConfig)).toBe(false);
    expect(shouldUseMinimalToolContext(0, "explain quantum physics", ollamaConfig)).toBe(false);
  });

  it("returns true by default when tools present and no strong signal", () => {
    expect(shouldUseMinimalToolContext(3, "hello", ollamaConfig)).toBe(true);
    expect(shouldUseMinimalToolContext(1, "what do you think?", ollamaConfig)).toBe(true);
  });

  it("returns false for richer/creative intent (explain, summarize, describe)", () => {
    expect(shouldUseMinimalToolContext(5, "Explain how this works", ollamaConfig)).toBe(false);
    expect(shouldUseMinimalToolContext(5, "Summarize the document", ollamaConfig)).toBe(false);
    expect(shouldUseMinimalToolContext(5, "Describe the architecture", ollamaConfig)).toBe(false);
    expect(shouldUseMinimalToolContext(5, "What is recursion?", ollamaConfig)).toBe(false);
    expect(shouldUseMinimalToolContext(5, "Write a short story about a robot", ollamaConfig)).toBe(
      false
    );
  });

  it("returns true for tool intent (edit, update, file, substrate, ROADMAP)", () => {
    expect(shouldUseMinimalToolContext(5, "Edit src/main.ts", ollamaConfig)).toBe(true);
    expect(shouldUseMinimalToolContext(5, "update ROADMAP.md", ollamaConfig)).toBe(true);
    expect(shouldUseMinimalToolContext(5, "read the file config.json", ollamaConfig)).toBe(true);
    expect(shouldUseMinimalToolContext(5, "run the tests", ollamaConfig)).toBe(true);
    expect(shouldUseMinimalToolContext(5, "update substrate MEMORY", ollamaConfig)).toBe(true);
    expect(shouldUseMinimalToolContext(5, "run sed to fix the line", ollamaConfig)).toBe(true);
  });

  it("returns true when message mentions a file path pattern", () => {
    expect(shouldUseMinimalToolContext(5, "check docs/README.md", ollamaConfig)).toBe(true);
    expect(shouldUseMinimalToolContext(5, "open package.json", ollamaConfig)).toBe(true);
  });

  it("accepts undefined modelConfig (safe fallback)", () => {
    expect(shouldUseMinimalToolContext(1, "edit file", undefined)).toBe(true);
    expect(shouldUseMinimalToolContext(0, "edit file", undefined)).toBe(false);
  });
});
