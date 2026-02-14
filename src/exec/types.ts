/**
 * Abstraction for executing commands. Default implementation runs on the host
 * via child_process; future implementations could use a sandbox (e.g. bubblewrap)
 * or restricted user. See HostExecSandbox and docs.
 */
export interface ExecSandboxOptions {
  timeoutMs?: number;
  maxBufferBytes: number;
  cwd?: string;
}

export interface ExecSandboxResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecSandbox {
  run(
    command: string,
    args: string[],
    options: ExecSandboxOptions
  ): Promise<ExecSandboxResult>;
}
