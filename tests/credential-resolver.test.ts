import { describe, expect, it } from "vitest";
import { resolveApiKey } from "../src/security/credential-resolver.js";

describe("resolveApiKey", () => {
  it("returns value from env when ref is env:VAR_NAME", () => {
    const env = { MY_API_KEY: "secret123" };
    expect(resolveApiKey("env:MY_API_KEY", env)).toBe("secret123");
  });

  it("returns undefined when ref is missing", () => {
    expect(resolveApiKey(undefined, {})).toBeUndefined();
    expect(resolveApiKey("", {})).toBeUndefined();
  });

  it("returns undefined when ref does not start with env:", () => {
    const env = { FOO: "bar" };
    expect(resolveApiKey("FOO", env)).toBeUndefined();
    expect(resolveApiKey("file:/path/to/key", env)).toBeUndefined();
  });

  it("returns undefined when env var is not set or empty", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveApiKey("env:MISSING", env)).toBeUndefined();
    env.EMPTY = "";
    expect(resolveApiKey("env:EMPTY", env)).toBeUndefined();
  });

  it("trims ref and var name", () => {
    const env = { X: "v" };
    expect(resolveApiKey(" env:X ", env)).toBe("v");
  });
});
