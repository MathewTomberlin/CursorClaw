import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDefaultProfileId,
  getModelIdForProfile,
  loadConfig,
  loadConfigFromDisk,
  resolveConfigPath,
  resolveProfileRoot,
  validateStartupConfig
} from "../src/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("config security startup rules", () => {
  it("rejects placeholder credentials at startup in secure mode", () => {
    const config = loadConfigFromDisk({
      cwd: "/definitely/missing-path"
    });
    expect(() =>
      validateStartupConfig(config, {
        allowInsecureDefaults: false
      })
    ).toThrow(/placeholder gateway credentials/i);
  });

  it("allows insecure defaults in explicit dev mode", () => {
    const config = loadConfigFromDisk({
      cwd: "/definitely/missing-path"
    });
    expect(() =>
      validateStartupConfig(config, {
        allowInsecureDefaults: true
      })
    ).not.toThrow();
  });

  it("rejects literal undefined/null credential strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-config-invalid-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "openclaw.json"),
      JSON.stringify({
        gateway: {
          auth: {
            mode: "token",
            token: "undefined"
          }
        }
      }),
      "utf8"
    );

    const config = loadConfigFromDisk({ cwd: dir });
    expect(() =>
      validateStartupConfig(config, {
        allowInsecureDefaults: false
      })
    ).toThrow(/invalid literal gateway credentials/i);
  });

  it("loads configuration from openclaw.json and honors env path override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-config-load-"));
    tempDirs.push(dir);
    const customPath = join(dir, "custom.json");
    await writeFile(
      customPath,
      JSON.stringify({
        gateway: {
          auth: {
            mode: "token",
            token: "secure-token"
          },
          bodyLimitBytes: 12345
        },
        tools: {
          exec: {
            profile: "developer"
          }
        }
      }),
      "utf8"
    );

    const configPath = resolveConfigPath({
      cwd: dir,
      env: {
        CURSORCLAW_CONFIG_PATH: customPath
      } as NodeJS.ProcessEnv
    });
    expect(configPath).toBe(customPath);

    const config = loadConfigFromDisk({
      cwd: dir,
      env: {
        CURSORCLAW_CONFIG_PATH: customPath
      } as NodeJS.ProcessEnv
    });
    expect(config.gateway.auth.token).toBe("secure-token");
    expect(config.gateway.bodyLimitBytes).toBe(12345);
    expect(config.tools.exec.profile).toBe("developer");
  });

  it("prefers explicit configPath over env and cwd defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-config-path-option-"));
    tempDirs.push(dir);
    const explicitPath = join(dir, "explicit.json");
    const envPath = join(dir, "env.json");
    await writeFile(
      explicitPath,
      JSON.stringify({
        gateway: {
          auth: {
            mode: "token",
            token: "explicit-token"
          },
          bodyLimitBytes: 33333
        }
      }),
      "utf8"
    );
    await writeFile(
      envPath,
      JSON.stringify({
        gateway: {
          auth: {
            mode: "token",
            token: "env-token"
          },
          bodyLimitBytes: 22222
        }
      }),
      "utf8"
    );

    const resolvedPath = resolveConfigPath({
      configPath: explicitPath,
      cwd: "/definitely/missing-path",
      env: {
        CURSORCLAW_CONFIG_PATH: envPath
      } as NodeJS.ProcessEnv
    });
    expect(resolvedPath).toBe(explicitPath);

    const config = loadConfigFromDisk({
      configPath: explicitPath,
      cwd: "/definitely/missing-path",
      env: {
        CURSORCLAW_CONFIG_PATH: envPath
      } as NodeJS.ProcessEnv
    });
    expect(config.gateway.auth.token).toBe("explicit-token");
    expect(config.gateway.bodyLimitBytes).toBe(33333);
  });
});

describe("agent profile resolution", () => {
  it("uses workspaceDir as single profile root when no profiles configured", () => {
    const config = loadConfig();
    expect(getDefaultProfileId(config)).toBe("default");
    const workspaceDir = join("tmp", "workspace");
    const expectedRoot = resolve(workspaceDir);
    expect(resolveProfileRoot(workspaceDir, config)).toBe(expectedRoot);
    expect(resolveProfileRoot(workspaceDir, config, "default")).toBe(expectedRoot);
  });

  it("returns first profile id and resolves profile roots when profiles configured", () => {
    const config = loadConfig({
      profiles: [
        { id: "main", root: "." },
        { id: "assistant", root: "profiles/assistant" }
      ]
    });
    expect(getDefaultProfileId(config)).toBe("main");
    const workspaceDir = join("app", "project");
    const base = resolve(workspaceDir);
    expect(resolveProfileRoot(workspaceDir, config)).toBe(base);
    expect(resolveProfileRoot(workspaceDir, config, "main")).toBe(base);
    expect(resolveProfileRoot(workspaceDir, config, "assistant")).toBe(join(base, "profiles", "assistant"));
  });

  it("rejects profile root outside workspace (path traversal)", () => {
    const config = loadConfig({
      profiles: [{ id: "evil", root: "../../etc" }]
    });
    expect(() => resolveProfileRoot("/app/workspace", config, "evil")).toThrow(
      /profile root must be under workspace/
    );
  });
});

describe("getModelIdForProfile", () => {
  it("returns defaultModel when no profiles configured", () => {
    const config = loadConfig();
    expect(getModelIdForProfile(config, "default")).toBe(config.defaultModel);
  });

  it("returns defaultModel when profile has no modelId", () => {
    const config = loadConfig({
      profiles: [
        { id: "main", root: "." },
        { id: "assistant", root: "profiles/assistant" }
      ]
    });
    expect(getModelIdForProfile(config, "main")).toBe(config.defaultModel);
    expect(getModelIdForProfile(config, "assistant")).toBe(config.defaultModel);
  });

  it("returns profile modelId when set and exists in config.models", () => {
    const config = loadConfig({
      models: {
        "cursor-auto": {
          provider: "cursor-agent-cli",
          timeoutMs: 60_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        },
        "fallback-model": {
          provider: "fallback-model",
          timeoutMs: 5_000,
          authProfiles: ["default"],
          fallbackModels: [],
          enabled: true
        }
      },
      defaultModel: "cursor-auto",
      profiles: [
        { id: "main", root: "." },
        { id: "assistant", root: "profiles/assistant", modelId: "fallback-model" }
      ]
    });
    expect(getModelIdForProfile(config, "main")).toBe("cursor-auto");
    expect(getModelIdForProfile(config, "assistant")).toBe("fallback-model");
  });

  it("falls back to defaultModel when profile modelId is not in config.models", () => {
    const config = loadConfig({
      profiles: [{ id: "other", root: "other", modelId: "nonexistent-model" }]
    });
    expect(getModelIdForProfile(config, "other")).toBe(config.defaultModel);
  });
});
