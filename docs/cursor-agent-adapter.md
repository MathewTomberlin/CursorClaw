# Cursor-Agent Adapter Contract

This document defines the machine-readable contract for the `CursorAgentModelAdapter`.

## Transport

- Primary transport: NDJSON events on `stdout` (`--stream-json`).
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

## Guardrails

- Unknown tool names are rejected before execution.
- Tool arguments are schema-validated before execution.
- Malformed event frames fail closed.
- Adapter logs are redacted for secret-like tokens.
- Timeout watchdog stages cancellation (`cancel` message, `SIGTERM`, `SIGKILL`).
- Recoverable transport/auth/model failures may rotate auth profiles or fallback models.
