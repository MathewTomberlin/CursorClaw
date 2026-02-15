#!/usr/bin/env node
/**
 * Cross-platform runner for after-merge: checkout main, pull, remove merged branch refs.
 * Runs scripts/after-merge.ps1 on Windows, scripts/after-merge.sh otherwise.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const isWindows = process.platform === "win32";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

if (isWindows) {
  spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "after-merge.ps1")], {
    stdio: "inherit",
    shell: false,
    cwd: root,
  }).on("exit", (code) => process.exit(code ?? 0));
} else {
  spawn("bash", [path.join(__dirname, "after-merge.sh")], {
    stdio: "inherit",
    shell: false,
    cwd: root,
  }).on("exit", (code) => process.exit(code ?? 0));
}
