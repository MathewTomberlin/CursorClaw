# Implementation Plan Improvements Summary

**Document Version:** 1.0  
**Date:** February 13, 2026  
**Purpose:** Suggested improvements to the OpenClaw implementation plan for a more responsive, lifelike, secure, and cost-effective autonomous agent.

---

## Executive Summary

This document analyzes the implementation plan in `OPENCLAW_ARCHITECTURE_ANALYSIS.md` and proposes improvements across four pillars: **functionality**, **reliability**, **token usage**, and **security**. The goal is to create an agent that feels more alive and responsive while being more secure and economical to operate.

---

## 1. Security Improvements (Highest Priority)

### 1.1 Defense in Depth — Add Missing Layers

**Current gaps:**
- The spec mentions pairing and allowlists but does not mandate a layered approach.
- No explicit rate limiting or abuse detection.
- No mention of audit logging for security events.

**Improvements:**

| Improvement | Description | Implementation Step |
|-------------|-------------|---------------------|
| **Rate limiting** | Throttle inbound messages per sender/channel to prevent DoS and prompt-injection spam | Add Phase 1.3: Configure `channels.*.rateLimit` (if supported) or implement gateway-level throttling |
| **Audit logging** | Log all pairing approvals, exec approvals, config changes, and tool calls to a tamper-evident store | Add Phase 1.4: Enable `logging.audit` and define retention policy |
| **Input sanitization** | Sanitize all user-facing input (message content, URLs, file paths) before passing to model | Add Phase 2.5: Implement input sanitization layer in agent pipeline |
| **Output filtering** | Filter model output for secrets, PII, and dangerous content before delivery | Add Phase 2.6: Implement output sanitization (redact identifiers, block exfiltration patterns) |

### 1.2 Hardening the Cursor-Agent Adapter

**Current risk:** A custom model adapter is a new trust boundary. Malformed or adversarial model output could bypass tool policy or leak context.

**Improvements:**

| Improvement | Description |
|-------------|-------------|
| **Strict output validation** | Parse Cursor-Agent output through a schema validator; reject any response that does not conform. Never trust free-form output for tool calls. |
| **Tool call sandboxing** | Even before exec approval, validate tool params against a strict schema (e.g., no `rm -rf /`, no `curl` to internal IPs). |
| **Context isolation** | Ensure Cursor-Agent cannot receive or emit raw session transcripts; use a sanitized message format that strips tool results and system prompts from user-visible context. |

### 1.3 Secure Defaults Checklist

**Add to Phase 1 (Foundation):**

- [ ] **File permissions:** Run `openclaw security audit --fix` to set `~/.openclaw` → 700, config → 600
- [ ] **mDNS minimal mode:** Set `discovery.mdns.mode: "minimal"` to avoid exposing `cliPath`, `sshPort` on the network
- [ ] **Trusted proxies:** If behind reverse proxy, configure `gateway.trustedProxies` to prevent IP spoofing
- [ ] **Session DM scope:** If any multi-user scenario, set `session.dmScope: "per-channel-peer"` from day one

### 1.4 Incident Response Runbook

**Add new phase: Phase 0 (Pre-Launch Security):**

| Step | Task |
|------|------|
| 0.1 | Document incident response: rotate token, revoke pairings, disable channels, review logs |
| 0.2 | Create a "kill switch" — env var or config flag to immediately disable agent runs while keeping gateway up |
| 0.3 | Define secret rotation schedule (gateway token, model keys) and store in runbook |

---

## 2. Token Usage Improvements

### 2.1 Bootstrap and Context Pruning

**Current:** AGENTS.md, SOUL.md, MEMORY.md, HEARTBEAT.md, etc. are injected on every turn. MEMORY.md can grow unbounded.

**Improvements:**

| Improvement | Description | Implementation |
|-------------|-------------|-----------------|
| **Bootstrap size caps** | Enforce `agents.defaults.bootstrapMaxChars` (default 20k) and add per-file caps for MEMORY.md | Phase 1.2: Set `bootstrapMaxChars: 15000`; add MEMORY.md truncation rule |
| **Lazy memory loading** | Do not inject MEMORY.md on every turn; inject only on main session start or when `memory_search` is used | Requires OpenClaw fork or config if supported |
| **HEARTBEAT.md minimal** | Keep HEARTBEAT.md under 500 chars; use bullet points, not prose | Phase 1.2: Add HEARTBEAT.md template with size guidance |
| **Context pruning** | Enable `agents.defaults.contextPruning.mode: "cache-ttl"` to prune stale tool results before context overflow | Phase 3.1: Add to agent config |

### 2.2 Heartbeat Optimization

**Current:** Heartbeat runs full agent turn every 30m. Each turn consumes tokens for system prompt + history + tools.

**Improvements:**

| Improvement | Description |
|-------------|-------------|
| **Adaptive heartbeat interval** | Use longer intervals during quiet hours (e.g., 1h at night) via `heartbeat.activeHours`; shorter (e.g., 15m) during business hours |
| **HEARTBEAT_OK early exit** | If HEARTBEAT.md is empty or effectively empty, OpenClaw can skip the heartbeat run entirely — ensure HEARTBEAT.md exists but is minimal when you want heartbeats |
| **Cheaper model for heartbeats** | Use `agents.defaults.heartbeat.model` to select a smaller/cheaper model for routine checks; reserve expensive model for user-initiated turns |

### 2.3 Cron vs Heartbeat — Token-Aware Routing

**Improvement:** Prefer isolated cron jobs for high-token tasks (e.g., "summarize last 7 days of emails") so they don't bloat main session history. Use heartbeat only for lightweight checks.

**Implementation:** Phase 3.2 — Add decision rule: "If task > N tool calls or > M tokens, use cron isolated instead of heartbeat."

### 2.4 Session Pruning and Compaction

**Improvements:**

- Enable **session pruning** (default) to trim old tool results before LLM calls
- Configure **compaction reserve** appropriately so compaction triggers before hard context limit
- Use **memory flush** before compaction to persist important context to disk instead of losing it

---

## 3. Responsiveness & Lifelike Behavior

### 3.1 Typing Indicators and Presence

**Current:** OpenClaw supports typing indicators. Ensure they are enabled for WebChat and mobile so the user sees "agent is thinking" instead of silence.

**Improvement:** Phase 5.1 — Verify `typingIndicator` / presence events are emitted and rendered in UI. Add "last seen" or "agent active" status for remote users.

### 3.2 Proactive Outreach Cadence

**Current:** HEARTBEAT.md tells the agent what to check, but there is no guidance on *when* to reach out vs. stay quiet.

**Improvement:** Add to AGENTS.md / HEARTBEAT.md:
- "Reach out when: urgent email, calendar event <2h away, human has been idle >8h"
- "Stay quiet (HEARTBEAT_OK) when: late night (23:00–08:00), nothing new, just checked <30m ago"
- "Vary tone: occasional light check-in ('Anything you need?') vs. actionable alerts"

### 3.3 Reaction and Acknowledgment

**Current:** OpenClaw supports emoji reactions on Discord/Slack. Use them to acknowledge without cluttering the chat.

**Improvement:** Phase 1.2 — Add to AGENTS.md: "Use reactions (👍, ❤️, 👀) to acknowledge messages when a full reply isn't needed. One reaction per message max."

### 3.4 Voice and Media (If Supported)

**Current:** OpenClaw has Talk Mode, ElevenLabs TTS, and voice wake. For a lifelike agent, voice can make it feel more present.

**Improvement:** Phase 5 — If voice is in scope, enable TTS for key alerts (e.g., "You have a meeting in 15 minutes") and ensure mobile app supports push + voice playback.

### 3.5 Human-Like Response Patterns

**Improvements:**

| Pattern | Description |
|---------|-------------|
| **Avoid triple-tap** | Don't send 3 messages in a row; batch into one. Add to AGENTS.md. |
| **Natural delays** | If streaming, avoid unnaturally fast replies; slight delay can feel more human (optional, UI-level). |
| **Contextual greetings** | "Good morning" vs. "Hey" based on time of day and relationship (from SOUL.md). |

---

## 4. Reliability Improvements

### 4.1 Gateway and Daemon Resilience

**Current:** Phase 3.3 mentions "optional systemd/cron for gateway daemon."

**Improvements:**

| Improvement | Description |
|-------------|-------------|
| **Make daemon mandatory** | Use `openclaw onboard --install-daemon` so gateway runs as a service and survives reboots |
| **Health checks** | Configure `openclaw status` or `/health` to be called by a process manager (systemd, supervisord) for restart on failure |
| **Graceful shutdown** | Ensure in-flight agent runs complete or are cleanly aborted before gateway exit |

### 4.2 Model and Auth Failover

**Current:** OpenClaw supports model failover and auth profile rotation.

**Improvements:**

- Configure `agents.defaults.model.fallbacks` with a cheaper backup model (e.g., Sonnet if primary is Opus)
- Set up auth profile rotation for API key exhaustion
- Add Phase 2.7: "Configure model failover and verify fallback path"

### 4.3 Cron Job Resilience

**Current:** Cron has exponential backoff on failures.

**Improvements:**

- Set `cron.maxConcurrentRuns: 1` (default) to avoid overlapping runs
- For critical jobs, add `delivery.bestEffort: false` so failures are visible
- Add monitoring/alerting when cron jobs fail repeatedly (e.g., webhook to Slack)

### 4.4 Session and State Recovery

**Improvements:**

- Back up `~/.openclaw/agents/*/sessions/` and `~/.openclaw/workspace` regularly
- Document recovery procedure if session store is corrupted
- Consider git for workspace (as AGENTS.default.md suggests) for versioned memory

---

## 5. Functionality Improvements

### 5.1 Cursor-Agent Adapter — Robustness

**Improvements:**

| Improvement | Description |
|-------------|-------------|
| **Timeout handling** | Cursor-Agent may hang; enforce strict timeout and abort with clear error for retry |
| **Streaming support** | If Cursor-Agent supports streaming, wire it through for responsive UI |
| **Fallback to pi** | If Cursor-Agent adapter fails, optionally fall back to a standard pi provider (Anthropic/OpenAI) so the agent stays available |

### 5.2 Tool Policy Granularity

**Improvement:** Use per-session or per-context tool allowlists. For example, in group chats, disable exec entirely; in main DM, allow exec with approvals.

### 5.3 Memory Search and Recall

**Improvement:** Ensure `memory_search` is enabled and configured (embedding provider, local vs. remote). Add Phase 1.5: "Configure memory search (SQLite or QMD) and verify recall works."

### 5.4 WebChat Offline Handling

**Improvement:** Phase 5.1 — When gateway is unreachable, WebChat should show clear "Disconnected" state and queue messages for retry, not fail silently.

---

## 6. Revised Implementation Phases (Summary)

### Phase 0: Pre-Launch Security (New)
- Incident response runbook
- Kill switch
- Secret rotation schedule

### Phase 1: Foundation (Enhanced)
- 1.1–1.2: As before
- 1.3: Rate limiting, audit logging
- 1.4: Secure defaults (file perms, mDNS, trusted proxies, dmScope)
- 1.5: Memory search config
- 1.6: Bootstrap size caps, HEARTBEAT.md minimal template

### Phase 2: Model Adapter (Enhanced)
- 2.1–2.4: As before
- 2.5: Input sanitization
- 2.6: Output filtering
- 2.7: Model failover config
- 2.8: Cursor-Agent timeout, streaming, fallback

### Phase 3: Loop & Scheduling (Enhanced)
- 3.1: Heartbeat with adaptive interval, cheaper model option
- 3.2: Cron + token-aware routing
- 3.3: **Mandatory** daemon install, health checks
- 3.4: Context pruning, memory flush config

### Phase 4: Remote Access (Unchanged)
- 4.1–4.3: As before

### Phase 5: UI & Polish (Enhanced)
- 5.1: Typing indicators, presence, offline handling
- 5.2: Phone UI
- 5.3: Voice/media (if in scope)

### Phase 6: Operations (New)
- 6.1: Backup strategy for sessions and workspace
- 6.2: Monitoring/alerting for cron failures
- 6.3: Regular security audit in CI

---

## 7. Priority Matrix

| Category | High Priority | Medium Priority | Lower Priority |
|----------|--------------|-----------------|----------------|
| **Security** | Rate limiting, input/output sanitization, secure defaults, kill switch | Audit logging, incident runbook | mDNS minimal |
| **Token** | Bootstrap caps, HEARTBEAT minimal, context pruning | Adaptive heartbeat, cheaper heartbeat model | Lazy memory loading |
| **Responsiveness** | Typing indicators, proactive cadence rules | Reactions, avoid triple-tap | Voice alerts |
| **Reliability** | Daemon mandatory, health checks | Model failover, cron monitoring | Session backup |

---

## 8. Appendix: Suggested AGENTS.md Additions

```markdown
## Responsiveness & Presence
- Use typing indicators when thinking.
- React with emoji (👍, ❤️, 👀) to acknowledge when a full reply isn't needed.
- One reaction per message max. Don't triple-tap (multiple messages in a row).

## Proactive Outreach
- Reach out when: urgent email, calendar <2h, human idle >8h.
- Stay quiet (HEARTBEAT_OK) when: late night, nothing new, just checked <30m ago.
- Vary tone: light check-ins vs. actionable alerts.
```

---

## 9. Appendix: Suggested HEARTBEAT.md Template

```markdown
# Heartbeat checklist

- Quick scan: inbox, calendar, notifications
- If daytime + idle 8h+: light check-in
- If urgent: alert immediately
- Otherwise: HEARTBEAT_OK
```

Keep under 500 chars to minimize token burn.
