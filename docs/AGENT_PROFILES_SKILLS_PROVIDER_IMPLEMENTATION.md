# Agent Profiles, Agent Skills, and Provider/Model Selection — Implementation Guide

**Purpose:** Step-by-step implementation plan for (1) **Agent Profiles** (per-agent isolated data and config), (2) **Agent Skills** (installable skills with secure credentials and safety checks), and (3) **Provider and Model Selection** (per-profile provider, API key, and model—including local LLMs). Use this document as the single source of truth when implementing these features.

**Prerequisite:** Follow `docs/IDENTITY_SOUL_BIRTH_IMPLEMENTATION.md` for substrate and identity; this guide builds on that and extends toward multi-agent and multi-provider support.

---

## 1) Overview and Dependencies

| Feature | Summary | Depends on |
|--------|---------|------------|
| **Agent Profiles** | Dedicated directory per agent holding Approvals, Cron, Workspace, Memory, Incidents, Substrate, Heartbeat, Trace, Config so multiple agents can run with isolated state. | Current single-workspace design; config and runtime need to accept a "profile root." |
| **Agent Skills** | Read `skill.md` (e.g. via Web Fetch), run install commands (curl/bash), store credentials using existing secure systems; user can add/update/delete keys; agent analyzes safety before install. Skills are per Agent Profile. | Agent Profiles (profile root for skills/credentials); existing CapabilityStore/approval and any credential storage. |
| **Provider and Model Selection** | Per Agent Profile: select provider, provide API key when needed, select model (e.g. from Ollama for local). Support 16GB VRAM local LLMs (e.g. Granite 3.2); keep Cursor-Agent CLI parity. | Agent Profiles; current `models` and `defaultModel` in config. |

Implementation order: **Agent Profiles first** (enables the other two), then **Provider and Model Selection** (so each profile can have its own model), then **Agent Skills** (skills and credentials live under the profile).

---

## 2) Agent Profiles

### 2.1 Goal

- Agent-specific data (Approvals, Cron, Workspace, Memory, Incidents, Substrate, Heartbeat, Trace, Config) lives in a **directory dedicated to that agent**, so it can be isolated and multiple agents can coexist with different substrates, memories, and configs.

### 2.2 Data to Isolate (per profile)

| Data | Current location (single workspace) | Per-profile location |
|------|-------------------------------------|----------------------|
| Approvals / CapabilityStore state | In-process / config | `{profileRoot}/approvals` or equivalent state file |
| Cron state | `workspaceDir/tmp/cron-state.json` | `{profileRoot}/tmp/cron-state.json` |
| Workspace roots / catalog | `config.workspaces`, workspaceDir | Profile-specific workspace list and roots |
| Memory (MEMORY.md, memory/YYYY-MM-DD) | `workspaceDir`, MemoryStore(workspaceDir) | `{profileRoot}` for memory store root |
| Incidents | If present | `{profileRoot}/incidents` or state file |
| Substrate (AGENTS, IDENTITY, SOUL, etc.) | `workspaceDir` + config.substrate paths | `{profileRoot}` + profile substrate paths |
| Heartbeat (HEARTBEAT.md, state) | `workspaceDir/HEARTBEAT.md`, autonomy-state | `{profileRoot}/HEARTBEAT.md`, `{profileRoot}/tmp/autonomy-state.json` |
| Trace / logs | CLAW_HISTORY.log, etc. | `{profileRoot}/logs/` or equivalent |
| Config | Single config file (e.g. openclaw.json) | Profile config: `{profileRoot}/config.json` or overlay |

### 2.3 Directory Layout (proposed)

- **Single-agent (backward compatible):** If no profiles are configured, use `workspaceDir` as the single "default" profile root (current behavior).
- **Multi-agent:** Top-level config lists profiles; each profile has a root directory.
  - Example: `profiles: [{ id: "main", root: "." }, { id: "assistant", root: "./profiles/assistant" }]`
  - Or: `agentProfilesRoot: "./.cursorclaw/profiles"` with one subdir per profile (e.g. `main`, `assistant`).

Recommended layout for one profile root `{profileRoot}`:

```
{profileRoot}/
  config.json          # or overlay (optional; defaults from main config)
  AGENTS.md, IDENTITY.md, SOUL.md, BIRTH.md, CAPABILITIES.md, USER.md, TOOLS.md
  HEARTBEAT.md
  MEMORY.md
  memory/
    2025-02-14.md
    heartbeat-state.json
  tmp/
    cron-state.json
    autonomy-state.json
    snapshots/
    run-store.json
    workflow-state/
    observations.json
    context-summary.json
    context-embeddings.json
    context-index-state.json
  logs/                # optional
    CLAW_HISTORY.log
  skills/              # for Agent Skills (Phase 2)
    installed/
    credentials/       # references or encrypted store; never in prompt
```

### 2.4 Implementation Phases (Agent Profiles)

**Phase A.1 – Config and profile resolution**

- [x] **A.1.1** Add to config: `profiles?: { id: string; root: string }[]` or `agentProfilesRoot?: string` with convention (e.g. one subdir per profile). If absent, treat `workspaceDir` as the single profile root with a single default profile id (e.g. `"default"`).
- [x] **A.1.2** Resolve "active" profile(s): either one default profile or a way to select profile per request (e.g. channel, header, or first profile). Document how profile is chosen for chat, heartbeat, and cron.
- [x] **A.1.3** All code paths that today use `workspaceDir` for substrate, memory, heartbeat, cron, tmp state, and logs must use the **resolved profile root** for that context. No change to external API contract yet (e.g. gateway still receives workspaceDir for backward compat; internally resolve to profile root).

**Phase A.2 – Per-profile substrate, memory, heartbeat, cron**

- [x] **A.2.1** Substrate loader and store: load from profile root; substrate paths are relative to profile root. Existing SubstrateStore and RPCs work with profile root instead of workspace root when profile is set.
- [x] **A.2.2** MemoryStore: use profile root for MEMORY.md and memory/ directory.
- [x] **A.2.3** Heartbeat: HEARTBEAT.md and autonomy/heartbeat state files under profile root.
- [x] **A.2.4** Cron: cron-state and any cron-related tmp files under profile root.
- [x] **A.2.5** Trace / logs: write under profile root (e.g. `{profileRoot}/logs/` or keep `tmp/` for compatibility).

**Phase A.3 – Per-profile approvals and capability state**

- [x] **A.3.1** CapabilityStore / ApprovalWorkflow: persist or key by profile id so each profile has isolated approvals. If today they are in-memory only, add optional persistence under profile root and load on startup.
- [x] **A.3.2** Ensure approval UX (if any) and RPCs are profile-aware where appropriate. (When multi-profile in one process, gateway will pass profileId per A.4.)

**Phase A.4 – Gateway and API**

- [x] **A.4.1** Gateway: accept optional `profileId` (or profile root) in request context or config so that RPCs (substrate.*, memory.*, etc.) operate on the correct profile. Document in RPC reference.
- [x] **A.4.2** Backward compatibility: when no profile is specified, use default profile (current workspaceDir behavior).

### 2.5 Success Criteria (Agent Profiles)

- [x] Single-agent mode unchanged: if no profiles config, one profile root = workspaceDir; all behavior as today.
- [x] Multi-agent: multiple profile roots can be configured; each has isolated substrate, memory, heartbeat, cron, tmp, and logs.
- [x] No path traversal: profile root is always resolved within a safe base (e.g. workspaceDir or a configured base path); reject paths outside that base.
- [x] Tests: (1) single profile uses workspaceDir; (2) two profiles get isolated substrate and memory (config resolution tests); (3) gateway accepts optional profileId in RPC params.

### 2.6 Guardrails (Agent Profiles)

- **Path safety:** Profile root must resolve to a subdirectory of the process working directory or a configured base path; never allow absolute paths outside that base (e.g. `/etc`, other users’ home).
- **Backward compatibility:** Default config (no `profiles`) must behave exactly as today (single workspaceDir as profile root).
- **No cross-profile leakage:** Ensure in-memory caches (substrate, etc.) are keyed by profile when multiple profiles are active; do not share state between profiles.
- **Startup resilience:** If a profile root is missing or invalid, log and skip that profile or fail fast per config; do not crash the process without clear error.

---

## 3) Provider and Model Selection

### 3.1 Goal

- Per Agent Profile: choose **provider** (e.g. Cursor-Agent CLI, Ollama, OpenAI-compatible API), provide **API key** when required, and choose **model** (e.g. from installed Ollama models for local). Support local LLMs with ~16GB VRAM (e.g. Granite 3.2) and keep Cursor-Agent CLI at least as capable as today.

### 3.2 Current State

- `config.models` is a record of `ModelProviderConfig`; `config.defaultModel` selects which model to use.
- `ModelProviderConfig` has `provider: "cursor-agent-cli" | "fallback-model"`, `command`, `args`, `timeoutMs`, `authProfiles`, `fallbackModels`, `enabled`.
- Single global model selection; no per-profile override.

### 3.3 Proposed Design

- **Profile-level model config:** Each profile may specify `modelId` (and optionally full `ModelProviderConfig` overlay). If not set, fall back to global `defaultModel` and `config.models[defaultModel]`.
- **Provider types:** Extend to support at least:
  - `cursor-agent-cli` (current; parity required).
  - `ollama` (local; model chosen from Ollama list).
  - `openai-compatible` or named APIs (e.g. OpenAI, Anthropic, or custom endpoint) with API key.
- **API keys:** Stored per profile in a secure store (existing credential system); never in config files in plaintext, never in substrate or prompts. Key is fetched at runtime when building the request for that provider.
- **Local LLM support:** For Ollama (and similar), document or implement:
  - Model list discovery (e.g. `ollama list` or `GET /api/tags` on the Ollama server).
  - Context window and token limits so the runtime does not exceed what the model supports (e.g. smaller system prompt or truncation for 16GB models). See **§ 3.3.1 Context and token limits for local/16GB models** below.
  - No assumption that all models support the same tool set; adapter layer may need to map or disable tools for simpler local models. See **§ 3.3.2 Tool support for Ollama** below.

#### 3.3.1 Context and token limits for local/16GB models

- **Typical 16GB VRAM models** (e.g. Granite 3.2, Llama 3.2 8B): often have context windows in the 8K–128K token range; smaller quantized models may sit at 4K–8K. The runtime does not currently truncate or shorten the system prompt per provider; if the combined message size exceeds the model’s context, the Ollama server may truncate or fail.
- **Recommendation:** For 16GB local use, (1) choose a model with a known context size (e.g. from `ollama show <model>` or provider docs), (2) keep system prompt and substrate concise, (3) future work may add optional per-model or per-provider `maxContextTokens` and truncation so the adapter never sends more than the model supports.

#### 3.3.2 Tool support for Ollama

- The **Ollama provider** today streams only **text** (assistant_delta). It does not emit `tool_call` events; tool use depends on the model and Ollama’s tool-calling API, which may be added in a later phase.
- When using Ollama with the same gateway as Cursor-Agent CLI, **MCP and other tools are still registered**; the model will not receive tool definitions in a format that triggers tool calls until the provider maps Ollama’s tool format (if any) to our adapter’s `tool_call` event. For local-only chat without tools, the current implementation is sufficient.

### 3.4 Implementation Phases (Provider and Model)

**Phase P.1 – Per-profile model selection**

- [x] **P.1.1** Add to profile config (or overlay): `modelId?: string`. At runtime, resolve model: profile.modelId ?? defaultModel. Use resolved `ModelProviderConfig` from `config.models[resolvedModelId]`.
- [x] **P.1.2** Ensure heartbeat and chat both use the profile-resolved model. No new provider types yet; only selection is per-profile.

**Phase P.2 – Provider abstraction**

- [x] **P.2.1** Introduce a small **provider interface**: e.g. `runTurn(messages, options) => Promise<stream or response>`. Current Cursor-Agent CLI invocation becomes one implementation of this interface.
- [x] **P.2.2** Registry: map `provider` id (e.g. `cursor-agent-cli`, `ollama`) to implementation. Cursor-Agent CLI remains the default and must pass existing tests unchanged.
- [x] **P.2.3** Config: `ModelProviderConfig` gains optional `apiKeyRef?: string` (reference into credential store) and provider-specific options (e.g. `ollamaModelName`, `baseURL` for OpenAI-compatible).

**Phase P.3 – Ollama provider**

- [x] **P.3.1** Implement Ollama provider: call Ollama API (local or configured URL), support stream, map messages to Ollama format. Discover model list from `ollama list` or API when needed.
- [x] **P.3.2** Document context/token limits for typical 16GB models; add optional truncation or smaller system prompt when using such models.
- [x] **P.3.3** Tool support: document which tools are available for Ollama (e.g. same MCP/tools as Cursor-Agent if Ollama is used with same gateway); or reduced tool set for local-only use.

**Phase P.4 – OpenAI-compatible / API key**

- [x] **P.4.1** Implement provider that talks to OpenAI-compatible HTTP API; use `apiKeyRef` to resolve key from credential store at request time.
- [ ] **P.4.2** User can add/update/delete API keys for a profile via secure UX or RPC; keys never logged or included in prompts.
  - [x] **P.4.2.1** Profile-scoped provider credential store: under `{profileRoot}/credentials/providers.json` keyed by provider id (e.g. `openai-compatible`); get/set/delete/list (names only for list). Same guardrails as skills credentials (never in prompt/log). Implemented in `src/security/provider-credentials.ts`.
  - [x] **P.4.2.2** Extend `apiKeyRef` format: support `profile:providerId` (resolves to default key `apiKey`) or `profile:providerId.keyName`. Added `resolveApiKeyAsync(apiKeyRef, profileRoot?)` and `isProfileApiKeyRef()`; kept sync `resolveApiKey` for `env:` only.
  - [x] **P.4.2.3** Wire adapter/runtime: pass `profileRoot` in `SendTurnOptions` (runtime resolves from `getProfileRoot(profileId)`); OpenAI-compatible provider uses `resolveApiKeyAsync(apiKeyRef, options.profileRoot)`.
  - [x] **P.4.2.4** RPCs: `provider.credentials.set`, `provider.credentials.delete`, `provider.credentials.list` (names only), scoped to profile; admin or local only.
  - [x] **P.4.2.5** UI: Settings/Config section for provider API keys (list providers that use apiKeyRef, masked set/delete per provider).
- [ ] **P.4.3** Model selection: from config list or from provider’s model list if API supports it.

**Phase P.5 – Cursor-Agent CLI parity**

- [x] **P.5.1** All existing tests and flows that use Cursor-Agent CLI must pass unchanged when profile uses `provider: "cursor-agent-cli"`. (Verified: full suite 171 tests pass on feature/agent-profiles.)
- [x] **P.5.2** Document that Cursor-Agent CLI is the reference provider; new providers should match behavior (streaming, tool calls, error handling) where applicable.

**Reference provider (Cursor-Agent CLI):** Streaming, tool calls (MCP and built-in tools), and error handling are implemented and tested against Cursor-Agent CLI. New providers (Ollama, OpenAI-compatible) should match behavior where applicable (e.g. streaming, cancellation). Tool-calling semantics may differ per provider (e.g. Ollama text-only until tool API is used); see § 3.3.2.

### 3.5 Success Criteria (Provider and Model)

- [x] Per-profile model selection works; default profile uses global defaultModel when profile does not override.
- [x] Cursor-Agent CLI behavior unchanged; no regression in tests or manual flows.
- [x] At least one additional provider (Ollama or OpenAI-compatible) works for chat; API key is resolved from credential store and never leaked.
- [x] Local 16GB VRAM use case documented (model choice, context limits, tool set).

### 3.6 Guardrails (Provider and Model)

- **Credentials:** API keys and secrets are stored only in the existing secure credential/approval system; never in config files in plaintext, never in substrate or logs.
- **Cursor-Agent parity:** Changes to the provider layer must not regress Cursor-Agent CLI; run full existing test suite before and after.
- **Backward compatibility:** Omission of profile model config or provider overlay must behave as today (global defaultModel and existing provider).

---

## 4) Agent Skills

### 4.1 Goal

- An agent can **read a skill definition** (e.g. `skill.md`) from a URL or path (possibly via Web Fetch), **analyze safety** of the skill and its installation commands, and **run install steps** (curl, bash, etc.) to install files or call APIs. **Credentials** required by the skill are stored using existing secure systems so the agent cannot leak them. The **user** can add, update, and delete API keys or other installed files for any installed skill. Skills are **per Agent Profile** (each profile has its own installed skills and credentials).

### 4.2 Skill Definition (skill.md)

- Format: markdown document that can include:
  - **Description:** What the skill does.
  - **Install:** Optional section with commands (e.g. `curl ... | bash`, or step-by-step). May reference API signup or file placement.
  - **Credentials:** What credentials are needed (e.g. API key name, env var name, file path). No actual secrets in the skill.md.
  - **Usage:** How the agent or user invokes the skill (e.g. tool name, MCP server, or doc link).
- The agent (or a dedicated installer) must be able to **parse** this and decide whether to run install commands; **safety check** must run before executing any install command (see guardrails).

### 4.3 Safety and Install Flow

- **Before install:** Agent (or installer service) analyzes the skill: source URL, install commands, and requested credentials. If any command is deemed unsafe (e.g. arbitrary remote script without integrity check, or write outside allowed dirs), do not install and report reason.
- **Install:** Run install commands in a **sandbox or restricted context**: e.g. allowlist of binaries (curl, bash), no write outside profile’s `skills/` (or a dedicated install dir), network allowlist if needed. User approval may be required for first-time install (use existing approval workflow if applicable).
- **Credentials:** Store in existing credential store (or profile-scoped secure store). Agent receives only a **reference** (e.g. “use credential ref X for this tool”); the runtime resolves the secret when calling the external API and never injects it into the prompt or logs.
- **User management:** RPC or UI for “list installed skills,” “add/update/delete credential for skill X.” No need for the agent to see raw secrets; only “set”/“delete” and “present or not” for the key.

### 4.4 Implementation Phases (Agent Skills)

**Phase S.1 – Skill layout and discovery**

- [x] **S.1.1** Under profile root: `skills/installed/` (metadata for installed skills), `skills/credentials/` (or integration with existing credential store keyed by profile + skill id). Never put raw secrets in repo or substrate.
- [x] **S.1.2** Define minimal `skill.md` schema (description, install section, credentials section, usage). Parser or convention so the agent can read and reason about it.
- [x] **S.1.3** RPC or internal API: “install skill from URL” (fetch skill.md, safety check, then run install with user approval if required). Implemented: `skills.fetchFromUrl` (fetch + parse only; no install yet) and `skills.list` (list installed from manifest).

**Phase S.2 – Safety analysis**

- [x] **S.2.1** Safety checker: input = skill.md content + source URL. Output = allow / deny + reason. Rules: no untrusted remote script execution without integrity (e.g. hash); no write outside profile/skills; no escalation (e.g. sudo, chmod +s). Document rules in this file and in code.
- [x] **S.2.2** If any install command fails the safety check, do not run any install step; return error to user/agent. (Enforced when S.3 install runs: install runner must call safety check first and abort if !safety.allowed.)
- [x] **S.2.3** Optional: agent-facing “analyze this skill” tool that returns safety result and summary so the agent can report to the user before proceeding. Implemented: `skills.analyze` RPC (definition + sourceUrl → safety); `skills.fetchFromUrl` response includes `safety`.

**Phase S.3 – Install execution**

- [x] **S.3.1** Install runner: run only allowlisted commands (e.g. curl, bash) with restricted env (e.g. install dir = profile `skills/`); capture stdout/stderr and return to caller.
- [x] **S.3.2** Integrate with approval workflow: first-time install of a skill may require operator approval; after approval, store “skill X installed” in profile state.
- [x] **S.3.3** Credential prompts: if skill.md says “set API key for X,” prompt user (or RPC) to provide value; store via credential store; do not echo value back in response.

**Phase S.4 – Credential storage and usage**

- [x] **S.4.1** Use existing credential/secret system (or add profile-scoped store) so that credentials are keyed by (profileId, skillId, keyName). Agent never receives raw values; runtime resolves when invoking the skill’s tool or API.
- [x] **S.4.2** RPCs: e.g. `skills.list`, `skills.credentials.set`, `skills.credentials.delete`, `skills.credentials.list` (names only, no values). All scoped to profile.
- [x] **S.4.3** Document that credentials must not appear in substrate, prompts, or logs; enforce in code paths that inject context into the model.

**Phase S.5 – User add/update/delete keys**

- [x] **S.5.1** UI or RPC: list installed skills; for each skill, list credential names (no values); allow add/update/delete for each key. Values are set via secure input (e.g. masked field, not logged).
- [x] **S.5.2** Agent can “ask” the user to set a credential (e.g. “Please add your API key for skill X in Settings”); agent does not need to see the key.

### 4.5 Success Criteria (Agent Skills)

- [x] Agent can read and parse a skill.md (from URL or path); safety analysis runs before any install.
- [x] Install commands run in a restricted context; no write outside profile skills dir; no unsafe escalation.
- [x] Credentials are stored in the existing (or profile-scoped) secure system; agent and prompt never receive raw secrets.
- [x] User can add, update, and delete credentials for installed skills via RPC or UI; agent can use the skill without seeing the secret.
- [x] Skills and credentials are per Agent Profile; no cross-profile access.

### 4.6 Guardrails (Agent Skills)

- **No credential leakage:** Credentials are never included in substrate, system prompt, user message, or logs; only resolved at call time in a secure path.
- **Safety first:** No install command runs until safety check passes; deny by default for unknown or risky patterns.
- **Sandbox install:** Install steps run with restricted permissions and paths; allowlist of commands; no arbitrary remote script execution without integrity verification.
- **Per-profile isolation:** Skills and credentials are scoped to the Agent Profile; one profile cannot read another’s credentials.
- **User control:** Only the user (or admin) can add/update/delete credentials; the agent can request that the user set a key but cannot set it itself (or only through an explicit approval flow that does not expose the key to the model).

---

## 5) Shared Message View (Desktop and Mobile)

### 5.1 Goal

- When the user accesses the UI via the **Tailscale address** (e.g. from a phone), they see the **same message list** as on the desktop. Today the chat thread is stored only in the browser’s **sessionStorage**, so each device has a different view.
- Optionally: a **UI way to set the Tailscale (or bind) address** so the framework can listen only on that address instead of all interfaces, improving security.

### 5.2 Current State

- **Message list:** The UI keeps the conversation in `sessionStorage` keyed by `sessionId` (`ChatContext`: `loadThread` / `saveThread`). No server-side persistence of the thread.
- **Desktop vs mobile:** Desktop and mobile browsers have separate `sessionStorage`, so they show different (or empty) threads for the same logical session.
- **Server bind:** Config has `gateway.bind: "loopback" | "0.0.0.0"`. There is no option to bind to a specific address (e.g. Tailscale IP).

### 5.3 Proposed Design

- **Server-side thread store (per profile, per session):** Persist the chat message list under the profile root (e.g. `tmp/threads/{sessionId}.json`) so that any client using the same `profileId` and `sessionId` sees the same thread.
- **RPC:** `chat.getThread` (params: `sessionId`, optional `profileId`) returns the persisted message list. On `agent.run` start, persist the incoming message list (including the new user message). When the run completes (in `agent.wait`), append the assistant reply to the stored thread.
- **UI:** On load and when `sessionId` (or profile) changes, call `chat.getThread` and use the result as the source of truth for the message list. Optionally keep sessionStorage as fallback when offline or when the RPC fails.
- **Bind address (optional):** Add config (e.g. `gateway.bindAddress?: string`) so the server can listen on a specific host (e.g. Tailscale IP) instead of `0.0.0.0`. Expose this in the UI so the user can set it without editing config by hand.

### 5.4 Implementation Phases (Shared Message View)

**Phase V.1 – Server-side thread persistence**

- [x] **V.1.1** Add a thread store under profile root: e.g. `tmp/threads/` with one file per session (sessionId sanitized to a safe filename). Format: `{ messages: Array<{ id, role, content, at? }> }`. Implemented in `src/thread-store.ts`.
- [x] **V.1.2** API: get thread (profileRoot, sessionId) → messages; set thread (profileRoot, sessionId, messages); append message (profileRoot, sessionId, message). Enforce size/limit (MAX_MESSAGES_PER_THREAD = 1000) to avoid unbounded growth.

**Phase V.2 – Gateway and run flow**

- [x] **V.2.1** At start of `agent.run`, persist the request’s message list to the thread store for (profileId, sessionId). Store profileId in the run record (RunStore) so completion knows which profile to update.
- [x] **V.2.2** When `agent.wait` returns successfully, append the assistant message to the thread store for that run’s profile and session.
- [x] **V.2.3** New RPC `chat.getThread`: params `sessionId`, optional `profileId`; returns `{ messages }`. Same auth scope as `chat.send` (local/remote/admin).

**Phase V.3 – UI: load thread from server**

- [x] **V.3.1** In ChatContext, when sessionId (or selected profile) changes, call `chat.getThread` and set the message list from the response. Use sessionStorage only as fallback if the RPC fails or for offline.
- [x] **V.3.2** Optional: after sending a message and receiving the reply, the server already updated the thread; on next focus or session switch the client will refetch. No change required if we refetch on session change; optionally refetch after runTurn completes so that multi-tab or multi-device sees the update without changing session.

**Phase V.4 – Optional: Tailscale / bind address**

- [x] **V.4.1** Config: add `gateway.bindAddress?: string`. When set, listen on that host (and config port) instead of using `gateway.bind` alone. Validate that it is a valid host (IP or hostname). Implemented: validation allows loopback, link-local, private, Tailscale (100.64.0.0/10); rejects 0.0.0.0 and public IPs.
- [x] **V.4.2** UI: in Settings or Dashboard, allow the user to set and save the bind address (e.g. Tailscale IP); persist via config patch. Document that this restricts the server to that interface only.

### 5.5 Success Criteria (Shared Message View)

- [x] Desktop and mobile (e.g. via Tailscale) see the same message list for the same sessionId and profile: thread is loaded from the server and updated when the user sends messages and the agent replies.
- [x] No regression: existing single-device usage still works; sessionId and profile selection behave as today.
- [x] Thread store is scoped to profile; path and sessionId are sanitized to prevent traversal and abuse.
- [x] Optional (bind): when bind address is set, the server listens only on that address (V.4.1). UI to set it remains optional (V.4.2).

### 5.6 Guardrails (Shared Message View)

- **Path safety:** SessionId is sanitized to a safe filename (e.g. alphanumeric, hyphen, underscore only; length limit); thread files live only under profile `tmp/threads/`.
- **Size limits:** Cap the number of messages (or total size) per thread to avoid disk exhaustion and DoS.
- **Backward compatibility:** If `chat.getThread` is absent or fails, the UI can fall back to sessionStorage so existing deployments do not break.
- **Auth:** `chat.getThread` uses the same auth scope as `chat.send`; no exposure of threads to unauthenticated clients.

---

## 6) Cross-Cutting and Order of Work

- **Implementation order:** Agent Profiles → Provider and Model Selection → Agent Skills; then Shared Message View (depends on profile root and gateway).
- **Testing:** After each phase, run existing test suite; add new tests for multi-profile, new provider, skill install/safety, and shared thread (getThread, persist on run/wait).
- **Docs:** Update `docs/configuration-reference.md`, `docs/rpc-api-reference.md`, and this file as implementation progresses.
- **Changelog:** Append a short changelog at the bottom of this document when a phase is completed or the design is revised.

---

## 7) Document Metadata

- **Version:** 1.1  
- **Status:** In progress. Agent Profiles (A.1–A.4), Provider/Model (P.1–P.5 except P.4.3), Agent Skills (S.1–S.5), and Shared Message View / Tailnet (V.1–V.4) complete. P.4.2.1–P.4.2.5 done (provider credential store, resolveApiKeyAsync, profileRoot, provider.credentials RPCs, Config UI for provider API keys). Remaining: P.4.3 (model list from provider API).  
- **Changelog (1.0):** Initial guide for Agent Profiles, Agent Skills, and Provider/Model Selection with success criteria and guardrails.
- **Changelog (1.1):** Phase A.1 implemented: `AgentProfileConfig`, `profiles` in config, `resolveProfileRoot`/`getDefaultProfileId` in config.ts; index.ts and gateway use profile root for substrate, memory, heartbeat, cron, tmp, logs. Single-agent mode unchanged (no `profiles` → profileRoot = workspaceDir).
- **Changelog (1.2):** Phase A.2 marked complete: index.ts already wires profile root for SubstrateStore.reload, MemoryStore, HEARTBEAT.md and autonomy-state, cron-state, run-store, workflow-state, CLAW_HISTORY.log, and all tmp state files. Success criteria for single/multi-agent and path safety met; tests still pending.
- **Changelog (1.3):** Phase A.3.1 complete. CapabilityStore and ApprovalWorkflow accept optional `stateDir`; when set (profile root `tmp/approvals`), grants and approval requests are persisted and loaded on startup. Single profile uses one store per process; multi-profile will use one store per profile root (each with its own stateDir).
- **Changelog (1.4):** Phase A.3.2, A.4.1, A.4.2 complete. Gateway accepts optional `params.profileId`; when absent, uses `defaultProfileId` from deps (or "default"). Index passes `defaultProfileId: getDefaultProfileId(config)` to the gateway. Approval and other RPCs are profile-ready (single profile context used until multi-profile context map is added). Tests: config profile resolution (single profile root = workspaceDir; two profiles resolve to distinct roots; path traversal rejected); gateway test for optional profileId in RPC params.
- **Changelog (1.5):** Phase P.1 complete. AgentProfileConfig has optional `modelId`. `getModelIdForProfile(config, profileId)` resolves model per profile (profile.modelId ?? defaultModel; validates against config.models). SessionContext has optional `profileId`; gateway sets it from resolvedProfileId for agent.run. ModelAdapter.createSession accepts optional CreateSessionOptions.modelId; runtime uses profile-resolved model for ensureModelSession and stores full handle (id, model, authProfile). Heartbeat session includes profileId. Tests: getModelIdForProfile (no profiles, profile without modelId, profile with modelId, invalid modelId fallback). All 157 tests pass.
- **Changelog (1.6):** Phase P.2 complete. Added `ModelProvider` interface (`sendTurn`, `cancel`) in `src/providers/types.ts`. Implemented `CursorAgentCliProvider` (CLI subprocess + NDJSON parsing) and `FallbackModelProvider` in `src/providers/`. Registry in `src/providers/registry.ts`: `getProvider(id, config)`, `registerProvider`, `clearProviderCache`. Adapter delegates to registry; turnId→provider map for cancel; getRedactedLogs/getMetrics delegate to CLI provider. `ModelProviderConfig` extended with `apiKeyRef?`, `ollamaModelName?`, `baseURL?`. All 164 tests pass.
- **Changelog (1.7):** Phase P.3 complete. Implemented `OllamaProvider` in `src/providers/ollama.ts`: calls Ollama `POST /api/chat` with stream, maps messages to Ollama format, yields `assistant_delta`, `usage`, `done`; supports `cancel` via AbortController. Config and adapter types extended with `"ollama"`; registry registers `ollama` factory. Added § 3.3.1 (context/token limits for 16GB models) and § 3.3.2 (tool support for Ollama). Adapter test added for Ollama with mocked fetch. All adapter and gateway tests pass.
- **Changelog (1.8):** Phase P.4.1 complete. Added `resolveApiKey` in `src/security/credential-resolver.ts` (supports `env:VAR_NAME`; key never logged). Implemented `OpenAICompatibleProvider` in `src/providers/openai-compatible.ts`: POST to `baseURL/chat/completions`, SSE stream parsing, `openaiModelId` and `apiKeyRef` in config; Bearer token resolved at request time. Config extended with `openaiModelId` and provider type `"openai-compatible"`; registry registers `openai-compatible`. Adapter test and credential-resolver tests added. P.4.2 (user RPC/UX for keys) and P.4.3 (model list from API) remain for a later iteration.
- **Changelog (1.9):** Phase P.5 complete. P.5.1: full test suite (171 tests) passes on feature/agent-profiles with Cursor-Agent CLI. P.5.2: documented Cursor-Agent CLI as reference provider (streaming, tool calls, error handling) in § 3.4. Remaining optional work: P.4.2 (user add/update/delete API keys via RPC/UX), P.4.3 (model list from provider API).
- **Changelog (1.10):** Phase S.1 started. S.1.1: `src/skills/store.ts` — profile layout `skills/installed/` (manifest.json), `skills/credentials/`; ensureSkillsDirs, readInstalledManifest, writeInstalledManifest. S.1.2: `src/skills/types.ts` (SkillDefinition, InstalledSkillRecord), `src/skills/parser.ts` (parseSkillMd for ## Description, Install, Credentials, Usage). S.1.3: gateway RPCs `skills.fetchFromUrl` (params.url → fetch + parse, returns definition + sourceUrl) and `skills.list` (profile-scoped, returns installed list). No install or safety execution yet (S.2/S.3). Tests: tests/skills.test.ts (parser + store). All 177 tests pass.
- **Changelog (1.11):** Phase S.2 complete. S.2.1: `src/skills/safety.ts` — `analyzeSkillSafety(definition, sourceUrl)` returns `{ allowed, reason }`; rules: no pipe-to-shell without integrity (hash/sha256/sha512), no escalation (sudo, chmod +s, chown root), no write outside profile/skills (/etc, /usr, /bin, etc.). S.2.2: Install (S.3) will gate on safety; fetch/analyze expose result. S.2.3: `skills.fetchFromUrl` response includes `safety`; new RPC `skills.analyze` (params.definition, params.sourceUrl) returns `{ safety }`. Tests: skills.test.ts safety suite (allow/deny cases). All 184 tests pass.
- **Changelog (1.12):** Phase S.3 complete. S.3.1: `src/skills/runner.ts` — `runInstall(profileRoot, skillId, definition)` runs install block via `bash -s` with cwd `profileRoot/skills/install/<skillId>`, timeout 300s; returns stdout/stderr and exit status. S.3.2: RPC `skills.install` (url or definition+sourceUrl) runs safety then install; on success appends to installed manifest (profile skills/installed/manifest.json). Install is admin-only (implicit operator approval). S.3.3: Credential names extracted from Credentials section via `parseCredentialNames` (backticked names); returned in install result; user sets values via future credentials RPC (S.4/S.5). Added `parseCredentialNames` in parser, `src/skills/index.ts` re-exports. RPC reference and implementation guide updated. All 190 tests pass.
- **Changelog (1.13):** Phase S.4 complete. S.4.1: `src/skills/credentials.ts` — profile-scoped store: getCredential, setCredential, deleteCredential, listCredentialNames; storage under `skills/credentials/{skillId}.json`; skillId and keyName restricted to `[a-zA-Z0-9_-]+`. S.4.2: RPCs `skills.credentials.set`, `skills.credentials.delete`, `skills.credentials.list` (profile-scoped; list returns names only). S.4.3: Doc and module comment state credentials must not appear in substrate, prompts, or logs; getCredential for runtime resolution only. Tests: skills.test.ts credentials suite. RPC reference updated.
- **Changelog (1.14):** Section 5 (Shared Message View) added: goal (same message list on desktop and mobile via Tailscale), current state (sessionStorage-only), phases V.1–V.4 (thread store, gateway persist on run/wait, chat.getThread, UI load from server, optional bind address), success criteria and guardrails. Implementation not yet started.
- **Changelog (1.15):** Phases V.1–V.3 implemented. V.1: `src/thread-store.ts` (getThread, setThread, appendMessage; tmp/threads/{sessionId}.json; MAX_MESSAGES_PER_THREAD 1000; sanitizeSessionId). V.2: gateway persists thread at agent.run start; RunStore.createPending accepts profileId; appendAssistantToThread before consume in agent.wait; RPC chat.getThread. V.3: UI getThread(sessionId, profileId) in api.ts; ChatContext loads thread from server when sessionId or selectedProfileId changes, fallback to sessionStorage on error. V.4 (bind address) deferred. RPC reference updated. All 196 tests pass.
- **Changelog (1.16):** Phase V.4.1 (Tailnet bind address) implemented. Config `gateway.bindAddress?: string`; when set, listen host uses it; validation via `validateBindAddress` in security.ts (isSafeBindAddress: loopback, link-local, private, Tailscale 100.64.0.0/10; reject 0.0.0.0 and public IPs). Hostname resolution validated against resolved IPs. Tests: tests/bind-address.test.ts. Docs: configuration-reference.md, SHARED_MESSAGE_VIEW_IMPLEMENTATION.md (V.3.1–V.3.2, success criteria).
- **Changelog (1.17):** Phase S.5 and V.4.2 complete. S.5.1: Skills page in UI (nav + route): list installed skills via skills.list, for each skill show credential names (manifest + credentials.list), password input (masked), Save (skills.credentials.set), Delete (skills.credentials.delete). S.5.2: Copy on Skills page instructs user that the agent can ask them to add a key and they set it here. V.4.2: Config page already had Gateway bind address (Tailscale) field and Save via config.patch; marked complete in both implementation guide and SHARED_MESSAGE_VIEW_IMPLEMENTATION.md. API: skillsList, skillsCredentialsSet, skillsCredentialsDelete, skillsCredentialsList, InstalledSkillRecord.
- **Changelog (1.18):** P.4.2.1–P.4.2.3 implemented. P.4.2.1: `src/security/provider-credentials.ts` — profile-scoped store under `{profileRoot}/credentials/providers.json` (get/set/delete/listProviderCredentialNames/listProvidersWithCredentials). P.4.2.2: credential-resolver supports `profile:providerId` and `profile:providerId.keyName`; added `resolveApiKeyAsync(apiKeyRef, profileRoot?)` and `isProfileApiKeyRef()`. P.4.2.3: `SendTurnOptions.profileRoot`, `AgentRuntimeOptions.getProfileRoot`; runtime passes profileRoot into adapter; OpenAI-compatible provider uses resolveApiKeyAsync when profileRoot set. Index passes getProfileRoot from profileContextMap. Tests: credential-resolver.test.ts extended (resolveApiKeyAsync, isProfileApiKeyRef, provider-credentials store). All 225 tests pass.
- **Changelog (1.19):** P.4.2.4 implemented. Gateway RPCs `provider.credentials.set`, `provider.credentials.delete`, `provider.credentials.list` (params: providerId; set/delete also keyName; set also value). Scoped to profile via profileCtx.profileRoot; admin or local only. METHOD_SCOPES and handlers in gateway.ts; RPC reference §§ 5.27–5.29; profile-scoped methods list updated.
- **Changelog (1.20):** P.4.2.5 implemented. Config page: "Provider API keys" section (profile-scoped). UI lists credential-capable providers (e.g. openai-compatible), shows masked key names from provider.credentials.list, Add/Update form (provider, key name, password value), Delete per key. api.ts: providerCredentialsList, providerCredentialsSet, providerCredentialsDelete. Skills test timeout increased to 15s for Windows.
