# CursorClaw

CursorClaw is a security-first autonomous agent runtime that follows
`OPENCLAW_ARCHITECTURE_ANALYSIS.md` and implements:

- Gateway control plane with typed RPC, auth, rate limits, risk scoring, and audit IDs.
- Session-ordered turn runtime with lifecycle events and crash snapshots.
- Cursor-Agent CLI adapter (stream parser, cancellation, timeout watchdog, fallback strategy).
- Scheduler stack (heartbeat + cron + deterministic workflow runtime).
- Memory model (markdown durable store, provenance + sensitivity labels, secret filtering).
- Tool safety (schema validation, SSRF guard, exec intent classifier, approval gates).
- Responsiveness behavior policies (typing/presence/pacing/greeting).

## Quick Start

```bash
npm install
npm test
npm run build
npm start
```

Default gateway listen address is `127.0.0.1:8787`.
