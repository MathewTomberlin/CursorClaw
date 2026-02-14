# CursorClaw Documentation

This folder contains implementation-grounded documentation for the current CursorClaw codebase.

## Documentation Map

### Start here

1. [Getting Started](./getting-started.md)
   - Install, configure, run, and verify a local instance.
   - First authenticated RPC calls (`chat.send`, `agent.run`, `agent.wait`).
2. [Configuration Reference](./configuration-reference.md)
   - Complete config schema, defaults, startup validation, and environment variables.
3. [RPC API Reference](./rpc-api-reference.md)
   - Complete gateway endpoint and method reference.
   - Request/response envelopes, auth, errors, and operational semantics.
4. [Codebase Reference](./codebase-reference.md)
   - Architecture, runtime lifecycle, subsystem internals, and file-by-file map.
   - Test-suite map and extension points for contributors.

### Existing focused specification

- [Cursor-Agent Adapter Contract](./cursor-agent-adapter.md)
  - Wire format and event contract for `CursorAgentModelAdapter`.

### Large architecture and audit specs (repo root)

These documents are design/audit artifacts that informed the implementation:

- `OPENCLAW_ARCHITECTURE_ANALYSIS.md`
- `AUTONOMOUS_LIVING_ASSISTANT_ANALYSIS_SPEC.md`
- `CURSORCLAW_LIMITATIONS_REMEDIATION_TECH_SPEC.md`
- `CURSORCLAW_CONTEXT_DISTRIBUTED_INTUITION_RELIABILITY_SPEC.md`
- `IMPLEMENTATION_V2_REALITY_AUDIT_SPEC.md`
- `IMPLEMENTATION_V2_AUDIT_SPEC.md`

## Recommended Reading Order

If you are:

- **An operator or user**: read _Getting Started_ -> _Configuration Reference_ -> _RPC API Reference_.
- **A contributor**: read _Codebase Reference_ -> _Configuration Reference_ -> _RPC API Reference_ -> adapter contract.
- **Doing security/reliability reviews**: read _Codebase Reference_ + root audit/spec docs.
