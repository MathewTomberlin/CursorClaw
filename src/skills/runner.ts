/**
 * Install runner for Agent Skills. Runs install section in a restricted context.
 * See docs/AGENT_PROFILES_SKILLS_PROVIDER_IMPLEMENTATION.md § 4.4 Phase S.3.
 *
 * - Only runs after safety check has passed (caller's responsibility).
 * - cwd = profile skills directory; no write outside.
 * - Allowlisted: bash (install block run as script via stdin).
 * - Captures stdout/stderr and returns to caller.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { SkillDefinition } from "./types.js";

export interface RunInstallResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

/** Default timeout for install script (seconds). */
const INSTALL_TIMEOUT_SEC = 300;

/**
 * Run the install section of a skill definition in a restricted context.
 * Caller must have already run safety check and only call when safety.allowed.
 *
 * @param profileRoot - Profile root path (skills dir will be under it).
 * @param skillId - Skill id (used for install subdir so multiple skills don't clash).
 * @param definition - Parsed skill definition; install block is run as a bash script.
 * @param timeoutSec - Max time for install (default INSTALL_TIMEOUT_SEC).
 */
export async function runInstall(
  profileRoot: string,
  skillId: string,
  definition: SkillDefinition,
  timeoutSec: number = INSTALL_TIMEOUT_SEC
): Promise<RunInstallResult> {
  const installBlock = (definition.install || "").trim();
  if (!installBlock) {
    return {
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }

  const { skillsDirs, ensureSkillsDirs } = await import("./store.js");
  await ensureSkillsDirs(profileRoot);
  const installCwd = join(profileRoot, skillsDirs.root, "install", skillId);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(installCwd, { recursive: true });

  return new Promise((resolve) => {
    const child = spawn("bash", ["-s"], {
      cwd: installCwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => errChunks.push(d));

    let settled = false;
    const finish = (ok: boolean, exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode,
        ...(error !== undefined && { error })
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false, null, `Install timed out after ${timeoutSec}s`);
    }, timeoutSec * 1000);

    child.on("error", (err) => {
      finish(false, null, err.message);
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        finish(code === 0, code, signal ? `Process killed: ${signal}` : undefined);
      }
    });

    child.stdin?.write(installBlock, "utf8", () => {
      child.stdin?.end();
    });
  });
}
