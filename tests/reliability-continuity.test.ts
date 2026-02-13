import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { DecisionJournal } from "../src/decision-journal.js";
import { ProactiveSuggestionEngine } from "../src/proactive-suggestions.js";
import { FailureLoopGuard } from "../src/reliability/failure-loop.js";
import { GitCheckpointManager } from "../src/reliability/git-checkpoint.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("reliability and continuity components", () => {
  it("tracks repeated failures and escalates multi-path reasoning trigger", () => {
    const guard = new FailureLoopGuard({
      escalationThreshold: 2
    });
    guard.recordFailure("s1", new Error("compile failed at line 10"));
    expect(guard.requiresStepBack("s1")).toBe(false);
    guard.recordFailure("s1", new Error("compile failed at line 12"));
    expect(guard.requiresStepBack("s1")).toBe(true);
    guard.recordSuccess("s1");
    expect(guard.requiresStepBack("s1")).toBe(false);
  });

  it("writes and reads decision journal entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-journal-"));
    tempDirs.push(dir);
    const journal = new DecisionJournal({
      path: join(dir, "CLAW_HISTORY.log"),
      maxBytes: 1024 * 1024
    });
    await journal.append({
      type: "decision",
      summary: "selected strategy A"
    });
    await journal.append({
      type: "decision",
      summary: "selected strategy B"
    });
    const lines = await journal.readRecent(2);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("selected strategy A");
    expect(lines[1]).toContain("selected strategy B");
  });

  it("generates proactive suggestions from changed file paths", () => {
    const engine = new ProactiveSuggestionEngine();
    const suggestions = engine.suggest({
      files: ["src/auth/session.ts", "docs/api.md", "tests/auth.spec.ts"],
      maxSuggestions: 5
    });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((item) => /auth/i.test(item))).toBe(true);
  });

  it("creates git checkpoints, rolls back on demand, and skips dirty worktree checkpoints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-checkpoint-"));
    tempDirs.push(dir);

    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "ci@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "CI Bot"], { cwd: dir });
    const filePath = join(dir, "demo.txt");
    await writeFile(filePath, "original\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });

    const manager = new GitCheckpointManager({
      workspaceDir: dir,
      reliabilityCheckCommands: [],
      commandTimeoutMs: 10_000
    });
    const checkpoint = await manager.createCheckpoint("run-1");
    expect(checkpoint).toBeTruthy();

    await writeFile(filePath, "changed\n", "utf8");
    if (!checkpoint) {
      throw new Error("checkpoint not created");
    }
    await manager.rollback(checkpoint);
    const contentAfterRollback = await readFile(filePath, "utf8");
    expect(contentAfterRollback).toBe("original\n");

    await writeFile(filePath, "dirty\n", "utf8");
    const skipped = await manager.createCheckpoint("run-2");
    expect(skipped).toBeNull();
  });
});
