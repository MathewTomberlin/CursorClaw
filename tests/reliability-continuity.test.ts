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

  it("does not escalate when failure signatures differ", () => {
    const guard = new FailureLoopGuard({
      escalationThreshold: 2
    });
    guard.recordFailure("s1", new Error("network timeout"));
    guard.recordFailure("s1", new Error("schema validation failed"));
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

  it("recovers from pre-existing corrupted journal content and appends new entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-journal-corrupt-"));
    tempDirs.push(dir);
    const journalPath = join(dir, "CLAW_HISTORY.log");
    await writeFile(journalPath, "\u0000\u0001corrupted-prefix\n", "utf8");
    const journal = new DecisionJournal({
      path: journalPath,
      maxBytes: 1024 * 1024
    });
    await journal.append({
      type: "decision",
      summary: "post-corruption-entry"
    });
    const lines = await journal.readRecent(5);
    expect(lines.some((line) => line.includes("post-corruption-entry"))).toBe(true);
  });

  it("readEntriesForReplay respects mode count (same as readRecent)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-journal-replay-"));
    tempDirs.push(dir);
    const journal = new DecisionJournal({
      path: join(dir, "CLAW_HISTORY.log"),
      maxBytes: 1024 * 1024
    });
    await journal.append({ type: "d", summary: "a" });
    await journal.append({ type: "d", summary: "b" });
    await journal.append({ type: "d", summary: "c" });
    const lines = await journal.readEntriesForReplay({ limit: 2, mode: "count" });
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("b");
    expect(lines[1]).toContain("c");
  });

  it("readEntriesForReplay mode sinceHours returns only entries within window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-journal-sinceHours-"));
    tempDirs.push(dir);
    const path = join(dir, "CLAW_HISTORY.log");
    const now = new Date();
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    await writeFile(
      path,
      [
        JSON.stringify({ at: old.toISOString(), type: "old", summary: "old" }),
        JSON.stringify({ at: now.toISOString(), type: "new", summary: "new" })
      ].join("\n") + "\n",
      "utf8"
    );
    const journal = new DecisionJournal({ path, maxBytes: 1024 * 1024 });
    const lines = await journal.readEntriesForReplay({
      limit: 10,
      mode: "sinceHours",
      sinceHours: 24,
      maxEntries: 100
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("new");
  });

  it("readEntriesForReplay mode sinceLastSession returns entries after sessionStartMs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-journal-sinceSession-"));
    tempDirs.push(dir);
    const path = join(dir, "CLAW_HISTORY.log");
    const sessionStart = Date.now() - 10_000;
    const before = sessionStart - 5_000;
    const after = sessionStart + 5_000;
    await writeFile(
      path,
      [
        JSON.stringify({ at: new Date(before).toISOString(), type: "before", summary: "before" }),
        JSON.stringify({ at: new Date(after).toISOString(), type: "after", summary: "after" })
      ].join("\n") + "\n",
      "utf8"
    );
    const journal = new DecisionJournal({ path, maxBytes: 1024 * 1024 });
    const lines = await journal.readEntriesForReplay({
      limit: 10,
      mode: "sinceLastSession",
      sessionStartMs: sessionStart,
      maxEntries: 100
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("after");
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

  it("throttles repeated proactive suggestions per channel", () => {
    const engine = new ProactiveSuggestionEngine(60_000);
    const first = engine.suggestForChannel(
      "dm:u1",
      {
        files: ["src/auth/session.ts"]
      },
      100_000
    );
    const second = engine.suggestForChannel(
      "dm:u1",
      {
        files: ["src/auth/session.ts"]
      },
      100_500
    );
    const third = engine.suggestForChannel(
      "dm:u1",
      {
        files: ["src/auth/session.ts"]
      },
      161_000
    );
    expect(first.suggestions.length).toBeGreaterThan(0);
    expect(second.throttled).toBe(true);
    expect(second.suggestions.length).toBe(0);
    expect(third.throttled).toBe(false);
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
    const contentAfterRollback = (await readFile(filePath, "utf8")).replace(/\r\n/g, "\n");
    expect(contentAfterRollback).toBe("original\n");
    await manager.cleanup(checkpoint);
    await expect(execFileAsync("git", ["rev-parse", "--verify", checkpoint.refName], { cwd: dir })).rejects.toThrow();

    await writeFile(filePath, "dirty\n", "utf8");
    const skipped = await manager.createCheckpoint("run-2");
    expect(skipped).toBeNull();
  });

  it("reports reliability check failures for checkpoint validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-checkpoint-verify-"));
    tempDirs.push(dir);
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "ci@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "CI Bot"], { cwd: dir });
    await writeFile(join(dir, "demo.txt"), "ok\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });

    const manager = new GitCheckpointManager({
      workspaceDir: dir,
      reliabilityCheckCommands: ["exit 1"],
      commandTimeoutMs: 10_000
    });
    const result = await manager.verifyReliabilityChecks();
    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe("exit 1");
  });
});
