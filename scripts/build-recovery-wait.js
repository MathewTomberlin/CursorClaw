#!/usr/bin/env node
/**
 * After a build failure, the start:watch wrapper runs this script. It waits for
 * tmp/recovery-done to appear (or timeout), then runs `npm run build` once and
 * exits with the build's exit code. The wrapper uses exit 0 to continue the
 * restart loop so the server can come back in the same terminal.
 *
 * Usage: node scripts/build-recovery-wait.js
 * Optional env: BUILD_RECOVERY_TIMEOUT_MS (default 600000 = 10 minutes).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(__dirname, "..");
const tmpDir = path.join(cwd, "tmp");
const recoveryDonePath = path.join(tmpDir, "recovery-done");
const buildFailureLogPath = path.join(tmpDir, "last-build-failure.log");
const buildFailureJsonPath = path.join(tmpDir, "last-build-failure.json");
const serverDownPath = path.join(tmpDir, "server-down");
const timeoutMs = Number(process.env.BUILD_RECOVERY_TIMEOUT_MS) || 600_000;
const pollMs = 2_000;

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: true
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr });
    });
  });
}

async function waitForRecovery() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(recoveryDonePath)) {
        fs.unlinkSync(recoveryDonePath);
        return true;
      }
    } catch (_) {
      // ignore
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

(async () => {
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const found = await waitForRecovery();
  if (!found) {
    console.error("\n[CursorClaw] Build recovery timeout; no tmp/recovery-done. Run build manually and fix errors.\n");
    process.exitCode = 1;
    return;
  }
  console.log("\n[CursorClaw] recovery-done found; running build...\n");
  const { code, stdout, stderr } = await run("npm", ["run", "build"], { capture: true });
  if (code !== 0) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const out = [stdout, stderr].filter(Boolean).join("\n") || "Build failed (no output captured).";
    try {
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(buildFailureLogPath, out, "utf8");
      fs.writeFileSync(
        buildFailureJsonPath,
        JSON.stringify({ timestamp: new Date().toISOString(), exitCode: code }, null, 2),
        "utf8"
      );
      fs.writeFileSync(
        serverDownPath,
        "Build failed after recovery; daemon can run RECOVERY_CMD again.\n",
        "utf8"
      );
    } catch (_) {}
  }
  process.exitCode = code !== 0 ? code : 0;
})();
