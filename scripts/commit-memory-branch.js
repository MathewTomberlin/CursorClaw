#!/usr/bin/env node
/**
 * Commits agent memory and log files to the branch `agent-memory` so they are
 * not included in main/source pushes. Run this when you want to back up or
 * version agent state separately. Push the branch to a different remote (or
 * keep it local) so main stays clean.
 *
 * Usage: npm run commit-memory
 * Requires: MEMORY.md, memory/, CLAW_HISTORY.log are in .gitignore (they are
 * force-added only to this branch).
 */

const { execSync } = require("node:child_process");
const path = require("node:path");

const cwd = path.resolve(__dirname, "..");
const branch = "agent-memory";
const paths = ["MEMORY.md", "memory/", "CLAW_HISTORY.log"];

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd, encoding: "utf8", ...opts });
}

function runOptional(cmd) {
  try {
    return run(cmd);
  } catch {
    return null;
  }
}

const currentBranch = run("git rev-parse --abbrev-ref HEAD").trim();
if (currentBranch === branch) {
  console.error("Already on agent-memory branch. Switch to main first: git checkout main");
  process.exit(1);
}

// Create branch if it doesn't exist, then check it out
if (!runOptional(`git rev-parse --verify ${branch}`)) {
  run(`git branch ${branch}`);
}
run(`git checkout ${branch}`);

try {
  run(`git add -f ${paths.join(" ")}`);
  const status = runOptional("git status --short");
  if (!status || !status.trim()) {
    console.log("No changes in agent memory files.");
  } else {
    run('git commit -m "chore: agent memory snapshot"');
    console.log("Committed agent memory to branch agent-memory.");
  }
} finally {
  run(`git checkout ${currentBranch}`);
}

console.log("Back on branch:", currentBranch);
console.log("To push agent memory elsewhere: git push <remote> agent-memory");
