import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isProfileApiKeyRef,
  resolveApiKey,
  resolveApiKeyAsync
} from "../src/security/credential-resolver.js";
import {
  deleteProviderCredential,
  getProviderCredential,
  listProviderCredentialNames,
  listProvidersWithCredentials,
  setProviderCredential
} from "../src/security/provider-credentials.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("isProfileApiKeyRef", () => {
  it("returns true for profile: refs", () => {
    expect(isProfileApiKeyRef("profile:openai-compatible")).toBe(true);
    expect(isProfileApiKeyRef("profile:openai-compatible.apiKey")).toBe(true);
  });
  it("returns false for non-profile refs or empty", () => {
    expect(isProfileApiKeyRef("env:FOO")).toBe(false);
    expect(isProfileApiKeyRef(undefined)).toBe(false);
    expect(isProfileApiKeyRef("")).toBe(false);
  });
});

describe("resolveApiKeyAsync", () => {
  it("resolves env: sync when profileRoot missing", async () => {
    const env = { KEY: "from-env" };
    expect(await resolveApiKeyAsync("env:KEY", undefined, env)).toBe("from-env");
  });

  it("resolves profile:providerId from store when profileRoot set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-creds-"));
    try {
      await setProviderCredential(dir, "openai-compatible", "apiKey", "sk-stored");
      expect(await resolveApiKeyAsync("profile:openai-compatible", dir)).toBe("sk-stored");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves profile:providerId.keyName from store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-creds-"));
    try {
      await setProviderCredential(dir, "my-provider", "customKey", "custom-value");
      expect(await resolveApiKeyAsync("profile:my-provider.customKey", dir)).toBe("custom-value");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for profile: when profileRoot missing", async () => {
    expect(await resolveApiKeyAsync("profile:openai-compatible", undefined)).toBeUndefined();
  });

  it("returns undefined for profile: when key not in store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-creds-"));
    try {
      expect(await resolveApiKeyAsync("profile:openai-compatible", dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("provider-credentials", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "provider-creds-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("set and get round-trip", async () => {
    await setProviderCredential(dir, "openai-compatible", "apiKey", "sk-xyz");
    expect(await getProviderCredential(dir, "openai-compatible", "apiKey")).toBe("sk-xyz");
  });

  it("delete removes key", async () => {
    await setProviderCredential(dir, "p", "k", "v");
    expect(await getProviderCredential(dir, "p", "k")).toBe("v");
    expect(await deleteProviderCredential(dir, "p", "k")).toBe(true);
    expect(await getProviderCredential(dir, "p", "k")).toBeUndefined();
  });

  it("listProviderCredentialNames and listProvidersWithCredentials", async () => {
    expect(await listProvidersWithCredentials(dir)).toEqual([]);
    await setProviderCredential(dir, "openai-compatible", "apiKey", "sk-x");
    expect(await listProviderCredentialNames(dir, "openai-compatible")).toEqual(["apiKey"]);
    expect(await listProvidersWithCredentials(dir)).toEqual(["openai-compatible"]);
  });

  it("rejects invalid providerId", async () => {
    await expect(setProviderCredential(dir, "bad/id", "apiKey", "v")).rejects.toThrow(
      "providerId must match"
    );
  });
});
