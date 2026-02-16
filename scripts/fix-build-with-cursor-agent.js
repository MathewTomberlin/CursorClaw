#!/usr/bin/env node
/**
 * Recovery script for build failures: invokes the Cursor-Agent CLI to fix the
 * build using tmp/last-build-failure.log, then runs `npm run build` and
 * `npm test`. Exits 0 only when both pass, so the resilience daemon can write
 * tmp/recovery-done and the start:watch wrapper can retry and restart the server.
 *
 * Requires tmp/last-build-failure.log to exist (written by run-with-restart.js
 * when the build fails after a crash or restart).
 *
 * Optional env:
 *   CURSOR_AGENT_CMD — executable (default "cursor-agent")
 *   CURSOR_AGENT_ARGS — extra args, e.g. "--approve-mcps --force"
 *
 * Usage: node scripts/fix-build-with-cursor-agent.js
 *   Or set RECOVERY_CMD="node scripts/fix-build-with-cursor-agent.js" for the
 *   resilience daemon (this is the default when using npm run start:watch).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(__dirname, "..");
const failureLogPath = path.join(cwd, "tmp", "last-build-failure.log");

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
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

const prompt =
  "Fix the CursorClaw build. The build output and errors are in tmp/last-build-failure.log — read that file and fix the reported errors in the codebase. " +
  "When you are done, the recovery script will run `npm run build` and `npm test` to verify; only then will the server be restarted.";

async function main() {
  if (!fs.existsSync(failureLogPath)) {
    console.error("[CursorClaw fix-build] tmp/last-build-failure.log not found. Run this script when the build has already failed (e.g. after a crash/restart).");
    process.exitCode = 1;
    return;
  }

  const cmd = process.env.CURSOR_AGENT_CMD || "cursor-agent";
  const extraArgs = (process.env.CURSOR_AGENT_ARGS || "--approve-mcps --force").trim().split(/\s+/).filter(Boolean);
  const args = [...extraArgs, prompt];

  console.error("[CursorClaw fix-build] Invoking Cursor-Agent CLI to fix build (reading tmp/last-build-failure.log)...");
  const { code: agentCode } = await run(cmd, args);
  if (agentCode !== 0) {
    console.error("[CursorClaw fix-build] Cursor-Agent exited with code %s. Running build and tests anyway to check state.", agentCode);
  }

  console.error("[CursorClaw fix-build] Running npm run build...");
  const { code: buildCode, stdout: buildOut, stderr: buildErr } = await run("npm", ["run", "build"], { capture: true });
  if (buildCode !== 0) {
    if (buildOut) process.stdout.write(buildOut);
    if (buildErr) process.stderr.write(buildErr);
    console.error("[CursorClaw fix-build] Build still fails. Exit 1 so recovery-done is not written.");
    process.exitCode = 1;
    return;
  }

  console.error("[CursorClaw fix-build] Build OK. Running npm test...");
  const { code: testCode, stdout: testOut, stderr: testErr } = await run("npm", ["run", "test"], { capture: true });
  if (testCode !== 0) {
    if (testOut) process.stdout.write(testOut);
    if (testErr) process.stderr.write(testErr);
    console.error("[CursorClaw fix-build] Tests failed. Exit 1 so recovery-done is not written.");
    process.exitCode = 1;
    return;
  }

  console.error("[CursorClaw fix-build] Build and tests passed. Exit 0 — resilience daemon will write tmp/recovery-done and server will restart.");
  process.exitCode = 0;
}

main().catch((err) => {
  console.error("[CursorClaw fix-build] Fatal:", err.message);
  process.exitCode = 1;
});
