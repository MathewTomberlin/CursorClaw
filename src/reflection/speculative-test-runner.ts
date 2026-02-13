import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { computeFlakyScore, type FlakyScoreResult } from "./flaky-score.js";

const execFileAsync = promisify(execFile);

export interface SpeculativeTestRunnerOptions {
  workspaceDir: string;
  command: string;
  runs: number;
  timeoutMs: number;
}

export interface SpeculativeTestResult extends FlakyScoreResult {
  outcomes: boolean[];
  command: string;
  durationMs: number;
}

export class SpeculativeTestRunner {
  constructor(private readonly options: SpeculativeTestRunnerOptions) {}

  async run(): Promise<SpeculativeTestResult> {
    const outcomes: boolean[] = [];
    const start = Date.now();
    const runs = Math.max(1, Math.min(8, this.options.runs));
    for (let index = 0; index < runs; index += 1) {
      outcomes.push(await this.runOnce());
    }
    const score = computeFlakyScore(outcomes);
    return {
      ...score,
      outcomes,
      command: this.options.command,
      durationMs: Date.now() - start
    };
  }

  private async runOnce(): Promise<boolean> {
    try {
      await execFileAsync("/bin/bash", ["-lc", this.options.command], {
        cwd: this.options.workspaceDir,
        timeout: this.options.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true
      });
      return true;
    } catch {
      return false;
    }
  }
}
