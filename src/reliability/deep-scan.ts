import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DeepScanResult {
  touchedFiles: string[];
  configCandidates: string[];
  durationMs: number;
}

export interface DeepScanOptions {
  workspaceDir: string;
  maxFiles: number;
  maxDurationMs: number;
}

export class DeepScanService {
  constructor(private readonly options: DeepScanOptions) {}

  async scanRecentlyTouched(args?: {
    hours?: number;
    additionalFiles?: string[];
  }): Promise<DeepScanResult> {
    const start = Date.now();
    const hours = Math.max(1, args?.hours ?? 24);
    const since = `${hours} hours ago`;
    const gitFiles = await this.readGitTouchedFiles(since);
    const combined = new Set<string>(gitFiles);
    for (const file of args?.additionalFiles ?? []) {
      combined.add(file);
    }
    const touchedFiles = [...combined].slice(0, this.options.maxFiles);
    const configCandidates = touchedFiles.filter((file) =>
      /(config|\.env|docker|compose|toml|yaml|yml|json|Makefile|package\.json|tsconfig|openclaw\.json)/i.test(
        file
      )
    );
    return {
      touchedFiles,
      configCandidates,
      durationMs: Date.now() - start
    };
  }

  private async readGitTouchedFiles(since: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", `--since=${since}`, "--name-only", "--pretty=format:"],
        {
          cwd: this.options.workspaceDir,
          timeout: this.options.maxDurationMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        }
      );
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }
}
