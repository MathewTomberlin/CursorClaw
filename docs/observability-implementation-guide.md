# Observability implementation guide

**Status:** Spec / implementation guide. Implement when prioritized.

**Context:** STUDY_GOALS Engineering — observability (structured logging, trace IDs, optional metrics). Research note in STUDY_GOALS; this doc defines scope, success criteria, and guardrails for implementation.

---

## §1 Scope

- **Structured logging:** Gateway and runtime log in a structured format (e.g. JSON) with consistent fields (level, timestamp, message, optional request/turn IDs). Prefer a small, well-supported library (e.g. pino) or minimal structured format to avoid heavy dependencies.
- **Request/turn trace IDs:** Each incoming request or turn gets a trace ID; propagate through gateway → runtime → tool calls so logs can be correlated.
- **Optional metrics:** When enabled (config), expose or emit metrics (e.g. turn count, tool-call count, latency percentiles). Implementation can be minimal (in-process counters, optional export to stdout or a metrics endpoint).

Out of scope for v1: distributed tracing (e.g. OpenTelemetry), full APM; can be added later if prioritized.

---

## §2 Success criteria

- Structured logs from gateway and runtime with at least: level, timestamp, message, and (when applicable) trace ID.
- Trace ID present on request path and in log lines for that request/turn.
- Optional metrics (if enabled) observable without breaking existing behavior; no requirement for a specific metrics backend.

---

## §3 Guardrails

- **Backward compatibility:** Existing log level and verbosity behavior preserved; new format is additive (e.g. still support human-readable mode or existing console output if configured).
- **Performance:** Logging must not significantly increase latency or memory; avoid synchronous I/O in hot path where possible.
- **No secrets:** Log and metrics must not include secrets, tokens, or full message content unless explicitly configured for debug and redacted by existing privacy scrubber where applicable.

---

## §4 When to prioritize

- Operator or users need to debug request flows (trace IDs) or aggregate behavior (metrics).
- Log aggregation or monitoring pipelines require structured logs.
- Runbook or docs reference this guide for "When the operator needs logs or diagnostics" (see docs/resilience.md §10).

---

## §5 Implementation order (when implementing)

1. Add trace ID generation and propagation (gateway entry → runtime context).
2. Introduce structured logger (gateway + runtime) with trace ID in fields.
3. Replace or wrap existing log calls to use structured logger; keep level/verbosity config.
4. Add optional metrics (config flag, in-process counters, optional export) and document in runbook.
