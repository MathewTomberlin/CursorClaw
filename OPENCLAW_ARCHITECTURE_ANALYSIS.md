# OpenClaw Architecture Analysis & Technical Specification

**Document Version:** 1.0  
**Date:** February 13, 2026  
**Purpose:** Detailed analysis of the OpenClaw repository (https://github.com/openclaw/openclaw) and a step-by-step technical spec for building an autonomous, living agent using Cursor-Agent CLI Auto model, with terminal loop, cron scheduling, remote access, and phone + desktop UI.

---

## Executive Summary

OpenClaw is a **personal AI assistant platform** that runs on your own devices. It uses a **Gateway** as the control plane, connecting to multiple messaging channels (WhatsApp, Telegram, Slack, Discord, etc.), and embeds the **pi-coding-agent** SDK for the agent runtime. The core loop is driven by **heartbeats** (periodic agent turns) and **cron** (scheduled jobs), with session persistence, tool execution, and memory via workspace files.

**Our goal:** Build an autonomous agent that:
- Runs in a **terminal loop** (possibly with cron)
- Uses **Cursor-Agent CLI Auto** as the inference model
- Is **remotely accessible** (SSH tunnel, Tailscale)
- Has **phone + desktop UI** interfaces

---

## Part 1: OpenClaw Deep Analysis

### 1.1 System Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CHANNELS (WhatsApp, Telegram, Slack, Discord, WebChat, etc.)           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  GATEWAY (WebSocket + HTTP on port 18789)                                │
│  • Auth: token/password/Tailscale                                         │
│  • Channel routing, pairing, allowlists                                  │
│  • Cron scheduler, heartbeat timer                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ├─ Pi Agent (embedded runtime)
                                    ├─ CLI (openclaw …)
                                    ├─ WebChat UI
                                    ├─ macOS / iOS / Android apps
                                    └─ Node hosts (remote exec, etc.)
```

### 1.2 Agent Loop (Core Execution Path)

**Entry points:**
- `agent` RPC (Gateway WebSocket)
- `agent.wait` RPC
- CLI: `openclaw agent --message "..."`

**Flow:**
1. `agent` RPC validates params, resolves session, returns `{ runId, acceptedAt }` immediately.
2. `agentCommand` runs the agent:
   - Resolves model + thinking/verbose defaults
   - Loads skills snapshot
   - Calls `runEmbeddedPiAgent()` (pi-agent-core runtime)
   - Emits lifecycle end/error events
3. `runEmbeddedPiAgent`:
   - Serializes runs via per-session + global queues
   - Resolves model + auth profile and builds the pi session
   - Subscribes to pi events and streams assistant/tool deltas
   - Enforces timeout (default 600s)
   - Returns payloads + usage metadata
4. `subscribeEmbeddedPiSession` bridges pi events to OpenClaw `agent` stream:
   - Tool events → `stream: "tool"`
   - Assistant deltas → `stream: "assistant"`
   - Lifecycle events → `stream: "lifecycle"`

**Key files:**
- `src/agents/pi-embedded-runner/run.ts` — main entry
- `src/agents/pi-embedded-runner/attempt.ts` — single attempt logic
- `src/agents/pi-embedded-subscribe.handlers.ts` — event handlers

### 1.3 Heartbeat vs Cron (Loop Mechanisms)

| Mechanism | Purpose | Session | Timing |
|-----------|---------|----------|--------|
| **Heartbeat** | Periodic awareness (inbox, calendar, check-ins) | Main session | Configurable interval (default 30m) |
| **Cron** | Exact scheduling, one-shot reminders, isolated tasks | Main or isolated |

**Heartbeat:**
- Runs in main session at configurable interval (e.g. `every: "30m"`)
- Default prompt: `Read HEARTBEAT.md if it exists. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.`
- `HEARTBEAT_OK` suppresses output when no alert needed
- Config: `agents.defaults.heartbeat.every`, `target`, `activeHours`, `prompt`

**Cron:**
- Jobs stored in `~/.openclaw/cron/jobs.json`
- Two modes: `main` (system event → next heartbeat) or `isolated` (dedicated turn in `cron:<jobId>`)
- Schedule kinds: `at` (one-shot), `every` (interval), `cron` (5-field expression)
- Isolated jobs can run with different model/thinking and deliver directly to channel

**Decision:** Use **heartbeat** for continuous awareness; use **cron** for exact timers and one-shot reminders.

### 1.4 Agent Rules & Configuration Files

**Workspace layout:**
- `AGENTS.md` — main instructions, rules, safety
- `SOUL.md` — identity, tone, boundaries
- `USER.md` — who the agent is helping
- `MEMORY.md` — long-term memory (main session only)
- `memory/YYYY-MM-DD.md` — daily logs
- `HEARTBEAT.md` — heartbeat checklist (optional)
- `TOOLS.md` — environment-specific notes

**System prompt assembly:**
- Built by `buildAgentSystemPrompt()` in `src/agents/system-prompt.ts`
- Sections: Tooling, Safety, Skills, Workspace, Sandbox, Current Date & Time, Reply Tags, Heartbeats, Runtime
- Bootstrap files injected: AGENTS.md, SOUL.md, TOOLS.md, USER.md, MEMORY.md, HEARTBEAT.md, etc.

**Skills:**
- AgentSkills-compatible folders with `SKILL.md`
- Locations: bundled → `~/.openclaw/skills` → `<workspace>/skills`
- Gating: `metadata.openclaw.requires.bins`, `requires.env`, `requires.config`

### 1.5 API Access & Gateway

**Gateway:**
- WebSocket + HTTP on single port (default 18789)
- Bind modes: `loopback` (default), `lan`, `tailnet`, `custom`
- Auth: `gateway.auth.mode: "token"` or `"password"` (required by default)

**RPC methods:**
- `agent`, `agent.wait` — run agent
- `chat.history`, `chat.send`, `chat.inject` — chat
- `cron.list`, `cron.add`, `cron.run`, etc.
- `sessions.list`, `session.status`

**Remote access:**
- SSH tunnel: `ssh -N -L ...` to forward gateway port
- Tailscale Serve/Funnel for HTTPS + auth
- `gateway.remote.url`, `gateway.remote.token` for CLI remote mode

### 1.6 UI (WebChat, Control UI, Mobile)

**WebChat:**
- Connects to Gateway WebSocket
- Uses `chat.history`, `chat.send`, `chat.inject`
- No embedded browser; native SwiftUI on macOS/iOS/Android

**Control UI:**
- Dashboard: `http://127.0.0.1:18789/`
- Config, channels, sessions, cron, nodes, logs
- Requires token/password when auth enabled

**Mobile:**
- iOS/Android apps with Canvas, Voice Wake, Talk Mode
- Bonjour pairing for local discovery

### 1.7 Memory & Personality

**Memory:**
- Plain Markdown in workspace
- `memory/YYYY-MM-DD.md` — daily log (append-only)
- `MEMORY.md` — long-term (main session only)
- Vector search via `memory_search` tool (SQLite, optional QMD backend)

**Personality:**
- `SOUL.md` defines identity, tone, boundaries
- `AGENTS.md` defines rules, safety, group behavior
- Injected into system prompt on every turn

**Pre-compaction memory flush:**
- When session nears compaction, silent turn reminds model to write memory
- Config: `agents.defaults.compaction.memoryFlush`

### 1.8 Tools & Function Calling

**Tool pipeline:**
1. Base tools (read, edit, write) — replaced/customized for sandbox
2. OpenClaw tools: exec, browser, canvas, sessions, cron, gateway, message, nodes
3. Channel tools: Discord/Telegram/Slack/WhatsApp actions
4. Policy filtering: allowlist/denylist per agent, group, sandbox

**Exec tool:**
- `host`: `sandbox` (default) | `gateway` | `node`
- `security`: `deny` | `allowlist` | `full`
- `ask`: `off` | `on-miss` | `always`
- Approvals: `~/.openclaw/exec-approvals.json`

**Browser:**
- Dedicated Chrome/Brave profile (openclaw)
- CDP control via loopback relay
- Snapshots, click, type, navigate, etc.

**Tool schema:**
- pi-agent-core `AgentTool` → pi-coding-agent `ToolDefinition` via adapter

### 1.9 Internet Access

**Web tools:**
- `web_fetch` — fetch URLs (SSRF protection)
- `web_search` — search (Brave, Perplexity, etc.)
- `browser` — full browser control

**Security:**
- SSRF blocking for external fetches
- DNS pinning + IP blocking
- External content wrapped in XML tags for prompt injection awareness

### 1.10 Security (Critical)

**DM access:**
- `dmPolicy`: `pairing` (default) | `allowlist` | `open` | `disabled`
- `pairing`: unknown senders get code; approve via `openclaw pairing approve <channel> <code>`
- `allowFrom` — allowlist for DMs

**Group policy:**
- `groupPolicy`: `open` | `allowlist` | `requireMention` | `disabled`
- `groupAllowFrom` — who can trigger inside groups

**Gateway auth:**
- Token required by default (even loopback)
- `gateway.bind: "loopback"` — only local clients

**Threat model (MITRE ATLAS):**
- Trust boundaries: Channel → Gateway → Session → Tool Execution → External Content
- Key mitigations: pairing, allowlists, sandboxing, exec approvals, tool policy

**Audit:**
- `openclaw security audit` — flags common issues
- `openclaw security audit --fix` — applies safe guardrails

---

## Part 2: Cursor-Agent CLI Auto Integration

**Note:** OpenClaw does not natively support Cursor-Agent CLI Auto. The pi-coding-agent SDK uses Anthropic, OpenAI, Google, etc. via `ModelRegistry` and `AuthStorage`.

**To use Cursor-Agent CLI Auto:**
1. **Option A:** Add a custom provider/adapter that maps Cursor-Agent CLI to the pi `Model` interface.
2. **Option B:** Run Cursor-Agent as a subprocess and bridge via RPC/stdio (similar to legacy imsg).

**Cursor-Agent CLI Auto specifics (research needed):**
- CLI invocation pattern
- Input/output format (JSON, streaming?)
- Tool/function calling support
- Session/context handling

---

## Part 3: Technical Specification for Our Repo

### 3.1 Design Goals

- [ ] Autonomous agent running in terminal loop
- [ ] Cursor-Agent CLI Auto as inference model
- [ ] Cron (and/or heartbeat) for scheduling
- [ ] Remote access (SSH tunnel, Tailscale)
- [ ] Phone + desktop UI
- [ ] Security-first design

### 3.2 Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PHONE (WebChat / PWA)  │  DESKTOP (Control UI / CLI)                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  REMOTE ACCESS (SSH tunnel / Tailscale Serve)                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  GATEWAY (OpenClaw or fork)                                             │
│  • Auth: token/password                                                 │
│  • Cron scheduler                                                       │
│  • Heartbeat (optional)                                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  AGENT RUNTIME                                                          │
│  • Cursor-Agent CLI Auto (custom adapter) OR pi + Cursor-compatible API │
│  • Session persistence                                                  │
│  • Tools: exec, browser, message, etc.                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Implementation Steps

#### Phase 1: Foundation (Weeks 1–2)

| Step | Task | Success Criteria |
|------|------|-------------------|
| 1.1 | Fork or clone OpenClaw; set up dev environment | [ ] `pnpm install`, `pnpm build` succeeds |
| 1.2 | Configure workspace: `AGENTS.md`, `SOUL.md`, `HEARTBEAT.md` | [ ] Files exist and are injected |

#### Phase 2: Model Adapter (Weeks 2–4)

| Step | Task | Success Criteria |
|------|------|-------------------|
| 2.1 | Research Cursor-Agent CLI Auto API (invocation, I/O, streaming) | [ ] Documented CLI contract |
| 2.2 | Implement provider adapter (e.g. `CursorAgentProvider`) | [ ] Adapter implements pi `Model` interface or equivalent |
| 2.3 | Wire adapter into model resolution | [ ] `agents.defaults.model` can select Cursor-Agent |
| 2.4 | Test tool/function calling from Cursor-Agent | [ ] Exec, read, etc. work end-to-end |

#### Phase 3: Loop & Scheduling (Weeks 4–5)

| Step | Task | Success Criteria |
|------|------|-------------------|
| 3.1 | Enable heartbeat (default 30m) | [ ] Heartbeat runs every 30m |
| 3.2 | Add cron jobs for one-shot reminders | [ ] `openclaw cron add --at "20m"` works |
| 3.3 | Optional: systemd/cron for gateway daemon | [ ] Gateway survives restarts |

#### Phase 4: Remote Access (Weeks 5–6)

| Step | Task | Success Criteria |
|------|------|-------------------|
| 4.1 | Configure `gateway.bind: "loopback"` + token | [ ] Local clients require auth |
| 4.2 | Set up SSH tunnel or Tailscale Serve | [ ] Remote client can connect |
| 4.3 | Mobile: WebChat via tunnel or Tailscale | [ ] Phone can chat via WebChat |

#### Phase 5: UI & Polish (Weeks 6–7)

| Step | Task | Success Criteria |
|------|------|-------------------|
| 5.1 | Desktop: Control UI + WebChat | [ ] Full config, chat, sessions |
| 5.2 | Phone: WebChat PWA or native app | [ ] Chat works on mobile |

### 3.4 Success Criteria (Checkboxes)

**Core:**

- [ ] Agent runs autonomously (heartbeat or cron)
- [ ] Cursor-Agent CLI Auto used as inference model
- [ ] Session persistence works
- [ ] Tools (exec, message, etc.) work
- [ ] Memory (MEMORY.md, memory/*.md) works

**Access:**

- [ ] Remote access via SSH tunnel or Tailscale
- [ ] Desktop UI (Control UI + WebChat)
- [ ] Phone UI (WebChat or app)

**Security:**

- [ ] Gateway auth enabled
- [ ] DM policy = pairing (or allowlist)
- [ ] `openclaw security audit` passes or findings are documented

### 3.5 Guardrails

**Prevent bad implementation:**

1. **Model adapter:** Validate Cursor-Agent output format before parsing; fail closed on malformed responses.
2. **Tool policy:** Default `tools.deny: ["exec"]` for sandbox; require explicit allowlist for host exec.
3. **DM policy:** Never default to `dmPolicy: "open"`; require explicit `allowFrom: ["*"]` opt-in.
4. **Gateway bind:** Default `gateway.bind: "loopback"`; require explicit config for LAN/tailnet.
5. **Audit:** Run `openclaw security audit` in CI before deploy.

**Prevent incorrect implementation:**

1. **Session isolation:** Use `session.dmScope: "per-channel-peer"` if multiple users can DM.
2. **Memory:** Only load MEMORY.md in main session; never in group contexts.
3. **Cron vs heartbeat:** Use cron for exact timing; heartbeat for batched checks.

**Prevent unsafe implementation:**

1. **Exec approvals:** Require approvals for gateway/node host exec when `security != "deny"`.
2. **Secrets:** Never inject secrets into prompts; use env/config.
3. **Prompt injection:** Treat external content (web_fetch, URLs) as untrusted; wrap in XML tags.

---

## Part 4: Reference

### Key OpenClaw Paths

| Path | Purpose |
|------|---------|
| `~/.openclaw/openclaw.json` | Config |
| `~/.openclaw/workspace` | Default workspace |
| `~/.openclaw/agents/<agentId>/sessions/` | Session transcripts |
| `~/.openclaw/cron/jobs.json` | Cron jobs |
| `~/.openclaw/credentials/` | Credentials, allowlists |

### Key Docs

- [Pi Integration](https://docs.openclaw.ai/pi.md)
- [Agent Loop](https://docs.openclaw.ai/concepts/agent-loop)
- [Heartbeat](https://docs.openclaw.ai/gateway/heartbeat)
- [Cron Jobs](https://docs.openclaw.ai/automation/cron-jobs)
- [Security](https://docs.openclaw.ai/gateway/security)
- [Cron vs Heartbeat](https://docs.openclaw.ai/automation/cron-vs-heartbeat)

---

## Appendix A: Cursor-Agent CLI Auto Research Notes

TODO: Research and document:
- [ ] CLI invocation: `cursor-agent ?` or similar
- [ ] Input: stdin, file, or env?
- [ ] Output: streaming JSON, stdout?
- [ ] Tool/function calling format
- [ ] Session/context handling

---

## Appendix B: Threat Model Summary

| Threat | Mitigation |
|--------|------------|
| Unauthorized DM access | `dmPolicy: "pairing"`, allowlists |
| Prompt injection | Tool policy, sandboxing, external content wrapping |
| Exec abuse | Exec approvals, allowlist, sandbox |
| Gateway exposure | Loopback bind, token auth, Tailscale |
| Session leakage | `dmScope: "per-channel-peer"` for multi-user |
