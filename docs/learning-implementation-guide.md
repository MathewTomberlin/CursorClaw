# Learning (meta-topic) — Implementation guide

**Scope:** Where and how learning is captured in this framework, success criteria for learning flows, and guardrails. This doc is a stub; expand when implementing concrete learning features.

## 1. Where learning is captured

- **STUDY_GOALS.md** — Multi-cycle work (research → notes → implementation guide → implement → validate → PR); topics and sub-notes advance over heartbeats.
- **MEMORY.md** — Curated long-term facts; operator/agent can append; see docs/memory.md.
- **Substrate files** — ROADMAP.md (Current state, Open, Completed), HEARTBEAT.md, and other profile substrate; updated for continuity and planning.
- **Daily logs** — memory/YYYY-MM-DD.md when used; see docs/memory.md §9.

## 2. Success criteria for learning flows

- When to append to **MEMORY.md**: durable facts the agent or operator want to retain across sessions; avoid duplicates; keep concise.
- When to **update substrate** (e.g. ROADMAP Current state): every heartbeat that changes branch/build status or advances work; keep one-line snapshot accurate.
- When to **add or update STUDY_GOALS sub-notes**: after research, implementation guide, or implementation steps; record next step and key paths/docs.

## 3. Guardrails

- **Avoid overwriting operator edits**: Prefer appending or updating only the sections the agent is instructed to maintain (e.g. ROADMAP Current state, Completed entries, STUDY_GOALS sub-notes).
- **Preserve provenance**: In MEMORY.md and substrate, keep attribution and date context where useful (e.g. "2026-02-16: …").
- **No silent overwrites**: Do not replace large operator-written sections without explicit scope in HEARTBEAT/ROADMAP/STUDY_GOALS instructions.

## 4. Next steps (when prioritized)

- Implement or refine any of the above (e.g. MEMORY append rules, substrate update triggers).
- Add automation or tooling for learning capture if desired (e.g. structured MEMORY updates from agent turns).
