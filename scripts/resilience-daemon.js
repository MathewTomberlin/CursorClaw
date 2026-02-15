#!/usr/bin/env node
/**
 * Resilience daemon: watches for tmp/last-build-failure.log (written by
 * start:watch when the build fails). When it appears, optionally runs a
 * configurable recovery command (e.g. a script that invokes Cursor CLI to fix
 * the build). If the command exits 0, writes tmp/recovery-done so the
 * start:watch wrapper's build-recovery-wait can retry the build.
 *
 * This process does not depend on the main CursorClaw server, so recovery can
 * happen when the app never starts.
 *
 * Usage: node scripts/resilience-daemon.js
 *   Optional env:
 *   - RECOVERY_CMD: command to run when failure log appears (e.g. "node scripts/fix-build.js").
 *     If unset, the daemon only logs; you can fix manually and create tmp/recovery-done.
 *   - RESILIENCE_POLL_MS: poll interval (default 15000 = 15s).
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

function runCommand(cmd) {
  const [head, ...rest] = cmd.trim().split(/\s+/);
  return new Promise((resolve) => {
    const child = spawn(head, rest, { cwd, stdio: "inherit", shell: true });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function once() {
  try {
    if (!fs.existsSync(failureLogPath)) return;
    if (!fs.existsSync(tmpDir)) return;
    const recoveryCmdToRun = recoveryCmd?.trim();
    if (recoveryCmdToRun) {
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
    } else {
      console.error("[CursorClaw resilience-daemon] Build failure file present. Fix the build and create tmp/recovery-done, or set RECOVERY_CMD.");
    }
  } catch (err) {
    console.error("[CursorClaw resilience-daemon]", err.message);
  }
}

(async () => {
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  for (;;) {
    await once();
    await new Promise((r) => setTimeout(r, pollMs));
  }
})();
