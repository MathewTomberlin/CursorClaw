#!/usr/bin/env node
/**
 * Wrapper that runs `npm start` and restarts it in the same terminal when the
 * framework requests a restart (exit code 42). Use this so "Restart framework"
 * in the UI restarts the process in the same terminal without closing it.
 *
 * On build failure: writes tmp/last-build-failure.log and .json, then runs
 * scripts/build-recovery-wait.js which waits for tmp/recovery-done (or timeout)
 * and retries the build. If the retry succeeds, the wrapper continues and
 * restarts the app in the same terminal. See docs/resilience.md §6.
 *
 * Usage: npm run start:watch
 *
 * Exit code 42 must match RESTART_EXIT_CODE in src/index.ts.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESTART_EXIT_CODE = 42;
const cwd = path.resolve(__dirname, "..");
const tmpDir = path.join(cwd, "tmp");
const buildFailureLogPath = path.join(tmpDir, "last-build-failure.log");
const buildFailureJsonPath = path.join(tmpDir, "last-build-failure.json");

const runResilienceDaemon = process.env.RESILIENCE_DAEMON !== "0" && process.env.RESILIENCE_DAEMON !== "false";
let resilienceDaemonChild = null;

function startResilienceDaemon() {
  if (!runResilienceDaemon || resilienceDaemonChild) return;
  const daemonScript = path.join(__dirname, "resilience-daemon.js");
  resilienceDaemonChild = spawn(process.execPath, [daemonScript], {
    cwd,
    stdio: "ignore",
    env: { ...process.env }
  });
  resilienceDaemonChild.on("error", (err) => {
    console.error("[CursorClaw] Resilience daemon failed to start:", err.message);
  });
  resilienceDaemonChild.unref();
  console.log("[CursorClaw] Resilience daemon started (polling for build failures). Set RESILIENCE_DAEMON=0 to disable.\n");
}

function stopResilienceDaemon() {
  if (resilienceDaemonChild) {
    try {
      resilienceDaemonChild.kill();
    } catch (_) {}
    resilienceDaemonChild = null;
  }
}

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
      if (options.capture) {
        resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr });
      } else {
        if (signal) resolve({ code: null, signal });
        else resolve({ code, signal: null });
      }
    });
  });
}

(async () => {
  startResilienceDaemon();
  const onExit = () => {
    stopResilienceDaemon();
    process.exit(process.exitCode ?? 0);
  };
  process.on("SIGINT", () => {
    process.exitCode = 130;
    onExit();
  });
  process.on("SIGTERM", onExit);

  for (;;) {
    const { code, signal } = await run("npm", ["start"]);
    if (code === RESTART_EXIT_CODE) {
      console.log("\n[CursorClaw] Building and restarting in same terminal...\n");
      const { code: buildCode, stdout, stderr } = await run("npm", ["run", "build"], { capture: true });
      if (buildCode !== 0) {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        const out = [stdout, stderr].filter(Boolean).join("\n") || "Build failed (no output captured).";
        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true });
        }
        fs.writeFileSync(buildFailureLogPath, out, "utf8");
        fs.writeFileSync(
          buildFailureJsonPath,
          JSON.stringify({ timestamp: new Date().toISOString(), exitCode: buildCode }, null, 2),
          "utf8"
        );
        console.error("\n[CursorClaw] Build failed. Failure written to tmp/last-build-failure.log.");
        console.error("[CursorClaw] Fix the build and create tmp/recovery-done to retry in this terminal, or run build-recovery-wait manually.\n");
        const recoveryScript = path.join(__dirname, "build-recovery-wait.js");
        const { code: recoveryCode } = await run("node", [recoveryScript]);
        if (recoveryCode === 0) {
          try {
            if (fs.existsSync(buildFailureLogPath)) fs.unlinkSync(buildFailureLogPath);
            if (fs.existsSync(buildFailureJsonPath)) fs.unlinkSync(buildFailureJsonPath);
          } catch (_) {}
          console.log("\n[CursorClaw] Build succeeded after recovery; restarting app.\n");
          continue;
        }
        process.exitCode = recoveryCode != null ? recoveryCode : buildCode;
        stopResilienceDaemon();
        break;
      }
      continue;
    }
    process.exitCode = code != null ? code : 1;
    if (signal) process.kill(process.pid, signal);
    stopResilienceDaemon();
    break;
  }
})();
