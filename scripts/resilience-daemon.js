#!/usr/bin/env node
/**
 * Resilience daemon: watches for tmp/last-build-failure.log (written by
 * run-with-restart when the build fails). When it appears, optionally runs a
 * configurable recovery command (e.g. a script that invokes Cursor CLI to fix
 * the build). If the command exits 0, writes tmp/recovery-done so the
 * run-with-restart wrapper's build-recovery-wait can retry the build.
 *
 * This process does not depend on the main CursorClaw server, so recovery can
 * happen when the app never starts.
 *
 * With --watch (used by npm run start:watch): the daemon is the top-level
 * supervisor. It spawns run-with-restart.js with RESILIENCE_DAEMON=0 and
 * restarts it whenever it exits (crash, build-failure timeout, or restart).
 * So the daemon never runs server code and does not exit when the server
 * crashes; it only restarts the wrapper, which then builds and starts the server.
 *
 * Usage:
 *   node scripts/resilience-daemon.js           — poll-only mode (build failure recovery).
 *   node scripts/resilience-daemon.js --watch   — supervisor mode: run server wrapper and restart on exit.
 *
 * Optional env:
 *   RECOVERY_CMD: command when failure log appears (default when used by start:watch: fix-build script). Set "" or "0" to disable.
 *   RESILIENCE_POLL_MS: poll interval (default 15000 = 15s).
 *   CRASH_RESTART_DELAY_MS: delay before restarting wrapper after exit (default 2000). Used in --watch mode.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(__dirname, "..");
const tmpDir = path.join(cwd, "tmp");
const failureLogPath = path.join(tmpDir, "last-build-failure.log");
const recoveryDonePath = path.join(tmpDir, "recovery-done");
const pollMs = Number(process.env.RESILIENCE_POLL_MS) || 15_000;
const recoveryCmd = process.env.RECOVERY_CMD;
const crashRestartDelayMs = Math.max(0, Number(process.env.CRASH_RESTART_DELAY_MS) || 2_000);
const watchMode = process.argv.includes("--watch");

const runWithRestartScript = path.join(__dirname, "run-with-restart.js");
const defaultRecoveryCmd =
  process.env.RECOVERY_CMD === "0" || process.env.RECOVERY_CMD === "" || process.env.RECOVERY_CMD === "false"
    ? process.env.RECOVERY_CMD
    : (process.env.RECOVERY_CMD || "node scripts/fix-build-with-cursor-agent.js");

function runCommand(cmd) {
  const [head, ...rest] = cmd.trim().split(/\s+/);
  return new Promise((resolve) => {
    const child = spawn(head, rest, { cwd, stdio: "inherit", shell: true });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function pollOnce() {
  try {
    if (!fs.existsSync(failureLogPath)) return;
    if (!fs.existsSync(tmpDir)) return;
    const recoveryCmdToRun = (watchMode ? defaultRecoveryCmd : recoveryCmd)?.trim();
    if (recoveryCmdToRun && recoveryCmdToRun !== "0" && recoveryCmdToRun !== "false") {
      console.error("[CursorClaw resilience-daemon] Build failure detected; running RECOVERY_CMD...");
      const code = await runCommand(recoveryCmdToRun);
      if (code === 0) {
        fs.writeFileSync(recoveryDonePath, "", "utf8");
        try {
          if (fs.existsSync(failureLogPath)) fs.unlinkSync(failureLogPath);
          const failureJsonPath = path.join(tmpDir, "last-build-failure.json");
          if (fs.existsSync(failureJsonPath)) fs.unlinkSync(failureJsonPath);
        } catch (_) {}
        console.error("[CursorClaw resilience-daemon] RECOVERY_CMD succeeded; wrote tmp/recovery-done and cleared failure artifacts.");
      }
    } else if (!watchMode) {
      console.error("[CursorClaw resilience-daemon] Build failure file present. Fix the build and create tmp/recovery-done, or set RECOVERY_CMD.");
    }
  } catch (err) {
    console.error("[CursorClaw resilience-daemon]", err.message);
  }
}

function runWrapper() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [runWithRestartScript], {
        cwd,
        stdio: "inherit",
        env: { ...process.env, RESILIENCE_DAEMON: "0" }
      });
    } catch (err) {
      console.error("[CursorClaw resilience-daemon] Wrapper spawn failed:", err.message);
      resolve(1);
      return;
    }
    child.on("error", (err) => {
      console.error("[CursorClaw resilience-daemon] Wrapper failed to start:", err.message);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function supervisorLoop() {
  for (;;) {
    try {
      const code = await runWrapper();
      console.error("[CursorClaw resilience-daemon] Wrapper exited (code=%s). Restarting in %d ms...", code, crashRestartDelayMs);
      await new Promise((r) => setTimeout(r, crashRestartDelayMs));
    } catch (err) {
      console.error("[CursorClaw resilience-daemon] Error in supervisor loop:", err.message);
      if (err.stack) console.error(err.stack);
      console.error("[CursorClaw resilience-daemon] Restarting wrapper in %d ms...", crashRestartDelayMs);
      await new Promise((r) => setTimeout(r, crashRestartDelayMs));
    }
  }
}

async function main() {
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  if (watchMode) {
    console.error("[CursorClaw resilience-daemon] Supervisor mode: running server wrapper (restart on exit). Build failure recovery enabled.\n");
    const pollInterval = setInterval(() => { pollOnce().catch((e) => console.error("[CursorClaw resilience-daemon] Poll error:", e.message)); }, pollMs);
    pollOnce().catch((e) => console.error("[CursorClaw resilience-daemon] Poll error:", e.message));
    await supervisorLoop();
    clearInterval(pollInterval);
    return;
  }

  for (;;) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

process.on("uncaughtException", (err) => {
  console.error("[CursorClaw resilience-daemon] uncaughtException:", err.message);
  if (err.stack) console.error(err.stack);
  // Do not exit: daemon must keep running to restart the wrapper.
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[CursorClaw resilience-daemon] unhandledRejection:", reason);
  // Do not exit: daemon must keep running to restart the wrapper.
});

main().catch((err) => {
  console.error("[CursorClaw resilience-daemon] Fatal in main:", err.message);
  if (err.stack) console.error(err.stack);
  // In watch mode, supervisorLoop never returns; if we get here, retry starting the loop.
  if (watchMode) {
    console.error("[CursorClaw resilience-daemon] Retrying supervisor loop in %d ms...", crashRestartDelayMs);
    setTimeout(() => {
      supervisorLoop().catch((e) => {
        console.error("[CursorClaw resilience-daemon] Supervisor retry failed:", e.message);
        setTimeout(main, crashRestartDelayMs);
      });
    }, crashRestartDelayMs);
  } else {
    process.exitCode = 1;
  }
});
