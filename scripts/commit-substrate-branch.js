#!/usr/bin/env node
/**
 * Commits substrate and planning files to the branch `agent-substrate` so they are
 * not included in main/source pushes. Run when you want to back up or version
 * agent substrate (AGENTS.md, IDENTITY.md, SOUL.md, etc.), ROADMAP.md, and STUDY_GOALS.md separately.
 * Push the branch to a different remote (or keep it local) so main stays clean.
 *
 * Usage: npm run commit-substrate
 * Requires: Substrate files, ROADMAP.md, and STUDY_GOALS.md are in .gitignore (they are
 * force-added only to this branch).
 */

const { execSync } = require("node:child_process");
const path = require("node:path");

const cwd = path.resolve(__dirname, "..");
const branch = "agent-substrate";
const paths = [
  "AGENTS.md",
  "BIRTH.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "USER.md",
  "SOUL.md",
  "TOOLS.md",
  "CAPABILITIES.md",
  "ROADMAP.md",
  "STUDY_GOALS.md"
];

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
  console.error("Already on agent-substrate branch. Switch to main first: git checkout main");
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
    console.log("No changes in substrate/ROADMAP files.");
  } else {
    run('git commit -m "chore: agent substrate and ROADMAP snapshot"');
    console.log("Committed substrate, ROADMAP, and STUDY_GOALS to branch agent-substrate.");
  }
} finally {
  run(`git checkout ${currentBranch}`);
}

console.log("Back on branch:", currentBranch);
console.log("To push substrate elsewhere: git push <remote> agent-substrate");
