# CursorClaw resilience

How the framework behaves across code updates, process crashes, host restarts, and Tailnet usage.

## 1. Code updates and restart

- **Restart flow:** The UI or an RPC can call `admin.restart`. The gateway only allows this when the request is considered **local** (loopback or private IP; see §4). The process then exits with a special exit code (`RESTART_EXIT_CODE` = 42).
- **Wrapper:** When you run `npm run start:watch`, the **resilience daemon** runs in supervisor mode (`scripts/resilience-daemon.js --watch`). It spawns `scripts/run-with-restart.js` (the wrapper), which runs `npm start`. If the server exits with 42, the wrapper runs `npm run build` and, **only if the build succeeds**, runs `npm start` again in the same terminal. If the build fails, the wrapper exits with the build’s exit code and does **not** start the app again, so broken code is never run.
- **Hot reload without restart:** Config and substrate can be updated without restart via `config.reload` and `substrate.reload` RPCs. Restart is only required for code or gateway bind-address changes.

## 2. Process crashes

- **Auto-restart with start:watch:** When you run **`npm run start:watch`**, the **resilience daemon** is the top-level process; it spawns the wrapper (`run-with-restart.js`), which runs `npm start` in a loop. If the server **crashes**, the wrapper runs `npm run build` and, if the build succeeds, starts the server again. If the build fails, the build-failure recovery flow (§6) applies (including optional Cursor-Agent fix). If the **wrapper** itself exits (e.g. uncaught error, or build recovery timeout), the **daemon does not exit**: it restarts the wrapper after **`CRASH_RESTART_DELAY_MS`** (default 2000 ms), so the server is restarted even when the wrapper crashes. Optional env **`CRASH_RESTART_DELAY_MS`** (used by both wrapper and daemon) adds a short delay before restart; set to `0` to restart immediately.
- **Queue:** With `queueBackend: "file"` (config `session.queueBackend`), the queue is stored on disk (default `tmp/queue`). After a crash or restart, queued work is reloaded; delivery is at-least-once (duplicates are possible after a crash).
- **Run store:** Pending runs are marked as interrupted on startup (`run interrupted by process restart`) so they are not left stuck as "pending." On the first main-session turn after a restart, if any runs were interrupted, the agent’s system prompt includes a one-line notice: "Previous run was interrupted by process restart."
- **Cursor-agent-cli adapter:** Tracks a crash count for observability.

## 3. Git checkpoints and rollback

- **GitCheckpointManager** (reliability) can create checkpoints and roll back the working tree. The reliability-continuity tests cover checkpoint creation, rollback, and behavior on dirty worktrees. This supports recovering from bad code or config changes when using git.

## 4. Host restarts

- There is no automatic start on boot. The operator (or an OS service / process manager) must start the process after a host reboot.

## 5. Tailnet (Tailscale)

- **Bind address:** You can set `gateway.bindAddress` to the host’s Tailscale IP (e.g. `100.x.x.x`) so the gateway listens only on the Tailnet. Allowed values are validated (loopback, link-local, private, and Tailscale 100.64.0.0/10).
- **Restart from another device:** Requests from Tailscale IPs are treated as **local** for auth (admin/restart). `isPrivateIp()` includes 100.64.0.0–100.127.255.255, so Restart from the Dashboard on a phone or another Tailscale device works when the gateway is bound to the Tailscale IP.

## 6. Build failure on restart (recovery flow)

When you use `npm run start:watch` and the build fails (e.g. after a restart request or after a crash):

1. The wrapper writes the build output to **`tmp/last-build-failure.log`** and a summary to **`tmp/last-build-failure.json`** (timestamp, exit code). It also writes **`tmp/server-down`** with a short message so that scripts or operators can tell the gateway is **not reachable** (e.g. via Tailscale) until the build succeeds and the app restarts. The server removes `tmp/server-down` when it successfully binds (so the file is only present while the server is not listening).
2. The wrapper then runs **`node scripts/build-recovery-wait.js`**, which:
   - Waits for **`tmp/recovery-done`** to appear (or a timeout, e.g. 10 minutes).
   - When the file appears, the script deletes it, runs `npm run build` again, and exits with the build exit code (0 = success).
3. If the build succeeds after recovery, the wrapper continues its loop and starts the app again **in the same terminal**, so the server comes back without you having to be at the machine.

**How to recover when you are remote (e.g. on your phone):**

- **Option A — Agent fixes when the app is back up:** If you can get the app running once (e.g. from another terminal or after a manual fix), the **heartbeat** is instructed to prioritise `tmp/last-build-failure.log`: read it, fix the build, then write `tmp/recovery-done`. The next time you use start:watch in the failed terminal, the wrapper will see recovery-done (or you run build-recovery-wait manually after fixing), and the build will retry.
- **Option B — Fix from Cursor IDE:** Open the project in Cursor. If `tmp/last-build-failure.log` exists, fix the reported errors in code, then create the file `tmp/recovery-done` (e.g. `echo. > tmp/recovery-done` on Windows, or touch on Unix). The wrapper, when running build-recovery-wait, will then retry the build. If the wrapper is not running (terminal was closed), run `npm run build` and then `npm run start:watch` again.
- **Option C — Resilience daemon and Cursor-Agent fix:** When you run **`npm run start:watch`**, the **resilience daemon** is the main process (supervisor mode). It spawns the wrapper with **`RESILIENCE_DAEMON=0`** so the wrapper does not start a second daemon. You can also run **`npm run resilience:daemon`** (without `--watch`) in a separate terminal for build-failure recovery only (no server supervision). The daemon polls for `tmp/last-build-failure.log`. When the file appears, it runs **`RECOVERY_CMD`** if set (default in supervisor mode: **`node scripts/fix-build-with-cursor-agent.js`**). That script invokes the **Cursor-Agent CLI** to fix the build using the failure log, then runs `npm run build` and `npm test`; it exits 0 only when both pass. When the command exits 0, the daemon writes `tmp/recovery-done`, so the start:watch terminal’s build-recovery-wait can retry the build. The daemon does not depend on the main server. Set **`RECOVERY_CMD=0`** (or "" or false) to disable automatic recovery; then fix manually and create `tmp/recovery-done`. Optional env: **`RESILIENCE_POLL_MS`** (default 15000), **`CRASH_RESTART_DELAY_MS`** (default 2000). For the fix-build script: **`CURSOR_AGENT_CMD`** (default cursor-agent), **`CURSOR_AGENT_ARGS`** (default --approve-mcps --force).

**Important:** The recovery flow runs inside the wrapper process. The wrapper only continues (restarts the app) after build-recovery-wait exits 0 (build succeeded). There is no infinite retry loop: one wait, one retry. When build-recovery-wait sees `tmp/recovery-done`, it **deletes that file** and then runs the build, so recovery-done is single-use. After successful recovery, the wrapper removes `tmp/last-build-failure.log` and `tmp/last-build-failure.json` so the next heartbeat or daemon poll does not treat the failure as current. The resilience daemon also removes these artifacts after writing `tmp/recovery-done` so it does not re-run RECOVERY_CMD on the next poll. If the wrapper exits after a recovery timeout, the **daemon** (when using `npm run start:watch`) restarts the wrapper, so you can fix the build (e.g. manually or via Option B) and create `tmp/recovery-done`; when the wrapper runs again, it will run build-recovery-wait and retry.

## 7. Command line too long (Windows and long prompts)

On Windows, the CreateProcess command line limit is about 8191 characters. If the user message (or full prompt) is passed as the last argument to the Cursor CLI, long conversations or long prompts can trigger "command line is too long" or similar errors.

- **cursor-agent-cli adapter:** When `promptAsArg: true` and the last user message is longer than 4000 characters, the adapter **does not** pass it as an argument; it writes the prompt to the CLI’s **stdin** and closes it. The CLI must read the initial prompt from stdin when no positional prompt is given. See `docs/cursor-agent-adapter.md`.
- **Recovery:** If you see a command-line-too-long error: (1) Ensure your CLI can read the prompt from stdin when it is not provided as an argument. (2) Or set `promptAsArg: false` and use a CLI that accepts a single JSON turn on stdin. (3) Or reduce prompt length (e.g. shorter system prompt or fewer messages) so the last user message stays under the safe length.
- **Automatic recovery:** The cursor-agent-cli adapter detects command-line-too-long from stderr (e.g. "command line is too long", "argument list too long", Windows error 87 / 0x80070057, spawn E2BIG). When detected and the prompt was sent as an argument (not already via stdin), the adapter retries the turn once with the prompt sent via stdin so the turn can succeed without operator action.

## 8. File and encoding resilience

To avoid process crashes or bad behaviour from large or malformed files:

- **Length caps:** Session-start memory (MEMORY.md + daily files) is capped (default 32k chars); substrate and message limits are applied so that very long files do not blow up the prompt.
- **Missing files:** Substrate and session-memory reads tolerate missing files (ENOENT); they skip or return empty content and log a warning.
- **Encoding:** **Safe read** is applied to user-editable and profile-scoped state files: `safeReadUtf8()` (in `src/fs-utils.ts`) reads as buffer and decodes with replacement characters so invalid UTF-8 does not crash the process. Used for: MEMORY.md and daily memory (`session-memory.ts`), substrate files (`substrate/loader.ts`), BOOT.md and HEARTBEAT.md (`index.ts`), and the memory-embedding index state file (`continuity/memory-embedding-index.ts`, with length cap). Other reads (e.g. config, state JSON) still use normal UTF-8; parsing should validate and catch errors.
- **Parsing:** When parsing JSON or structured content (e.g. memory records, config), validate and catch errors; return a safe default or skip the bad entry instead of throwing so the server can keep running.

## 9. Implemented and possible future improvements

- **Crash auto-restart (implemented):** With `npm run start:watch`, the server is restarted automatically on crash (non-zero exit or signal); see §2. After a crash the wrapper runs a build; if the build fails, the recovery flow (§6) applies.
- **Resilience daemon and Cursor-Agent fix (implemented):** `npm run start:watch` runs the daemon in **supervisor mode** (`resilience-daemon.js --watch`): the daemon is the top-level process, spawns the wrapper, and restarts it whenever it exits (crash or build-failure timeout), so the daemon itself does not crash when the server or wrapper crashes. The daemon also polls for `tmp/last-build-failure.log` and runs **`RECOVERY_CMD`** (default: `node scripts/fix-build-with-cursor-agent.js`) so build failures can be fixed by the Cursor-Agent CLI. Standalone `npm run resilience:daemon` runs the daemon in poll-only mode (no server supervision).
- **Daemon hardening (implemented):** The daemon is written so it keeps supervising even when the wrapper or child fails: (1) `runWrapper()` never rejects (spawn errors are caught and resolved with code 1); (2) the supervisor loop has an inner try/catch so any error in the loop is logged and the loop continues (restart wrapper after delay); (3) uncaughtException and unhandledRejection in the daemon are logged but do not exit the process; (4) if `main()` ever rejects in watch mode, the daemon retries the supervisor loop after a delay instead of exiting. This ensures the daemon process does not exit when the server crashes or when the wrapper exits, so it can always restart the wrapper and thus restore the server (or retry after build recovery).
- **Wrapper hardening (implemented):** The run-with-restart wrapper catches any error thrown in its main loop (e.g. from `run()` or `buildAndRestart()`), treats it like a crash, and retries after a delay (build and restart) instead of exiting. Only explicit user stop (SIGINT/SIGTERM) or build-recovery timeout causes the wrapper to exit; when it does exit, the daemon restarts it.
- **Possible future:** Run-store idempotency (deduplication after crash); start on boot (systemd/launchd or health-check); hang detection (health-check timeout and kill/restart); Tailnet reconnection docs or behavior when the link drops and recovers.

## 10. Runbook: agent-driven debugging (heartbeat)

When the heartbeat runs (see HEARTBEAT.md), resilience is first: read `tmp/last-build-failure.log` if present, fix the failure or document the blocker in ROADMAP.md Current state / Open; optionally run `npm run build` and tests, then update ROADMAP Current state with branch and build status. Useful patterns for agent-driven problem-solving:

- **Root-cause:** Reproduce (e.g. run the failing command), isolate (identify the failing component or line from logs), fix (code or config change), verify (build and tests).
- **Iterative fix:** After each change, run build and tests; on success, update ROADMAP Current state; on failure, update `tmp/last-build-failure.log` (or leave it for the wrapper) and either fix further or record the blocker in ROADMAP so the next tick or operator can continue.
- **Runbooks:** Other runbooks in this repo (e.g. §6 build-failure recovery, provider-model-support, inter-agent-communication) follow a similar structure: preconditions, steps, and where to document state.
- **When tests fail or are flaky:** Run `npm test` (or the failing subset). Isolate the failing test file and case from the output; fix the code or test (e.g. timing, ordering, mocks). If a test is intentionally skipped or deferred, document why (e.g. in the test or in ROADMAP). On persistent failure, record the blocker in ROADMAP Current state / Open so the next tick or operator can continue; do not leave `tmp/last-build-failure.log` as the only record if the failure was from tests (build may still pass).
