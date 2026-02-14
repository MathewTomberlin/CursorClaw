# CursorClaw

CursorClaw is a security-first autonomous agent runtime with:

- a guarded RPC gateway (`/rpc`) with auth, role scopes, rate limits, and risk scoring
- queued session turn execution with lifecycle event snapshots
- policy-gated tools (`exec`, `web_fetch`, MCP tools) with approval/capability flows
- privacy-first prompt/tool scrubbing for secret-like content
- autonomy orchestration (cron, heartbeat, workflows, proactive intents)
- semantic workspace indexing and context compression
- reflection/reliability controls (failure-loop detection, reasoning reset, checkpoints, confidence gating)

## Documentation

Start here:

- [Documentation Index](./docs/README.md)
- [Getting Started](./docs/getting-started.md)
- [Configuration Reference](./docs/configuration-reference.md)
- [RPC API Reference](./docs/rpc-api-reference.md)
- [Codebase Reference](./docs/codebase-reference.md)
- [Cursor-Agent Adapter Contract](./docs/cursor-agent-adapter.md)

## Quick Start

```bash
npm install
npm test
npm run build
npm run security:audit
```

Create `openclaw.json` with secure credentials (example in `docs/getting-started.md`), then run:

```bash
npm start
```

Default gateway bind: `127.0.0.1:8787` (unless config/environment overrides).
