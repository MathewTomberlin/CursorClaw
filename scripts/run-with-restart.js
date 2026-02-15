#!/usr/bin/env node
/**
 * Wrapper that runs `npm start` and restarts it in the same terminal when the
 * framework requests a restart (exit code 42). Use this so "Restart framework"
 * in the UI restarts the process in the same terminal without closing it.
 *
 * Usage: npm run start:watch
 *
 * Exit code 42 must match RESTART_EXIT_CODE in src/index.ts.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESTART_EXIT_CODE = 42;
const cwd = path.resolve(__dirname, "..");

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: true
    });
    child.on("close", (code, signal) => {
      if (signal) resolve({ code: null, signal });
      else resolve({ code, signal: null });
    });
  });
}

(async () => {
  for (;;) {
    const { code, signal } = await run("npm", ["start"]);
    if (code === RESTART_EXIT_CODE) {
      console.log("\n[CursorClaw] Building and restarting in same terminal...\n");
      const { code: buildCode } = await run("npm", ["run", "build"]);
      if (buildCode !== 0) {
        console.error("\n[CursorClaw] Build failed; not restarting. Fix errors and run again.\n");
        process.exitCode = buildCode;
        break;
      }
      continue;
    }
    process.exitCode = code != null ? code : 1;
    if (signal) process.kill(process.pid, signal);
    break;
  }
})();
