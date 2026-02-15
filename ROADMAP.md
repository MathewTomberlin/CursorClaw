# ROADMAP.md — Planning (source of truth)

**Role in the framework:** This file is loaded as **substrate** and injected into the agent’s system prompt as "Planning (ROADMAP)" on every turn (including heartbeats). It is the single source of truth for **what** to work on: milestones, backlog, and priorities. The agent is instructed to plan here and advance it during heartbeats.

**HEARTBEAT.md** is separate: it’s the **per-tick checklist** (resilience order, PR reminder, “advance ROADMAP or add items”). It is prepended to the heartbeat user message each tick. Keep the actual open/completed/optional work in this file, not in HEARTBEAT.md.

**How to use this file:**
- **Current state:** One-line snapshot (branch, build status, `tmp/last-build-failure.log`).
- **Open:** Next items to do; pick one per tick when no resilience work is pending.
- **Completed:** Done items (do not re-do); keep for context; full detail in git history.
- **Optional:** Backlog to promote to Open when ready; add with clear success criteria.
- **Each heartbeat:** If no urgent resilience (see HEARTBEAT.md), advance one open item (research, implementation guide, branch, or PR) or add new items. Never leave the roadmap empty.

---

## Current state

On `feature/session-by-profile-ollama-docs` (ahead 2). Build and tests pass. No `tmp/last-build-failure.log`. Uncommitted: doc edits (Ollama, README, RF.2, local-ollama-agent-setup), untracked `ROADMAP.md`.

## Open

- **Next:** Pick from optional work below or operator input when ready.

## Completed (do not re-do)

Resilience (R.1–R.7, daemon, R.4 idempotency), Continuity (C.1–C.4), Persistent/Vector Memory (PM.1–PM.4, VM.1–VM.2), RF.1–RF.3, IG.1–IG.4, TU.1–TU.4, GH.1/GH.2 (incl. rate limits), PMR Phases 1–4 + allow-one-unvalidated, Decision journal replay, Local Ollama (setup + tool-call + E2E verification), Session-by-profile + Ollama docs, Ollama Granite 3.2/docs, ROADMAP doc hygiene, Docs index (docs/README.md), Operator-driven run (Ollama-only) in local-ollama-agent-setup.md §6. Full detail in git history.

## Optional (add to Open when starting)

- Local Ollama enhancements or operator-driven runs (path in `docs/local-ollama-agent-setup.md`; PMR §8).
- When you have a complete implementation guide for an optional item, create a branch, implement, push, and submit a PR for review.
