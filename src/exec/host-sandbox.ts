import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ExecSandbox, ExecSandboxOptions, ExecSandboxResult } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Runs commands on the host via child_process.execFile. No OS-level sandbox;
 * use strict allowlist and approval policy. A future BubblewrapExecSandbox or
 * similar could be plugged in for stronger isolation.
 */
export class HostExecSandbox implements ExecSandbox {
  async run(
    command: string,
    args: string[],
    options: ExecSandboxOptions
  ): Promise<ExecSandboxResult> {
    const { timeoutMs = 15_000, maxBufferBytes, cwd } = options;
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: maxBufferBytes
    });
    return {
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      code: 0
    };
  }
}
