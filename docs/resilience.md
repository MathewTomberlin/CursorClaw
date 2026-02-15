# CursorClaw resilience

How the framework behaves across code updates, process crashes, host restarts, and Tailnet usage.

## 1. Code updates and restart

- **Restart flow:** The UI or an RPC can call `admin.restart`. The gateway only allows this when the request is considered **local** (loopback or private IP; see §4). The process then exits with a special exit code (`RESTART_EXIT_CODE` = 42).
- **Wrapper:** When you run `npm run start:watch`, the script `scripts/run-with-restart.js` runs `npm start`. If the process exits with 42, the wrapper runs `npm run build` and, **only if the build succeeds**, runs `npm start` again in the same terminal. If the build fails, the wrapper exits with the build’s exit code and does **not** start the app again, so broken code is never run.
- **Hot reload without restart:** Config and substrate can be updated without restart via `config.reload` and `substrate.reload` RPCs. Restart is only required for code or gateway bind-address changes.

## 2. Process crashes

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

When you use `npm run start:watch` and the build fails after a restart request:

1. The wrapper writes the build output to **`tmp/last-build-failure.log`** and a summary to **`tmp/last-build-failure.json`** (timestamp, exit code).
2. The wrapper then runs **`node scripts/build-recovery-wait.js`**, which:
   - Waits for **`tmp/recovery-done`** to appear (or a timeout, e.g. 10 minutes).
   - When the file appears, the script deletes it, runs `npm run build` again, and exits with the build exit code (0 = success).
3. If the build succeeds after recovery, the wrapper continues its loop and starts the app again **in the same terminal**, so the server comes back without you having to be at the machine.

**How to recover when you are remote (e.g. on your phone):**

- **Option A — Agent fixes when the app is back up:** If you can get the app running once (e.g. from another terminal or after a manual fix), the **heartbeat** is instructed to prioritise `tmp/last-build-failure.log`: read it, fix the build, then write `tmp/recovery-done`. The next time you use start:watch in the failed terminal, the wrapper will see recovery-done (or you run build-recovery-wait manually after fixing), and the build will retry.
- **Option B — Fix from Cursor IDE:** Open the project in Cursor. If `tmp/last-build-failure.log` exists, fix the reported errors in code, then create the file `tmp/recovery-done` (e.g. `echo. > tmp/recovery-done` on Windows, or touch on Unix). The wrapper, when running build-recovery-wait, will then retry the build. If the wrapper is not running (terminal was closed), run `npm run build` and then `npm run start:watch` again.
- **Option C — Resilience daemon:** Run `npm run resilience:daemon` in a separate terminal (or as a background process). It polls for `tmp/last-build-failure.log`. When the file appears, if the env var **`RECOVERY_CMD`** is set, it runs that command (e.g. a script that invokes Cursor CLI or a local LLM to fix the build). If the command exits 0, the daemon writes `tmp/recovery-done`, so the start:watch terminal’s build-recovery-wait can retry the build. The daemon does not depend on the main server. Optional env: **`RESILIENCE_POLL_MS`** (default 15000). If `RECOVERY_CMD` is not set, the daemon only logs; fix manually and create `tmp/recovery-done`.

**Important:** The recovery flow runs in the **same terminal** as the wrapper. The wrapper only continues (restarts the app) after build-recovery-wait exits 0 (build succeeded). There is no infinite retry loop: one wait, one retry. When build-recovery-wait sees `tmp/recovery-done`, it **deletes that file** and then runs the build, so recovery-done is single-use. After successful recovery, the wrapper removes `tmp/last-build-failure.log` and `tmp/last-build-failure.json` so the next heartbeat or daemon poll does not treat the failure as current. The resilience daemon also removes these artifacts after writing `tmp/recovery-done` so it does not re-run RECOVERY_CMD on the next poll.

## 7. Command line too long (Windows and long prompts)

On Windows, the CreateProcess command line limit is about 8191 characters. If the user message (or full prompt) is passed as the last argument to the Cursor CLI, long conversations or long prompts can trigger "command line is too long" or similar errors.

- **cursor-agent-cli adapter:** When `promptAsArg: true` and the last user message is longer than 4000 characters, the adapter **does not** pass it as an argument; it writes the prompt to the CLI’s **stdin** and closes it. The CLI must read the initial prompt from stdin when no positional prompt is given. See `docs/cursor-agent-adapter.md`.
- **Recovery:** If you see a command-line-too-long error: (1) Ensure your CLI can read the prompt from stdin when it is not provided as an argument. (2) Or set `promptAsArg: false` and use a CLI that accepts a single JSON turn on stdin. (3) Or reduce prompt length (e.g. shorter system prompt or fewer messages) so the last user message stays under the safe length.
- **Automatic recovery:** The cursor-agent-cli adapter detects command-line-too-long from stderr (e.g. "command line is too long", "argument list too long", Windows error 87 / 0x80070057, spawn E2BIG). When detected and the prompt was sent as an argument (not already via stdin), the adapter retries the turn once with the prompt sent via stdin so the turn can succeed without operator action.

## 8. File and encoding resilience

To avoid process crashes or bad behaviour from large or malformed files:

- **Length caps:** Session-start memory (MEMORY.md + daily files) is capped (default 32k chars); substrate and message limits are applied so that very long files do not blow up the prompt.
- **Missing files:** Substrate and session-memory reads tolerate missing files (ENOENT); they skip or return empty content and log a warning.
- **Encoding:** **Safe read** is applied to user-editable files: `safeReadUtf8()` (in `src/fs-utils.ts`) reads as buffer and decodes with replacement characters so invalid UTF-8 does not crash the process. Used for: MEMORY.md and daily memory (`session-memory.ts`), substrate files (`substrate/loader.ts`), BOOT.md and HEARTBEAT.md (`index.ts`). Other reads (e.g. config, state JSON) still use normal UTF-8; parsing should validate and catch errors.
- **Parsing:** When parsing JSON or structured content (e.g. memory records, config), validate and catch errors; return a safe default or skip the bad entry instead of throwing so the server can keep running.

## 9. Implemented and possible future improvements

- **Resilience daemon (implemented):** `npm run resilience:daemon` — see Option C in §6. No dependency on the main server.
- **Possible future:** Run-store idempotency (deduplication after crash); start on boot (systemd/launchd or health-check); Tailnet reconnection docs or behavior when the link drops and recovers.
