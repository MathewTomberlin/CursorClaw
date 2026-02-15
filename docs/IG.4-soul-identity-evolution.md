# IG.4 — Optional SOUL/IDENTITY evolution (implementation guide)

## Status

**Implementation guide ready.** Optional feature: allow the agent to propose or apply guarded updates to SOUL.md and IDENTITY.md so the agent’s “who you are” and “who you are in this workspace” can evolve over time with operator control.

## Goal

Today, SOUL.md and IDENTITY.md are edited by the user or by the agent only when explicitly asked (e.g. during BIRTH). This item defines an optional **evolution** path: the agent may suggest or apply changes to SOUL and/or IDENTITY under configurable guardrails (e.g. approval required, diff-only proposals, or append-only “notes” section) so identity can grow with use without silent overwrites or loss of operator control.

## Success criteria

- [ ] **Config**: A clear config option (e.g. under `substrate`) controls whether SOUL/IDENTITY evolution is allowed (default: off). When off, behavior is unchanged; no new tools or prompts suggest editing SOUL/IDENTITY for evolution.
- [ ] **Scope**: Only **soul** and **identity** substrate keys are in scope for evolution. Other substrate files (AGENTS, USER, BIRTH, CAPABILITIES, TOOLS, ROADMAP) are out of scope for this feature.
- [ ] **No silent overwrites**: Any agent-driven change to SOUL or IDENTITY goes through a guarded path: either (a) proposal/diff that the user approves, or (b) append-only to a designated section, or (c) another mechanism that ensures the user is aware and in control. No direct `substrate.update` from the agent for soul/identity without an explicit approval or opt-in flow unless the operator has enabled it via config.
- [ ] **Prompt/substrate**: If evolution is enabled, substrate or system instructions state when and how the agent may propose or apply SOUL/IDENTITY updates (e.g. “When you infer a lasting change in how you want to be or how you present in this workspace, you may propose an update to SOUL.md or IDENTITY.md via …”).
- [ ] **Tests**: Existing substrate and runtime tests still pass; optional test for evolution config and guarded write path.

## Guardrails

- **Opt-in**: Evolution is disabled by default. Operator must set something like `substrate.allowSoulIdentityEvolution?: boolean` (or a small struct with `allowProposals` / `allowAppendOnly`) for any agent-driven evolution.
- **Keys**: Only `soul` and `identity`. The agent must not use this feature to change AGENTS.md, USER.md, BIRTH.md, etc.
- **Approval**: If the implementation allows direct writes (e.g. via existing `substrate.update` RPC), either (1) require an approval step (e.g. capability or explicit user confirmation) before calling write for soul/identity, or (2) restrict to “propose only” (e.g. a tool that returns a diff or draft and tells the user “apply this manually or approve”) so the operator always sees the change before it’s applied.
- **Size**: Existing substrate size warnings (e.g. `substrateSizeWarnChars`) continue to apply; evolution must not be used to bypass or ignore those limits.
- **Transparency**: When the agent proposes or applies an evolution, it should state what changed (e.g. “I’ve updated SOUL.md with …” or “Proposed change to IDENTITY.md: …”). No silent edits.

## Implementation summary (options)

Implementers may choose one or combine:

1. **Proposal-only tool**: New tool (e.g. `propose_soul_identity_update`) that takes `key: "soul" | "identity"` and `content` or `patch`, and returns a clear diff or draft for the user. The tool does **not** write to disk; the user applies manually or via a separate “apply” action. Config: `substrate.allowSoulIdentityEvolution: true` enables the tool and prompt guidance.
2. **Append-only section**: Document a convention (e.g. “## Evolved notes” at the end of SOUL.md/IDENTITY.md). A tool or RPC allows the agent to append to that section only when evolution is enabled; no overwrite of the rest of the file. Requires parsing or a dedicated “tail” file that gets injected after the main content (more involved).
3. **Approval-gated write**: Keep using `substrate.update` for soul/identity, but gate it behind an approval step (e.g. capability check or explicit user confirmation in the UI). When evolution is enabled, prompt tells the agent it may request an update; the UI or gateway only performs the write after approval.

Recommendation: start with **(1) proposal-only** to avoid accidental overwrites; add **(3)** later if the operator wants one-click apply.

## Out of scope

- Automatic merging of “learned” memories from MEMORY.md into SOUL or IDENTITY. That remains a separate decision; this guide does not require or define it.
- Version control or history (e.g. git commits) for every evolution. Can be a future enhancement; not required for IG.4.
- Evolution of other substrate files (AGENTS, USER, BIRTH, CAPABILITIES, TOOLS, ROADMAP).
- Changing the order or semantics of substrate injection in the runtime (Identity vs Soul order, etc.); that stays as-is unless another roadmap item addresses it.

## Verification

- With evolution **disabled**: no new tools or prompts suggest editing SOUL/IDENTITY for evolution; existing behavior unchanged.
- With evolution **enabled** (proposal-only): agent can call the proposal tool and user sees a diff/draft; no file change until user applies.
- Run existing tests: `npm test` (substrate loader/store, runtime, gateway); add optional test for evolution config and proposal path.

## Files to touch (when implementing)

| Area | Files |
|------|--------|
| Config | `src/config.ts` — add `substrate.allowSoulIdentityEvolution?: boolean` (and optionally proposal-only vs append-only). |
| Tool or RPC | New tool in `src/tools.ts` (e.g. `propose_soul_identity_update`) or gate existing `substrate.update` in `src/gateway.ts` for soul/identity when evolution enabled. |
| Prompt / substrate | `src/substrate/defaults.ts` or profile substrate — add short guideline when evolution is enabled. |
| Docs | `docs/substrate.md` or equivalent — document the option and guardrails. |
