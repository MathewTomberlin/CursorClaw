import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DecisionJournal } from "../decision-journal.js";

const execFileAsync = promisify(execFile);

export interface GitCheckpointHandle {
  refName: string;
  commit: string;
  createdAt: string;
}

export interface GitCheckpointManagerOptions {
  workspaceDir: string;
  reliabilityCheckCommands: string[];
  commandTimeoutMs: number;
  decisionJournal?: DecisionJournal;
}

export class GitCheckpointManager {
  constructor(private readonly options: GitCheckpointManagerOptions) {}

  async createCheckpoint(runId: string): Promise<GitCheckpointHandle | null> {
    if (!(await this.isGitRepository())) {
      return null;
    }
    if (await this.hasDirtyWorktree()) {
      await this.options.decisionJournal?.append({
        type: "checkpoint-skipped",
        summary: "Skipped git checkpoint due to dirty worktree",
        metadata: { runId }
      });
      return null;
    }
    const commit = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    const sanitizedRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const refName = `checkpoint/${sanitizedRunId}-${Date.now()}`;
    await this.git(["branch", "-f", refName, commit]);
    const handle: GitCheckpointHandle = {
      refName,
      commit,
      createdAt: new Date().toISOString()
    };
    await this.options.decisionJournal?.append({
      type: "checkpoint-created",
      summary: `Created git checkpoint ${refName}`,
      metadata: { runId, commit }
    });
    return handle;
  }

  async rollback(handle: GitCheckpointHandle): Promise<void> {
    await this.git(["reset", "--hard", handle.refName]);
    await this.options.decisionJournal?.append({
      type: "checkpoint-rollback",
      summary: `Rolled back to ${handle.refName}`,
      metadata: {
        commit: handle.commit
      }
    });
  }

  async verifyReliabilityChecks(): Promise<{ ok: boolean; failedCommand?: string }> {
    for (const command of this.options.reliabilityCheckCommands) {
      try {
        await execFileAsync("/bin/bash", ["-lc", command], {
          cwd: this.options.workspaceDir,
          timeout: this.options.commandTimeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        });
      } catch {
        return {
          ok: false,
          failedCommand: command
        };
      }
    }
    return { ok: true };
  }

  async cleanup(handle: GitCheckpointHandle): Promise<void> {
    try {
      await this.git(["branch", "-D", handle.refName]);
      await this.options.decisionJournal?.append({
        type: "checkpoint-cleanup",
        summary: `Deleted git checkpoint ${handle.refName}`
      });
    } catch {
      // If cleanup fails, we still keep runtime flow uninterrupted.
    }
  }

  private async isGitRepository(): Promise<boolean> {
    try {
      const out = await this.git(["rev-parse", "--is-inside-work-tree"]);
      return out.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async hasDirtyWorktree(): Promise<boolean> {
    const out = await this.git(["status", "--porcelain"]);
    return out.stdout.trim().length > 0;
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", args, {
      cwd: this.options.workspaceDir,
      timeout: this.options.commandTimeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
  }
}
