import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadConfigFromDisk,
  resolveConfigPath,
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
});
