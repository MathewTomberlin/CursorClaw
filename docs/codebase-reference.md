# CursorClaw Codebase Reference

This is a detailed implementation reference for the current TypeScript codebase under `src/` and `tests/`.

## 1) High-level architecture

At startup (`src/index.ts`), CursorClaw builds and wires:

1. **Configuration and startup validation**
2. **State stores** (memory, observations, run store, autonomy state)
3. **Semantic context pipeline** (workspace indexing, summary cache, embedding index, retriever)
4. **Runtime execution core** (`AgentRuntime`)
5. **Tool policy/approval stack** (`ToolRouter`, approval gates, capability grants)
6. **Gateway control plane** (`Fastify`, `/rpc`)
7. **Autonomy orchestration** (cron, heartbeat, workflows, proactive intents)
8. **Optional reflection services** (idle scheduler, flaky test runner, function explainer, trace collector)

Core design shape:

- Gateway accepts RPC calls -> runtime executes turns through model adapter/tool router -> state and observations are persisted -> orchestrator runs background/periodic behaviors.

## 2) Runtime turn lifecycle

Implemented primarily in `src/runtime.ts`.

1. Request is enqueued in a per-session queue (`SessionQueue`) for strict in-order execution.
2. Runtime emits lifecycle events: `queued`, `started`, `assistant`, `tool`, `compaction`, `completed`, `failed`.
3. Runtime applies reliability controls:
   - failure-loop escalation (`FailureLoopGuard`)
   - reasoning reset (`ReasoningResetController`)
   - optional deep scan (`DeepScanService`)
   - optional confidence gate (`ConfidenceModel`) that can return a human-hint request before model invocation
4. Prompt is assembled from:
   - optional substrate (Identity, Soul, User in main session, Birth on first turn, optional Capabilities/Tools summary, ROADMAP planning file) when `config.substrate` is set; see `src/substrate/` and docs/configuration-reference.md §4.16. When substrate includes AGENTS or ROADMAP, a formal "Planning and automation" system block is injected so the agent natively plans and automates work (milestones, heartbeats, user prioritization).
   - fresh user messages (last 8 max)
   - contradiction annotations
   - multi-path/deep-scan system hints
   - recent decision journal entries
   - plugin pipeline outputs
5. Model stream events are consumed from adapter:
   - `assistant_delta` appended to response
   - `tool_call` routed via `ToolRouter` and policy/approval checks
6. Optional git checkpoint behavior wraps mutating/high-risk tool calls (`GitCheckpointManager`).
7. Memory and observations are persisted; action envelope is emitted.
8. Snapshot JSON is written under `tmp/snapshots`.

## 3) Gateway control plane and RPC behavior

Implemented in `src/gateway.ts`.

- Endpoints:
  - `GET /health`
  - `GET /status`
  - `POST /rpc`
- RPC preflight guards:
  - protocol version
  - auth/role scope
  - rate limiting
  - inbound risk scoring
- Core method families:
  - run control (`agent.run`, `agent.wait`)
  - messaging (`chat.send`)
  - autonomy scheduling (`cron.add`)
  - incident containment (`incident.bundle`)
  - capability approvals (`approval.*`)
  - advisor/workspace tools (`advisor.file_change`, `workspace.*`, `trace.ingest`, `advisor.explain_function`)
- Run persistence and restart continuity are supported via `RunStore`.

### 3.1 Channels and chat.send

- **Current behavior:** When a channel hub is configured, `chat.send` dispatches to the first adapter that supports the `channelId` (e.g. Slack when configured and `channelId` starts with `slack:`; otherwise `LocalEchoChannelAdapter`).
- **Best-effort:** Delivery is best-effort; CursorClaw does not store or retry delivery beyond the adapter’s own behavior.
- **Extension:** New adapters (e.g. Discord, webhook) can be added by implementing the `ChannelAdapter` interface (`src/channels.ts`) and registering with the hub.
- **Optional callback:** The gateway accepts an optional `onBeforeSend?(channelId, text): Promise<boolean>`. If provided, it is called before `channelHub.send`. If it returns `false`, delivery is skipped and the RPC response indicates `delivered: false` with detail `"onBeforeSend returned false"`. This allows operator-defined webhooks or filtering without implementing a full adapter.

## 4) Security model (defense in depth)

Security logic spans `src/security.ts`, `src/tools.ts`, `src/security/*`, and config defaults.

### 4.1 Request-side controls

- Auth modes: token/password/none (`AuthService`)
- Role scoping by method (`METHOD_SCOPES`)
- Rate limits by method and subject (`MethodRateLimiter`)
- Prompt risk scoring (`scoreInboundRisk`)
- Policy decision audit stream (`PolicyDecisionLogger`)

### 4.2 Tool-side controls

- Tool schema validation (AJV) in `ToolRouter`
- Risk-level policy with incident isolation mode
- Command intent classification (`read-only`, `mutating`, `network-impacting`, `privilege-impacting`)
- Destructive command signatures blocked by default
- Approval gates:
  - policy-based (`PolicyApprovalGate`)
  - capability-based (`CapabilityApprovalGate`)
- Untrusted-derived actions (when the last user message has high inbound risk score) require an explicit capability grant with untrusted scope; see provenance in `ToolExecutionContext` and `requestScopeKey` in the approval workflow.

### 4.3 Network egress safety

- SSRF guard with DNS resolution and private IP detection (`resolveSafeFetchTarget`)
- Redirect hop revalidation
- DNS rebinding defense for `web_fetch`
- Content-type and body-size limits on fetched data
- Untrusted fetched content wrapped with explicit delimiters

### 4.4 Incident mode

`IncidentCommander` can:

- revoke tokens by hash
- disable proactive sends
- isolate high-risk tools
- export forensic bundle (decision logs + incident flags)

## 5) Privacy model

Implemented in `src/privacy/secret-scanner.ts` and `src/privacy/privacy-scrubber.ts`.

- Multi-detector secret scanning (assignment, GH token, AWS key ID, JWT, private key block, entropy token)
- Scoped placeholder mapping (stable placeholders per run scope)
- Recursive redaction for nested objects/arrays
- Fail-closed option for scanner errors
- Runtime applies scrubbing to:
  - prompt egress
  - tool call payloads and outputs in events
  - assistant deltas

## 6) Reliability and continuity

Implemented in `src/reliability/*`, `src/decision-journal.ts`, `src/proactive-suggestions.ts`.

- `FailureLoopGuard`: repeated-failure signature tracking + escalation trigger
- `ReasoningResetController`: iteration threshold and reset cycles
- `DeepScanService`: bounded recent-file discovery from git history + file hints
- `ConfidenceModel`: confidence scoring and rationale factors
- `GitCheckpointManager`: checkpoint/rollback/cleanup around risky mutations. Checkpoint is skipped when the worktree is dirty to avoid overwriting user changes; rollback refuses if the worktree is dirty at rollback time.
- `DecisionJournal`: append-only decision log with rotation and bounded recent context read
- `ProactiveSuggestionEngine`: path-pattern suggestion generation + per-channel cooldown

**Memory integrity scan:** The orchestrator runs `memory.integrityScan()` every `integrityScanEveryMs`. The scan returns `IntegrityFinding[]` (e.g. potential contradiction between records in the same session/category, or staleness for records older than 120 days). Findings are available for logging or future auto-remediation.

## 7) Context compression and workspace awareness

Implemented across `src/context/*`, `src/workspaces/*`, `src/network/*`.

### 7.1 Semantic context pipeline

- `SemanticSummaryCache`: summary + symbol extraction + content hash invalidation
- `LocalEmbeddingIndex`: local chunking, bag-of-token vectorization, cosine similarity retrieval
- `SemanticContextRetriever`: retrieves and ranks hits by module
- `ContextIndexService`: refresh coordinator + persisted indexed-file state + cross-repo graph

### 7.2 Multi-root indexing

- `WorkspaceCatalog`: root list, priority ordering, health checks
- `MultiRootIndexer`: recursive file indexing with extension, size, and ignored-dir rules

### 7.3 Cross-repo dependency graph

- `CrossRepoDependencyGraphBuilder` detects:
  - import-based edges
  - HTTP-call-based edges

### 7.4 Runtime tracing

- `NetworkTraceCollector` ingests traces, validates host allowlist, links routes to modules, and logs sanitized observations.

## 8) Reflection and explainability

Implemented in `src/reflection/*`.

- `IdleReflectionScheduler`: enqueue background jobs when idle and cancel queue on user activity
- `SpeculativeTestRunner`: repeated command execution with flaky scoring (`computeFlakyScore`)
- `FunctionExplainer`: symbol block extraction + side-effect heuristics + recent git history

## 9) Scheduler/autonomy orchestration

Implemented in `src/scheduler.ts`, `src/orchestrator.ts`, `src/autonomy-state.ts`.

- `CronService`: `at` / `every` / cron expression scheduling, retries, backoff, persistence
- `HeartbeatRunner`: adaptive heartbeat interval, active hours support, budget-gated turns
- `AutonomyBudget`: hourly/daily quotas + quiet hours
- `WorkflowRuntime`: deterministic idempotent workflow state machine with approvals
- `AutonomyOrchestrator`: ties cron/heartbeat/integrity scans/proactive intent dispatch together
- `AutonomyStateStore`: persists budget windows and proactive intent queue/statuses

## 10) Model adapter and channels

### 10.1 Model adapter (`src/model-adapter.ts`)

- `CursorAgentModelAdapter` supports:
  - CLI streaming via NDJSON or sentinel-framed JSON
  - strict adapter event validation
  - tool call schema checks before runtime execution
  - timeout watchdog + staged termination (`cancel`, `SIGTERM`, `SIGKILL`)
  - fallback model/auth profile rotation for recoverable failures
  - bounded redacted event log and adapter metrics

### 10.2 Channels and responsiveness (`src/channels.ts`, `src/responsiveness.ts`)

- `ChannelHub` dispatches outbound messages to first adapter supporting channel ID.
- `SlackChannelAdapter` is a deterministic skeleton adapter (not full API integration).
- `LocalEchoChannelAdapter` provides deterministic local provider behavior.
- `BehaviorPolicyEngine` composes:
  - `TypingPolicy`
  - `PresenceManager`
  - `DeliveryPacer`
  - `GreetingPolicy`

## 11) MCP integration

Implemented in `src/mcp.ts` and tool factories in `src/tools.ts`.

- `McpRegistry` manages adapters, allowlist policy, resource/tool listing, reads, calls.
- `InMemoryMcpServerAdapter` provides local in-memory MCP server used by default wiring.
- RPC-facing tool wrappers:
  - `mcp_list_resources`
  - `mcp_read_resource`
  - `mcp_call_tool` (high risk, approval-gated)

## 12) Persistence and runtime state files

Common files written relative to workspace root:

- `MEMORY.md`, `memory/*.md`
- `CLAW_HISTORY.log`
- `tmp/snapshots/*.json`
- `tmp/observations.json`
- `tmp/run-store.json`
- `tmp/cron-state.json`
- `tmp/workflow-state/*.json`
- `tmp/autonomy-state.json`
- `tmp/context-summary.json`
- `tmp/context-embeddings.json`
- `tmp/context-index-state.json`

## 13) Source file reference (`src/`)

## Core and bootstrapping

- `src/index.ts`: process bootstrap and full dependency wiring
- `src/config.ts`: typed config, defaults, merge/load/validate helpers
- `src/types.ts`: core shared interfaces and domain types

## Gateway and security

- `src/gateway.ts`: Fastify gateway, RPC dispatch, method validators
- `src/security.ts`: auth, rate limiting, risk scoring, SSRF utilities, incident commander
- `src/security/approval-workflow.ts`: approval request lifecycle and grant issuance
- `src/security/capabilities.ts`: capability grant store and capability resolution rules

## Runtime and execution

- `src/runtime.ts`: queued turn runtime, prompt assembly, tool events, snapshots
- `src/model-adapter.ts`: cursor-agent/fallback model adapter and streaming parser
- `src/tools.ts`: tool router, approval gates, exec/web_fetch/MCP tool factories
- `src/memory.ts`: durable markdown memory store and integrity scanning
- `src/run-store.ts`: persisted run continuity store
- `src/runtime-observation.ts`: bounded observation event store
- `src/decision-journal.ts`: append-only decision journal with rotation

## Plugins and context

- `src/plugins/types.ts`: plugin contracts
- `src/plugins/host.ts`: collector/analyzer/synthesizer pipeline runner + timeouts
- `src/plugins/builtins.ts`: memory/observation collectors and prompt synthesizer
- `src/plugins/semantic-context.collector.ts`: semantic retrieval collector plugin
- `src/context/summary-cache.ts`: semantic summary cache and symbols
- `src/context/embedding-index.ts`: local embedding index and query
- `src/context/retriever.ts`: semantic hit retrieval and module ranking
- `src/context/context-index-service.ts`: index refresh orchestration and graph integration
- `src/workspaces/catalog.ts`: workspace root catalog + health checks
- `src/workspaces/multi-root-indexer.ts`: recursive multi-root source indexer
- `src/workspaces/cross-repo-graph.ts`: cross-repo edge extraction
- `src/network/trace-linker.ts`: route-token to module-path linking
- `src/network/trace-collector.ts`: trace ingestion and sanitized observation logging

## Autonomy and behavior

- `src/scheduler.ts`: heartbeat, budget, cron, workflow runtime
- `src/orchestrator.ts`: autonomous coordination loop
- `src/autonomy-state.ts`: persisted autonomy state snapshot store
- `src/proactive-suggestions.ts`: file-change suggestion generator
- `src/responsiveness.ts`: typing/presence/pacing/greeting policies
- `src/channels.ts`: outbound channel abstraction and adapters

## Privacy/reliability/reflection/MCP

- `src/privacy/secret-scanner.ts`: detector engine
- `src/privacy/privacy-scrubber.ts`: scoped redaction service
- `src/reliability/action-envelope.ts`: action confidence envelope contract
- `src/reliability/confidence-model.ts`: confidence scoring model
- `src/reliability/deep-scan.ts`: bounded recent-touch scanner
- `src/reliability/failure-loop.ts`: repeated-failure tracking
- `src/reliability/git-checkpoint.ts`: checkpoint lifecycle manager
- `src/reliability/reasoning-reset.ts`: reasoning reset thresholds and state
- `src/reflection/flaky-score.ts`: flaky signal scoring
- `src/reflection/speculative-test-runner.ts`: repeated command runner
- `src/reflection/idle-scheduler.ts`: idle job scheduler
- `src/reflection/function-explainer.ts`: symbol explanation helper
- `src/mcp.ts`: MCP registry and in-memory adapter

## 14) Test suite map (`tests/`)

Integration-heavy:

- `gateway.integration.test.ts`: RPC/auth/rate-limit/incident/approval/workspace methods
- `runtime-privacy.integration.test.ts`: prompt and event secret scrubbing
- `scheduler-memory-runtime.test.ts`: scheduler, memory, workflow, runtime lifecycle
- `orchestrator.integration.test.ts`: orchestrator periodic behavior
- `orchestration-gateway.integration.test.ts`: gateway + orchestrator cron integration
- `failure-loop-runtime.test.ts`: failure-loop escalation and reasoning reset prompting
- `workspace-tracing.test.ts`: workspace indexing and network trace ingestion

Security/policy:

- `security-tools.test.ts`: ingress policy, auth, SSRF guard, tool policy and caching
- `capability-approval.test.ts`: capability grants and approval workflow behavior
- `prompt-injection-redteam.test.ts`: corpus-based risk scoring + scrubber checks
- `config-security.test.ts`: startup credential hardening and config path precedence

Context/plugins/reliability:

- `context-compression.test.ts`: summary cache, embeddings, retriever, context wrapping
- `context-drift-runtime.test.ts`: stale-context trimming and contradiction annotation
- `plugin-mcp.test.ts`: plugin host diagnostics + MCP tooling
- `reliability-continuity.test.ts`: decision journal, suggestions, checkpoint manager
- `reflection-reasoning-confidence.test.ts`: reflection scheduler and confidence gate

Focused unit coverage:

- `adapter.test.ts`: adapter stream/fallback/termination/log bounds
- `autonomy-state.test.ts`: persistence of budget and proactive intents
- `channels.test.ts`: channel adapter routing
- `responsiveness.test.ts`: behavior policy composition
- `runtime-observation.test.ts`: observation retention and payload capping
- `privacy-scrubber.test.ts`: detector breadth and performance baseline
- `throughput.guardrail.test.ts`: tool router throughput baseline
- `plugin-contracts.test.ts`: plugin type signature stability

## 14b) Exec sandbox (optional)

The exec tool uses an `ExecSandbox` abstraction (`src/exec/types.ts`). The default `HostExecSandbox` (`src/exec/host-sandbox.ts`) runs commands via `child_process.execFile` with no OS-level sandbox. A future implementation (e.g. `BubblewrapExecSandbox` or a restricted-user wrapper) could be plugged in by passing `sandbox` to `createExecTool` in bootstrap; the same interface would apply.

## 15) Extension points for contributors

Most practical extension points:

1. **Add tool definitions**
   - register new `ToolDefinition` via `ToolRouter.register(...)`
   - set schema/risk and integrate approval policy intentionally
   - optional `toolDefinitionChecksum` on `ToolDefinition` is reserved for future verification of tool definitions (e.g. from MCP or plugins) against a checksum or allowlist
2. **Add prompt pipeline plugins**
   - implement collector/analyzer/synthesizer contracts (`src/plugins/types.ts`)
   - register in bootstrap or runtime defaults
3. **Add channel adapters**
   - implement `ChannelAdapter` and register in `ChannelHub`
4. **Add MCP servers**
   - implement `McpServerAdapter` and register in `McpRegistry`
5. **Add workspace-aware analyzers**
   - extend context/retrieval or trace-linking modules

## 16) Operational constraints and defaults

- Body limit default: `64 KiB`
- Session turn timeout default: `60s`
- Snapshot cadence: every `session.snapshotEveryEvents` events
- Exec tool max buffer: `64 KiB`, timeout: `15s`
- Observation payload cap: `20,000` chars (stringified cap)
- Context retriever topK defaults to `8`
- Queue defaults:
  - soft limit `16`
  - hard limit `64`

---

For setup and usage flows, see [Getting Started](./getting-started.md).  
For configuration details, see [Configuration Reference](./configuration-reference.md).  
For method-level API contracts, see [RPC API Reference](./rpc-api-reference.md).
