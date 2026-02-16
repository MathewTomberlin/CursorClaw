#!/usr/bin/env node
/**
 * Wrapper that runs `npm start` and restarts it in the same terminal when the
 * framework requests a restart (exit code 42) or when the server crashes
 * (non-zero exit other than 42). Use this so "Restart framework" in the UI
 * restarts the process, and so crashes are auto-recovered with a build + restart.
 *
 * On build failure: writes tmp/last-build-failure.log and .json, then runs
 * scripts/build-recovery-wait.js which waits for tmp/recovery-done (or timeout)
 * and retries the build. If the retry succeeds, the wrapper continues and
 * restarts the app in the same terminal. See docs/resilience.md §6.
 *
 * Optional env: CRASH_RESTART_DELAY_MS — delay in ms before restart after a
 * crash (default 2000). Set to 0 to restart immediately.
 *
 * When using npm run start:watch, the resilience daemon (resilience-daemon.js --watch)
 * invokes this script with RESILIENCE_DAEMON=0. You can also run this script directly.
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
/** When present, server is not running (build failed or recovery timeout). Remove when server listens. */
const serverDownPath = path.join(tmpDir, "server-down");

const runResilienceDaemon = process.env.RESILIENCE_DAEMON !== "0" && process.env.RESILIENCE_DAEMON !== "false";
const crashRestartDelayMs = Math.max(0, Number(process.env.CRASH_RESTART_DELAY_MS) || 2_000);
let resilienceDaemonChild = null;

function startResilienceDaemon() {
  if (!runResilienceDaemon || resilienceDaemonChild) return;
  const daemonScript = path.join(__dirname, "resilience-daemon.js");
  const envRecoveryCmd =
    process.env.RECOVERY_CMD === "0" ||
    process.env.RECOVERY_CMD === "" ||
    process.env.RECOVERY_CMD === "false"
      ? process.env.RECOVERY_CMD
      : (process.env.RECOVERY_CMD || "node scripts/fix-build-with-cursor-agent.js");
  resilienceDaemonChild = spawn(process.execPath, [daemonScript], {
    cwd,
    stdio: "ignore",
    env: { ...process.env, RECOVERY_CMD: envRecoveryCmd }
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

process.on("uncaughtException", (err) => {
  console.error("[CursorClaw] uncaughtException:", err.message);
  if (err.stack) console.error(err.stack);
  stopResilienceDaemon();
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[CursorClaw] unhandledRejection:", reason);
  stopResilienceDaemon();
  process.exit(1);
});

(async () => {
  try {
    startResilienceDaemon();
  } catch (e) {
    console.error("[CursorClaw] Failed to start resilience daemon:", e.message);
  }
  const onExit = () => {
    stopResilienceDaemon();
    process.exit(process.exitCode ?? 0);
  };
  process.on("SIGINT", () => {
    process.exitCode = 130;
    onExit();
  });
  process.on("SIGTERM", onExit);

  const isUserStop = (code, signal) =>
    code === 130 || code === 0 || signal === "SIGINT" || signal === "SIGTERM";

  async function buildAndRestart(reason) {
    console.log("\n[CursorClaw] " + reason + "\n");
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
      fs.writeFileSync(
        serverDownPath,
        "Build failed; server not started. Fix errors, then create tmp/recovery-done to retry.\n",
        "utf8"
      );
      console.error("\n[CursorClaw] Build failed. Failure written to tmp/last-build-failure.log.");
      console.error("[CursorClaw] tmp/server-down written — gateway is not reachable until build succeeds and app restarts.");
      console.error("[CursorClaw] Fix the build and create tmp/recovery-done to retry in this terminal, or run build-recovery-wait manually.\n");
      const recoveryScriptPath = path.join(__dirname, "build-recovery-wait.js");
      const { code: recoveryCode } = await run("node", [recoveryScriptPath]);
      if (recoveryCode === 0) {
        try {
          if (fs.existsSync(buildFailureLogPath)) fs.unlinkSync(buildFailureLogPath);
          if (fs.existsSync(buildFailureJsonPath)) fs.unlinkSync(buildFailureJsonPath);
          if (fs.existsSync(serverDownPath)) fs.unlinkSync(serverDownPath);
        } catch (_) {}
        console.log("\n[CursorClaw] Build succeeded after recovery; restarting app.\n");
        return true;
      }
      console.error("[CursorClaw] Gateway remains unreachable (tmp/server-down present). Fix build and create tmp/recovery-done, or run build-recovery-wait.\n");
      process.exitCode = recoveryCode != null ? recoveryCode : buildCode;
      stopResilienceDaemon();
      return false;
    }
    return true;
  }

  const recoveryScript = path.join(__dirname, "build-recovery-wait.js");

  for (;;) {
    try {
      if (fs.existsSync(serverDownPath)) {
        console.log("\n[CursorClaw] tmp/server-down present (previous build failed). Waiting for recovery, then retrying build...\n");
        const { code: recoveryCode } = await run("node", [recoveryScript]);
        if (recoveryCode !== 0) {
          console.error("[CursorClaw] Build recovery failed or timed out. Exiting so supervisor can restart.\n");
          process.exitCode = recoveryCode != null ? recoveryCode : 1;
          stopResilienceDaemon();
          break;
        }
        try {
          if (fs.existsSync(serverDownPath)) fs.unlinkSync(serverDownPath);
          if (fs.existsSync(buildFailureLogPath)) fs.unlinkSync(buildFailureLogPath);
          if (fs.existsSync(buildFailureJsonPath)) fs.unlinkSync(buildFailureJsonPath);
        } catch (_) {}
        console.log("\n[CursorClaw] Build succeeded; starting server.\n");
      }
      const { code, signal } = await run("npm", ["start"]);
      if (code === RESTART_EXIT_CODE) {
        const ok = await buildAndRestart("Building and restarting in same terminal...");
        if (!ok) break;
        continue;
      }
      if (isUserStop(code, signal)) {
        process.exitCode = code != null ? code : 0;
        if (signal) process.kill(process.pid, signal);
        stopResilienceDaemon();
        break;
      }
      // Crash or unexpected exit: build and restart (resilience daemon can run Cursor-Agent to fix if build fails)
      if (crashRestartDelayMs > 0) {
        console.error("\n[CursorClaw] Server exited unexpectedly (code=%s, signal=%s). Restarting in %d ms...\n", code, signal ?? "none", crashRestartDelayMs);
        await new Promise((r) => setTimeout(r, crashRestartDelayMs));
      } else {
        console.error("\n[CursorClaw] Server exited unexpectedly (code=%s, signal=%s). Building and restarting...\n", code, signal ?? "none");
      }
      const ok = await buildAndRestart("Building and restarting after crash...");
      if (!ok) break;
    } catch (err) {
      // Any thrown error (e.g. from run() or buildAndRestart): treat like a crash — delay, rebuild, restart.
      // Prevents a single exception from exiting the wrapper; when under start:watch the daemon would
      // restart us, but retrying here keeps one process and avoids losing in-memory state.
      console.error("[CursorClaw] Error in restart loop:", err.message);
      if (err.stack) console.error(err.stack);
      if (crashRestartDelayMs > 0) {
        console.error("[CursorClaw] Retrying in %d ms...\n", crashRestartDelayMs);
        await new Promise((r) => setTimeout(r, crashRestartDelayMs));
      }
      const ok = await buildAndRestart("Building and restarting after error...");
      if (!ok) break;
    }
  }
})().catch((err) => {
  console.error("[CursorClaw] Fatal error in wrapper:", err.message);
  stopResilienceDaemon();
  process.exitCode = 1;
});
