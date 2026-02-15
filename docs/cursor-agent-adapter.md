# Cursor-Agent Adapter Contract

This document defines the machine-readable contract for the `CursorAgentModelAdapter`.

## Two invocation styles

### 1. Cursor CLI (official) — prompt as argument

The **Cursor Agent CLI** (see [Cursor Docs – Parameters](https://cursor.com/docs/cli/reference/parameters)) uses **`-p` / `--print`** and **`--output-format stream-json`** (not `--stream-json`). The prompt is passed as a **positional argument**. Use this when your CLI is the official Cursor Agent.

In `openclaw.json`, set the model with **`promptAsArg: true`** and args like:

```json
"cursor-auto": {
  "provider": "cursor-agent-cli",
  "command": "agent",
  "args": ["-p", "--output-format", "stream-json", "--stream-partial-output"],
  "promptAsArg": true,
  "timeoutMs": 600000,
  "authProfiles": ["default"],
  "fallbackModels": ["fallback-default"],
  "enabled": true
}
```

On Windows with `agent.cmd`, use `"command": "agent.cmd"` and the same `args`. The adapter will append the user message as the last argument and will **not** write JSON to stdin.

### 2. Stdin turn JSON (custom CLIs)

If your CLI reads a single JSON turn from stdin and emits NDJSON on stdout, **do not** set `promptAsArg`. Use args such as `["auto"]` or whatever your CLI expects. The adapter will write one line of turn JSON to stdin.

## Transport

- Primary transport: NDJSON events on `stdout` (e.g. Cursor CLI `--output-format stream-json`, or custom `--stream-json`).
- Fallback transport: sentinel-framed JSON blocks:
  - `__JSON_START__`
  - `<JSON payload>`
  - `__JSON_END__`
- Input contract (stdin):

```json
{
  "type": "turn",
  "turnId": "uuid",
  "messages": [{ "role": "user", "content": "..." }],
  "tools": [{ "name": "exec", "schema": { "type": "object" } }]
}
```

## Event Schema

All output events must match:

```json
{
  "type": "assistant_delta | tool_call | usage | error | done",
  "data": {}
}
```

The adapter also accepts `protocol` (version handshake), `system`, `user`, and `thinking` (Cursor CLI stream annotations); these are ignored and not forwarded. Cursor CLI `assistant` events (with `message.content[].text`) are mapped to `assistant_delta` so the reply text is shown. A final `result` event is treated as end-of-turn and converted to a `done` event so the stream is accepted. Cursor CLI `tool_call` events use a different shape (e.g. `tool_call.shellToolCall`) and are skipped—the CLI runs tools internally; only tool calls in the contract shape (`data.name` + `data.args`) are forwarded to the runtime.

### `assistant_delta`

```json
{
  "type": "assistant_delta",
  "data": { "content": "partial text" }
}
```

### `tool_call`

```json
{
  "type": "tool_call",
  "data": {
    "name": "exec",
    "args": { "command": "pwd" }
  }
}
```

### `usage`

```json
{
  "type": "usage",
  "data": {
    "promptTokens": 123,
    "completionTokens": 456
  }
}
```

### `error`

```json
{
  "type": "error",
  "data": {
    "code": "MODEL_AUTH_ERROR",
    "message": "token expired"
  }
}
```

### `done`

```json
{
  "type": "done",
  "data": {
    "finishReason": "stop"
  }
}
```

## Version

The CLI may send an optional protocol version as the first event:

```json
{
  "type": "protocol",
  "data": { "version": "1.0" }
}
```

The adapter accepts output with or without a version. If `version` is present and not in the supported list (e.g. `["1.0"]`), the adapter treats it as a protocol error: it logs and fails closed, or attempts fallback model if configured. When no version is sent, behavior is unchanged (backward compatible).

## Debugging (exit code 1, no stderr / no terminal output)

If the adapter reports "exited with code 1" and "(no stderr)", or when you run the CLI manually with a pipe you get **no output at all** (command just returns to the prompt), use these steps.

### 1. Check the exit code after the pipe command

In PowerShell, right after running the pipe command, run:
```powershell
$LASTEXITCODE
```
If it prints `1`, the CLI is exiting with failure (same as CursorClaw sees). If `0`, the CLI is "succeeding" but not emitting the required NDJSON to stdout.

### 2. Run the CLI without a pipe (interactive)

**Cursor CLI (prompt-as-arg):** If you use `promptAsArg: true`, test with the prompt as the last argument (no stdin pipe):
```powershell
agent.cmd -p --output-format stream-json --stream-partial-output "hello"
```
(or `agent` instead of `agent.cmd` on Unix). The CLI should stream NDJSON events to stdout.

**Custom CLI (stdin turn JSON):** If your CLI reads turn JSON from stdin:
```powershell
agent.cmd auto --stream-json
```
(or `agent auto --stream-json` / full path). Run with no pipe to see if it prompts for input.

- If it **prints a prompt, help text, or "waiting for input"**: the CLI works when attached to a **real terminal (TTY)**. When stdin/stdout are **pipes** (e.g. when CursorClaw runs it), it may exit or produce no output. The CLI must support **headless/pipe mode** for CursorClaw.
- If it **produces no output** and exits: the CLI may be missing configuration or environment variables. Ensure any required env vars or config are set in the shell where you run CursorClaw (the adapter passes the **full parent process environment** to the CLI).

### 3. Minimal turn for pipe test (custom CLIs only)

If your CLI reads a single turn JSON line from stdin (invocation style 2, not Cursor CLI with `promptAsArg`), use this to test.

**Minimal turn (one line)** — save as `turn.json` with no trailing newline:
```json
{"type":"turn","turnId":"t1","messages":[{"role":"user","content":"hi"}],"tools":[]}
```

**Windows (PowerShell):**
```powershell
Get-Content turn.json -Raw | agent.cmd auto --stream-json
# then: $LASTEXITCODE
```

**Windows (cmd):** `type turn.json | agent.cmd auto --stream-json`

**Unix:** `echo '{"type":"turn","turnId":"t1","messages":[{"role":"user","content":"hi"}],"tools":[]}' | agent.cmd auto --stream-json`

The CLI must read this single line from stdin, then emit NDJSON events on stdout. The adapter accepts stream end when it sees: a `done` event, a `result` event (converted to done), or process exit code 0 after at least one forwardable event. If there is no output and the exit code is 1, the CLI is likely (a) not supporting pipe/non-TTY mode, or (b) failing before reading stdin (missing env, wrong cwd, or the process that reads stdin is not the one started by the command).

## Guardrails

- Unknown tool names are rejected before execution.
- Tool arguments are schema-validated before execution.
- Malformed event frames fail closed.
- Adapter logs are redacted for secret-like tokens.
- Timeout watchdog stages cancellation (`cancel` message, `SIGTERM`, `SIGKILL`).
- Recoverable transport/auth/model failures may rotate auth profiles or fallback models.
