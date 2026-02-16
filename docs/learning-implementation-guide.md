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

## 4. Heartbeat integration

- **When learning is triggered:** Each heartbeat runs HEARTBEAT.md (resilience → ROADMAP → optional continuity). Learning is advanced via STUDY_GOALS: the agent reads STUDY_GOALS.md and advances one topic (research → notes → implementation guide → implement → validate → PR). Substrate updates (ROADMAP Current state, Completed, STUDY_GOALS sub-notes) are the primary learning capture during heartbeats; MEMORY.md and docs are updated when the agent adds durable facts or implementation notes.
- **Touchpoints:** HEARTBEAT.md step 2 (ROADMAP) and step 4 (Study Goals); ROADMAP "Current state" and "Completed"; STUDY_GOALS sub-notes; optional MEMORY.md or docs/ updates in step 3 (Continuity).

## 5. Next steps (when prioritized)

- Implement or refine any of the above (e.g. MEMORY append rules, substrate update triggers).
- Add automation or tooling for learning capture if desired (e.g. structured MEMORY updates from agent turns).

## 6. Validation

- **Cycle alignment:** Learning work follows research → notes → implementation guide → implement → validate → PR. Validation means: tests pass, success criteria in §2 are met, guardrails in §3 are not violated.
- **After implementation:** Run build and tests; confirm MEMORY/substrate/STUDY_GOALS updates are append-only or scoped per instructions; no silent overwrites of operator content.
- **When to validate:** After any implementation step for a learning-related feature; optional full validation (all criteria + guardrails) before PR.

## 7. Prioritization

- **When to advance learning vs ROADMAP:** HEARTBEAT.md runs resilience first, then ROADMAP (advance one Open item or promote from Optional), then Study Goals (advance one STUDY_GOALS topic). If Open has actionable items and the operator expects ROADMAP progress, prefer ROADMAP; if Open is empty or idle (e.g. "idle until operator"), advance one STUDY_GOALS topic (research → notes → implementation guide → implement → validate → PR). Resumed turns (after user interrupt) use the same order: resilience → ROADMAP Current state → advance one Open or one STUDY_GOALS topic.

## 8. Idle and operator-wait

- **When Open is "idle until operator":** The roadmap may explicitly mark Open items as waiting on operator input (e.g. choosing a provider to implement). On such ticks the agent still runs resilience (build/tests, tmp/last-build-failure.log), updates ROADMAP Current state, and advances one STUDY_GOALS topic; no need to promote Optional to Open or invent new Open work. Continuity (step 3) and Study Goals (step 4) remain in effect.

## 9. Resumed turns

- **When the user continues after an interrupt:** The user may send a message like "The previous heartbeat was interrupted… Continue with ROADMAP.md, HEARTBEAT.md, and STUDY_GOALS". On such resumed turns the same learning flow applies as a normal heartbeat: run resilience (read tmp/last-build-failure.log, optionally run build/tests), update ROADMAP Current state (branch, build status, brief note that this is a resumed turn), then advance one Open item or one STUDY_GOALS topic. Learning capture (ROADMAP Completed, STUDY_GOALS sub-notes, optional MEMORY.md) follows §2 and §3; no special handling beyond treating the turn as one heartbeat tick.

## 10. Documenting a tick

- **When a heartbeat completes with no Open advancement:** Still run resilience (build/tests), update ROADMAP Current state (branch, build status, uncommitted/untracked), and add a one-line Completed entry for this tick. Advance one STUDY_GOALS topic (e.g. add or update a sub-note, or add a small section to an implementation guide). This keeps learning and continuity going even when ROADMAP Open is "idle until operator". This applies to both normal and resumed ticks; for resumed ticks (e.g. user sent "Continue with ROADMAP.md, HEARTBEAT.md, and STUDY_GOALS"), the Completed entry should note that the turn was a continuation after an interrupted heartbeat.

## 11. When to skip or defer study advancement

- **Resilience consumed the tick:** If the agent spent the tick fixing a build failure (tmp/last-build-failure.log) or addressing a blocker documented in ROADMAP Current state, it is acceptable to update Current state and Completed only and not advance a STUDY_GOALS topic this tick; advance STUDY_GOALS on the next tick once resilience is clear.
- **Operator pause:** If the operator explicitly asks to pause study work or focus only on ROADMAP/resilience, skip STUDY_GOALS advancement until the operator indicates otherwise.
- **Otherwise:** When Open is "idle until operator" and no resilience work is pending, advance one STUDY_GOALS topic per §4 and §10.

## 12. Advancing a study topic in a heartbeat

- **One topic, one step:** Each heartbeat (when not consumed by resilience) advances exactly one STUDY_GOALS topic by one step in the pipeline: research → notes → implementation guide → implement → validate → PR. The agent may pick a different topic than the previous tick.
- **What counts as a step:** Adding or expanding a research note, writing or updating an implementation guide section, implementing code or config per a guide, adding or running tests, or opening/updating a PR. Updating the topic’s sub-note in STUDY_GOALS.md (e.g. "Next step: …") counts as documenting the step.
- **Documenting:** After advancing, update that topic’s sub-note in STUDY_GOALS.md with what was done and the next step (if any). Optionally add a short ROADMAP Completed entry for the tick.

## 13. Substrate-only advancement

- **When no doc or code change:** A tick can advance learning by updating only substrate: ROADMAP Current state, ROADMAP Completed, and one or more STUDY_GOALS sub-notes (e.g. Continuity or Learning). That counts as one step for continuity and satisfies “advance one STUDY_GOALS topic” without adding a new implementation-guide section or code.
- **Use case:** Open is "idle until operator", resilience is clear, and the agent runs the full HEARTBEAT checklist (resilience, build/tests, ROADMAP, STUDY_GOALS). The step is documenting the tick and keeping sub-notes current; no new § in docs is required.
