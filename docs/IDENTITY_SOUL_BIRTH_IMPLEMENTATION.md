# Identity, Soul, Birth, and Substrate Implementation for CursorClaw

**Purpose:** Step-by-step, phase-based implementation plan to add OpenClaw-inspired identity, soul, birth (bootstrap), and capability substrate files to CursorClaw, and to wire them into the heartbeat and prompt pipeline for lifelike behavior and autonomy.

**Load and use this document** as the single source of truth when executing the implementation (e.g. “follow `docs/IDENTITY_SOUL_BIRTH_IMPLEMENTATION.md`”).

---

## 1) Research Summary: OpenClaw vs CursorClaw

### 1.1 OpenClaw Template Definitions (docs.openclaw.ai/reference/templates/)

The following are taken from the official OpenClaw templates. Use them to align CursorClaw's substrate files and behavior.

| Template | Purpose | Key content / behavior |
|----------|---------|-------------------------|
| **SOUL.md** | Who you are; personality, boundaries, continuity.
| **IDENTITY.md** | Who am I? (filled in during first conversation.) | Avatar (workspace path, http(s) URL, or data URI), Emoji (signature), Vibe (sharp/warm/chaotic/calm), Creature (AI/robot/familiar/etc.), Name. Save at workspace root. |
| **USER.md** | About your human. | Name, what to call them, timezone, pronouns (optional), notes. Context: what they care about, projects, annoyances, what makes them laugh. Build over time; "learning about a person, not building a dossier." |
| **TOOLS.md** | Local notes for tools (environment-specific). | Device nicknames, speaker/room names, TTS voices, SSH hosts/aliases, camera names. Separate from skills (skills shared; your setup is yours). |
| **BOOTSTRAP.md** | First-run "birth" ritual; delete when done. | "You just woke up." No memory yet. Conversation: start with "Hey. I just came online. Who am I? Who are you?" Figure out emoji, vibe, nature, name. Then update USER.md, IDENTITY.md; open SOUL.md together. Optional: connect (Telegram/WhatsApp/just here). When done, **delete this file**. |
| **HEARTBEAT.md** | Per-tick action list for heartbeat turns. | When missing or empty, a default template is used (repo state, roadmap, learning, maintenance, memory/vector-store hygiene, plus an "Agent-added actions" section). **Keep empty (or comments only) and set \`heartbeat.skipWhenEmpty: true\`** to skip heartbeat API calls. The agent may add actions at the end of HEARTBEAT.md (under the template's "Agent-added actions" section) or in **HEARTBEAT_EXTRA.md** (same profile root); that file is appended each tick. |
| **AGENTS.md** | Workspace home; session-start and ongoing rules. | First run: if BOOTSTRAP.md exists, follow it then delete. Every session: read MEMORY.md (main only), memory/YYYY-MM-DD (today+yesterday), USER.md, SOUL.md. Memory: long-term MEMORY.md (curated; main session only), daily memory/YYYY-MM-DD.md. "Text > Brain": write mistakes/lessons/"remember this" to files. Safety, external vs internal, group-chat behavior (when to speak vs HEARTBEAT_OK, react like human). Heartbeats: use productively; heartbeat vs cron; track in memory/heartbeat-state.json; when to reach out vs stay quiet; memory maintenance (periodically distill daily → MEMORY.md). |
| **BOOT.md** | Startup instructions (when hooks.internal.enabled). | Short, explicit instructions for what to do on startup. If the task sends a message, use message tool then reply NO_REPLY. |

**AGENTS.default.md** (reference): Default workspace content; copy templates (AGENTS.md, SOUL.md, TOOLS.md) into workspace; optional full AGENTS.default.md. Session start: read SOUL, USER, memory (today+yesterday), MEMORY.md in main session. Safety defaults, memory system, tools & skills, backup tip (git workspace).

### 1.2 What Was Verified (OpenClaw Public Repo)

- **AGENTS.md**  
  - **Location:** Repo root or agent workspace (OpenClaw: `agents.defaults.workspace`).  
  - **Use:** In OpenClaw, workspace AGENTS.md defines session-start ritual (read SOUL, USER, memory) and ongoing rules. **CursorClaw now implements AGENTS.md as a substrate file:** it is loaded at startup, injected **first** in the system prompt (before Identity, Soul, User, etc.), and editable via `substrate.update` / UI. Using the filename `AGENTS.md` allows clients that treat it as a rules file (e.g. Claude Code, Cursor) to use it the same way when editing the workspace.  
  - **Runtime:** Injected as "Workspace rules (AGENTS)" so the Cursor-Agent CLI and any rules-file-aware client see consistent coordination. When used for repo editing, not loaded into the running agent’s prompt; it guides the AI that edits the repo.

- **HEARTBEAT.md**  
  - **Location:** Agent workspace (user-defined).  
  - **Use:** User-editable “heartbeat checklist.” Read on each heartbeat turn; content is prepended to the heartbeat user message.  
  - **Behavior:** If the file exists and has substantive content, it is sent with the heartbeat prompt; agent replies `HEARTBEAT_OK` when nothing needs attention. **Template: keep file empty or comments-only to skip heartbeat API calls** — consider supporting this in CursorClaw (e.g. skip heartbeat when file is empty or missing).
  - **Docs:** `docs/automation/cron-vs-heartbeat.md`, `docs/gateway/heartbeat.md`.

- **.agents/**  
  - **Contents:** `.agents/skills/` (e.g. PR_WORKFLOW, mintlify), `AGENT_SUBMISSION_CONTROL_POLICY.md`.  
  - **Use:** Skills and policies for agents that contribute to the repo (PRs, docs). Not part of the running bot’s “identity” or system prompt.

- **SOUL.md, IDENTITY.md, TOOLS.md, BOOTSTRAP.md, USER.md, BOOT.md**  
  - **Status:** Defined in OpenClaw docs/templates; workspace seeded from `docs/reference/templates/` and optionally `AGENTS.default.md`.
  - **Interpretation:** Implement in CursorClaw as substrate files; align semantics with templates above for lifelike behavior and continuity.
### 1.3 CursorClaw Today

- **Heartbeat:** `HeartbeatRunner` + `AutonomyOrchestrator`; `onHeartbeatTurn` in `src/index.ts` reads `HEARTBEAT.md` from workspace and prepends it to the heartbeat user message. Config: `heartbeat.prompt`, `heartbeat.enabled`, intervals, active hours.
- **Prompt building:** `buildPromptMessages()` in `src/runtime.ts` builds system messages from freshness, contradictions, force-multi-path, deep scan, decision journal, then **plugin host** (collectors → analyzers → synthesizers). No workspace-loaded identity/soul/bootstrap files.
- **Capabilities:** `CapabilityStore` + `ApprovalWorkflow` in `src/security/capabilities.ts` and `src/security/approval-workflow.ts` gate tool execution. No `CAPABILITIES.md` (or TOOLS.md) file that describes allowed tools for the agent or operators.

---

## 2) Substrate File Definitions (CursorClaw)

| File             | CursorClaw role | When loaded | Injected where |
|------------------|-----------------|------------|----------------|
| **IDENTITY.md**  | Who the agent is: name, role, boundaries, scope. | Startup + optional refresh on first turn per session. | System prompt (every turn, including heartbeat). |
| **SOUL.md**      | Personality, tone, values, “lifelike” behavior, how to respond and when to stay silent. | Startup + optional refresh. | System prompt (every turn, including heartbeat). |
| **BIRTH.md**     | Bootstrap / birth: one-time or startup instructions, initial state, how to “wake,” first-run behavior. | Startup or first turn per session. | System prompt (first turn or every turn until “consumed,” depending on design). |
| **CAPABILITIES.md** | Human-readable description of what the agent may do (tools, approvals, guardrails). Optional. | Startup or on demand. | Optional: system prompt summary or reference; can feed approval UX or docs. |
| **USER.md**      | Who the human is: name, what to call them, timezone, pronouns, notes, context (projects, preferences). | Startup + optional refresh; session start (OpenClaw: read every session). | System prompt (every turn in main session) or session-start only, per design. |
| **TOOLS.md**     | Local notes for tools: device nicknames, SSH hosts, TTS voices, camera names (environment-specific; separate from skills). | Startup or on demand. | Optional: system prompt or tool-context reference; not enforcement. |
| **HEARTBEAT.md** | Per-tick action list (already implemented). When missing/empty, default template is used. Empty or comments-only + `heartbeat.skipWhenEmpty: true` → skip heartbeat API. Optional **HEARTBEAT_EXTRA.md** appended when present. | Every heartbeat turn. | Heartbeat user message (prepended to `heartbeat.prompt`). |
| **BOOT.md**     | Startup instructions (OpenClaw: when `hooks.internal.enabled`). Short tasks; if message sent, use message tool then NO_REPLY. | Once at process/gateway startup. | Executed as startup task; not injected into chat prompt. |
| **AGENTS.md**    | Coordinating workspace rules (session start, memory, safety, heartbeats). OpenClaw-style; filename allows Claude Code / Cursor to use as rules file. | Startup + reload. | System prompt **first** (before Identity, Soul, User, etc.) so agent and rules-file clients behave consistently. |

**Optional memory layer (from templates):** OpenClaw uses `MEMORY.md` (curated long-term; main session only) and `memory/YYYY-MM-DD.md` (daily log). Session start: read today + yesterday. Consider adding optional loading of these for continuity (see Phase 8).

### 2.1 How They Contribute to Heartbeat and Autonomy

- **Identity + Soul** in the system prompt ensure every turn (including heartbeat) has consistent “who you are” and “how to behave,” so heartbeat behavior is aligned with the agent’s identity and tone.
- **HEARTBEAT.md** remains the per-tick checklist (what to check this cycle); Identity/Soul define the agent that interprets that checklist.
- **BIRTH.md** can set initial or recurring “wake” behavior (e.g. first message after start, or a short line included once per day in the system prompt).
- **CAPABILITIES.md** does not replace `CapabilityStore`; it documents or summarizes capabilities for operators and can optionally be summarized into the system prompt (e.g. “You may use tools listed in CAPABILITIES.md subject to approval”).

### 2.2 Additional Substrate from Templates (Lifelike Behavior and Continuity)

- **USER.md:** Load and inject into system prompt (main session) so the agent knows who it is helping (name, timezone, preferences). Align with OpenClaw session-start: read USER.md every session.
- **TOOLS.md:** Load for tool-context or optional system-prompt snippet; environment-specific notes (SSH hosts, device names, TTS voices). Keep separate from CAPABILITIES.md (capabilities = what is allowed; tools = local setup notes).
- **BOOT.md:** Optional startup task file; when supported, execute contents at process/gateway startup (e.g. send welcome, run check). Use message tool then NO_REPLY if a message is sent. Not injected into chat prompt.
- **HEARTBEAT skip when empty:** When HEARTBEAT.md is missing, empty, or contains only comments, skip issuing heartbeat API calls (per OpenClaw template). Add config option if needed (e.g. `heartbeat.skipWhenEmpty`).
- **heartbeat-state.json:** Optional `memory/heartbeat-state.json` (or equivalent) to record last-check timestamps (email, calendar, weather, etc.) so the agent can avoid redundant checks and "when to reach out" logic aligns with template guidance.
- **Optional memory layer:** MEMORY.md (curated long-term) and memory/YYYY-MM-DD.md (daily); load today + yesterday at session start for continuity. Implement only if session-start and workspace memory are in scope; otherwise document as future work.

---

## 3) Phase-Based Implementation

### Phase 1: Substrate Loader and Types

**Goal:** Introduce a small substrate loader that reads workspace markdown files and expose types/interfaces used by the runtime.

- [x] **1.1** Add `src/substrate/types.ts`: define `SubstrateContent` (e.g. `{ identity?: string; soul?: string; birth?: string; capabilities?: string; user?: string; tools?: string }`) and optional `SubstratePaths` (workspace-relative paths for each file, with defaults: IDENTITY.md, SOUL.md, BIRTH.md, CAPABILITIES.md, USER.md, TOOLS.md).
- [x] **1.2** Add `src/substrate/loader.ts`: `loadSubstrate(workspaceDir: string, paths?: SubstratePaths): Promise<SubstrateContent>`. Read IDENTITY.md, SOUL.md, BIRTH.md, CAPABILITIES.md, USER.md, TOOLS.md from workspace; return trimmed content keyed by name; missing files → undefined. Use `fs.promises.readFile` and tolerate `ENOENT`; no write operations.
- [x] **1.3** Add unit tests (e.g. `src/substrate/loader.test.ts`): temp dir with present/missing files; assert returned keys and content; assert no throw on missing files.
- [x] **1.4** Export from `src/substrate/index.ts` (or barrel): `loadSubstrate`, `SubstrateContent`, `SubstratePaths`.

**Success criteria:**

- Substrate loader exists and is tested.
- No change yet to runtime or heartbeat behavior.

---

### Phase 2: Config and Startup Loading

**Goal:** Add optional config for substrate paths and load substrate once at startup; hold result in a place the runtime can use (e.g. gateway or runtime options).

- [x] **2.1** Extend config (e.g. `src/config.ts` and `openclaw.example.json`): optional `substrate: { identityPath?: string; soulPath?: string; birthPath?: string; capabilitiesPath?: string; userPath?: string; toolsPath?: string }` (defaults: `IDENTITY.md`, `SOUL.md`, `BIRTH.md`, `CAPABILITIES.md`, `USER.md`, `TOOLS.md` in workspace root). Ensure defaults are documented.
- [x] **2.2** In `main()` (or gateway build), after `workspaceDir` and config are known: call `loadSubstrate(workspaceDir, config.substrate)` and pass `SubstrateContent` into whatever will feed the runtime (e.g. gateway options or runtime options). Do not block startup if loader throws; log and continue with empty substrate.
- [ ] **2.3** Add a simple test or script that: starts with a workspace containing IDENTITY.md and SOUL.md, loads config, runs loader, and asserts content is present (optional integration test).

**Success criteria:**

- Config supports substrate paths; substrate is loaded at startup and available to the runtime path.
- Startup remains safe when files are missing or loader fails.

---

### Phase 3: Inject Identity and Soul into System Prompt

**Goal:** Prepend Identity and Soul to the system prompt for every turn (including heartbeat), so the agent has consistent identity and behavior.

- [x] **3.1** In `AgentRuntime` (or wherever `buildPromptMessages` runs), accept optional `SubstrateContent` (or a getter). At the start of `buildPromptMessages`, if `substrate.identity` or `substrate.soul` is present, prepend one or two system messages (e.g. “Identity”, “Soul”) with the trimmed content. Order: Identity first, then Soul. Use existing `scrubText` for any substrate content that goes into the prompt.
- [x] **3.2** (Optional) If `substrate.user` is present and the turn is in main/direct session, append a "User" system message after Soul; use `scrubText`. Document that USER.md is main-session only (per OpenClaw: not in group chats).
- [x] **3.3** Keep existing system message sources (freshness, contradictions, force-multi-path, deep scan, decision journal, plugin host) unchanged in order after the new Identity/Soul (and optional User) blocks.
- [x] **3.4** Add a unit test: mock runtime with substrate content; build prompt; assert first system messages contain identity and soul text (and that later messages are unchanged in structure). If User is implemented, add test that User block appears only in main-session context.
- [x] **3.5** Document in `docs/configuration-reference.md` (or equivalent): substrate config keys, default filenames, and that Identity and Soul are included in every turn including heartbeat; USER.md when used is main-session only.

**Success criteria:**

- Every turn (user and heartbeat) receives Identity and Soul in the system prompt when files exist.
- When USER.md is implemented, main-session turns also receive User block; non-main sessions do not.
- No regression in existing prompt structure or plugin pipeline.

---

### Phase 4: Birth (Bootstrap) Handling

**Goal:** Load BIRTH.md and use it for “wake” or first-run behavior without duplicating logic.

- [x] **4.1** Decide semantics: (A) BIRTH content in system prompt on first turn per session only, or (B) BIRTH content in system prompt on every turn until a “consumed” condition (e.g. first successful turn), or (C) BIRTH only at process startup as a one-time system message. Document the choice in this file and in code comments.
- [x] **4.2** Implement chosen semantics: e.g. if (A), pass session id into prompt builder and add a “Bootstrap” system message only when it’s the first turn for that session (use existing session/turn machinery). If (C), add BIRTH as a system message once at startup and keep it in a fixed “bootstrap” message that is always included (same as Identity/Soul).
- [x] **4.3** Apply `scrubText` to BIRTH content. Add a test that verifies BIRTH appears (or does not appear) according to the chosen semantics.
- [x] **4.4** Update docs: where BIRTH is documented, state when it is injected and how it interacts with Identity/Soul and HEARTBEAT.

**Success criteria:**

- BIRTH content is injected according to the chosen policy.
- No double-injection or prompt bloat from BIRTH.

---

### Phase 5: CAPABILITIES.md (Optional Summary in Prompt)

**Goal:** Optionally expose a short summary of capabilities in the system prompt (e.g. “You have the following capabilities; use them subject to approval”) without replacing the runtime `CapabilityStore`.

- [x] **5.1** Add config flag, e.g. `substrate.includeCapabilitiesInPrompt: boolean` (default false). When true, if `SubstrateContent.capabilities` is present, append a single system message like “Capabilities (summary): …” with a truncated or summarized version (e.g. first 500 chars or one paragraph) to avoid token bloat.
- [ ] **5.2** Do not change tool registration or approval logic; `CapabilityStore` and approval workflow remain the source of truth. CAPABILITIES.md is informational only.
- [ ] **5.3** Document the flag and the intent (operator reference, not enforcement).

**Success criteria:**

- When enabled, a short capabilities summary can appear in the system prompt; when disabled or file missing, behavior unchanged.

---

### Phase 6: Heartbeat Explicit Integration and Docs

**Goal:** Make the heartbeat’s use of Identity/Soul/HEARTBEAT explicit and document the full flow.

- [x] **6.1** Verify in code: heartbeat turn uses the same `runTurn` → `buildPromptMessages` path, so Identity and Soul are already included. If not, add a short comment in `onHeartbeatTurn` and/or `buildPromptMessages` stating that heartbeat turns receive the same system prompt (including Identity and Soul) and that HEARTBEAT.md is the user message body.
- [x] **6.2** Add or update a “Substrate and heartbeat” section in `docs/configuration-reference.md` or `docs/codebase-reference.md`: (1) HEARTBEAT.md is the per-tick checklist (user message); (2) Identity and Soul are in the system prompt for every turn, including heartbeat; (3) BIRTH semantics (when it’s added); (4) optional CAPABILITIES summary; (5) HEARTBEAT.md empty/comments-only can skip heartbeat (if implemented).
- [x] **6.3** Add example stub files in `docs/` or in repo root as templates (e.g. `IDENTITY.md.example`, `SOUL.md.example`, `BIRTH.md.example`, `USER.md.example`, `TOOLS.md.example`) with short comments on purpose and safe content (no secrets).
- [x] **6.4** (Optional) **HEARTBEAT skip when empty:** If config `heartbeat.skipWhenEmpty` (or equivalent) is true, when HEARTBEAT.md is missing, empty, or contains only comment lines, do not issue a heartbeat API call for that cycle. Document in config reference.

**Success criteria:**

- Code and docs clearly describe how substrate files and heartbeat interact.
- Operators can copy example files to create their own identity/soul/birth.
- When HEARTBEAT skip is implemented, empty HEARTBEAT.md does not trigger heartbeat calls (and no regression when file has content).

---

### Phase 7: AGENTS.md (Optional, Repo-Only)

**Goal:** Optional OpenClaw-style AGENTS.md for repo contributors; no runtime loading.

- [x] **7.1** If desired, add `AGENTS.md` at repo root with CursorClaw-specific repo guidelines (build, test, commit, security, where substrate files live). Optionally add `CLAUDE.md` symlink to AGENTS.md for editor/agent discovery.
- [ ] **7.2** Explicitly do **not** load AGENTS.md into the runtime or system prompt. Document that AGENTS.md is for AI that edits the repo, not for the running agent.

**Success criteria:**

- AGENTS.md exists and is documented; runtime is unchanged.

---

### Phase 8: USER.md and TOOLS.md (Optional Injection)

**Goal:** Support USER.md and TOOLS.md in loader and optionally in prompt/tool context for lifelike behavior and continuity.

- [x] **8.1** Loader already reads USER.md and TOOLS.md (Phase 1/2). Ensure config includes `userPath` and `toolsPath` and they are passed to runtime.
- [ ] **8.2** Inject USER.md into system prompt in main session only (Phase 3.2). Add success criterion: when USER.md exists and session is main, prompt includes User block; when session is not main, no User block.
- [x] **8.3** (Optional) If `substrate.tools` is present, either (A) append a short "Tools (local notes)" system message (truncated to avoid token bloat), or (B) expose TOOLS.md content to tool-execution context only. Document choice. Do not use TOOLS.md for capability enforcement.
- [ ] **8.4** Add `USER.md.example` and `TOOLS.md.example` templates (see Phase 6.3). Document in guardrails: USER.md contains information about the human; treat as private, main-session only.

**Success criteria:**

- USER.md and TOOLS.md are loaded and optionally injected per design. No regression when files are missing.
- USER.md is never loaded in non-main contexts (guardrail).

---

### Phase 9: HEARTBEAT Skip and heartbeat-state (Optional)

**Goal:** Align heartbeat behavior with OpenClaw template: skip when HEARTBEAT.md is empty/comments-only; optional state tracking.

- [x] **9.1** Implement HEARTBEAT skip when empty (see Phase 6.4): config `heartbeat.skipWhenEmpty`; when true and HEARTBEAT.md is missing/empty/comments-only, do not call heartbeat API for that cycle. Unit test: with skipWhenEmpty true and empty file, no API call; with content, API call occurs.
- [ ] **9.2** (Optional) Add `memory/heartbeat-state.json` (or configurable path) to record last-check timestamps (e.g. `lastChecks: { email, calendar, weather }`). Read before heartbeat turn; agent or orchestrator can use it to avoid redundant checks. Document format and that agent may update it during heartbeat turn.
- [ ] **9.3** Guardrail: Do not skip heartbeat when `heartbeat.skipWhenEmpty` is false or unset (backward compatible).

**Success criteria:**

- When skipWhenEmpty is true and HEARTBEAT.md is empty, heartbeat poll is skipped; when file has content, heartbeat runs. No regression for existing deployments.

---

### Phase 10: BOOT.md and Optional Memory (Future / Optional)

**Goal:** Document or implement BOOT.md startup tasks and optional memory layer for continuity.

- [ ] **10.1** (Document only, unless hooks/internal startup is in scope) Document BOOT.md: short startup instructions; when implemented, run at process/gateway startup; if task sends a message, use message tool then NO_REPLY. Add to file touch list and substrate table.
- [ ] **10.2** (Future) Optional memory layer: MEMORY.md + memory/YYYY-MM-DD.md; session start read today + yesterday. Implement only if session-start and workspace memory are in scope; otherwise leave as "Optional memory layer" in 2.2 and reference OpenClaw memory docs.

**Success criteria:**

- BOOT.md and optional memory are documented; implementation follows when gateway/startup and memory features are in scope.

---

### Phase 11: Substrate UI and Live Reload (No Restart / No Rebuild)

**Goal:** Expose substrate files to the user interface so operators can view and edit IDENTITY.md, SOUL.md, BIRTH.md, CAPABILITIES.md, USER.md, TOOLS.md (and optionally HEARTBEAT.md) from the UI. Edits must take effect on the next agent turn without requiring process restart or rebuild.

**Design (immediate effect):**

- **Runtime uses a live substrate source:** The runtime must not receive a one-time snapshot at startup. Use either (A) a **getter** that returns the current in-memory substrate (updated on load/reload), or (B) a **SubstrateStore** (or equivalent) that holds `SubstrateContent` and exposes `get(): SubstrateContent` and `reload(): Promise<void>`. `buildPromptMessages` reads from this source each turn so that after a reload, the next turn sees new content.
- **Backend RPCs (admin/local scope):**
  - **substrate.list** – Returns list of substrate keys (e.g. `identity`, `soul`, `birth`, `capabilities`, `user`, `tools`) and for each: `present: boolean`, optional `path` (workspace-relative). No file contents. Enables UI to show which files exist.
  - **substrate.get** – Params: optional `key?: string`. If omitted, returns full `SubstrateContent` (all keys, trimmed content or undefined if missing). If `key` provided, returns `{ [key]: string | undefined }`. Used by UI to populate editors.
  - **substrate.update** – Params: `key: string`, `content: string`. Validates `key` against allowed list (identity, soul, birth, capabilities, user, tools); writes content to the configured workspace file (using configured path for that key); then refreshes the in-memory substrate cache for that key so the next turn uses new content. No restart. Use UTF-8 write; on failure return error, do not crash.
  - **substrate.reload** – No params. Re-reads all substrate files from disk (using existing loader and paths) and replaces the in-memory cache. Use when the user has edited files outside the UI (e.g. in an IDE) so the agent picks up changes on next turn.
- **UI:** New page or section (e.g. "Substrate" or "Identity & Soul" under Config or its own nav item). List substrate files; for each, show name, path, and a read-only preview or editable textarea. "Save" calls `substrate.update` for the edited key(s) (and optionally `substrate.reload` if no write path is used). Optional "Reload from disk" button that calls `substrate.reload` and then refetches via `substrate.get` so the UI reflects external edits.
- **HEARTBEAT.md:** If HEARTBEAT.md is exposed in the UI, use the same pattern (list/get/update/reload). Heartbeat runner already reads HEARTBEAT.md each turn from disk in current design; if heartbeat is changed to use in-memory substrate, include HEARTBEAT in the substrate store and have the heartbeat path read from the same store so reload/update applies there too.

**Implementation steps:**

- [x] **11.1** Introduce a **substrate store** (e.g. `SubstrateStore` in `src/substrate/store.ts` or equivalent): holds `SubstrateContent`, `get(): SubstrateContent`, `set(content: SubstrateContent): void`, `reload(workspaceDir: string, paths?: SubstratePaths): Promise<void>` (calls `loadSubstrate` then `set`). Used by gateway and runtime. If runtime currently receives substrate at construction time, change runtime to accept a **getter** `getSubstrate(): SubstrateContent` (or the store reference) so each `buildPromptMessages` calls the getter and gets current content.
- [x] **11.2** At startup: after `loadSubstrate(workspaceDir, config.substrate)`, put the result into the substrate store (or call `store.reload(...)`). Pass the store (or getter) into the runtime and into gateway deps.
- [x] **11.3** Add RPC handlers in gateway: `substrate.list`, `substrate.get`, `substrate.update`, `substrate.reload`. Register in `METHOD_SCOPES` with `["admin", "local"]`. For `substrate.update`: resolve path from config (substrate paths); ensure path is under `workspaceDir` (no path traversal); write with `fs.promises.writeFile` (UTF-8); then update store for that key (or call `store.reload` for simplicity). Validate `key` against the fixed list of allowed keys.
- [x] **11.4** Document new RPCs in `docs/rpc-api-reference.md`: params, returns, and that edits take effect on next turn without restart.
- [x] **11.5** UI: Add Substrate page (or Config sub-section). Fetch list via `substrate.list`, content via `substrate.get`. For each key, show label (e.g. "Identity (IDENTITY.md)"), textarea with content (or placeholder "File not present"). Save button: for dirty keys call `substrate.update` with key and content; then call `substrate.reload` and refetch to sync UI. Optional "Reload from disk" that calls `substrate.reload` and refetches. Show short warning: "Substrate files are included in the agent prompt. Do not put secrets here."
- [x] **11.6** Add unit tests: store get/set/reload; gateway handlers (substrate.list returns keys; substrate.get returns content; substrate.update writes file and updates store; substrate.reload replaces content). Use temp dir for write tests.
- [x] **11.7** Guardrail: Path validation for `substrate.update` – reject if resolved path is outside `workspaceDir` or contains path traversal. Only allow keys: `identity`, `soul`, `birth`, `capabilities`, `user`, `tools` (and optionally `heartbeat` if HEARTBEAT.md is in the store).

**Success criteria:**

- [ ] Operators can open the Substrate UI and see which substrate files exist and their content.
- [ ] Operators can edit content in the UI and save; the next agent turn (including heartbeat) uses the updated content without restart or rebuild.
- [ ] "Reload from disk" (or equivalent) updates the in-memory cache from workspace files so external edits are picked up.
- [ ] No path traversal or writes outside workspace; only allowed keys are writable.
- [ ] RPC docs and UI copy state that substrate is prompt-included and must not contain secrets.

---

## 4) Checkbox Summary (Success Criteria)

Use this list to track completion; each item should be verifiable.

**Phase 1 – Loader and types**

- [ ] `SubstrateContent` / `SubstratePaths` types and loader implemented and exported.
- [ ] Loader tests: present/missing files, no throw on ENOENT.

**Phase 2 – Config and startup**

- [ ] Config has optional `substrate` paths; substrate loaded at startup and passed to runtime path.
- [ ] Startup does not fail when substrate files are missing or loader fails.

**Phase 3 – Identity, Soul, and optional User in prompt**

- [ ] Identity and Soul (when present) prepended to system prompt for every turn (including heartbeat).
- [ ] Optional USER.md injected in main session only; scrub applied; docs updated.
- [ ] Order and existing prompt structure preserved.
- [ ] Unit test and docs updated.

**Phase 4 – Birth**

- [ ] BIRTH semantics chosen and documented.
- [ ] BIRTH injected according to that policy; test and docs updated.

**Phase 5 – CAPABILITIES.md (optional)**

- [ ] Config flag and optional capabilities summary in prompt implemented and documented.

**Phase 6 – Heartbeat and docs**

- [ ] Code comments and docs describe heartbeat + substrate flow; example stub files added.

**Phase 7 – AGENTS.md (optional)**

- [ ] AGENTS.md and optional CLAUDE.md added and documented; not loaded by runtime.

**Phase 8 – USER.md and TOOLS.md (optional)**

- [ ] USER.md and TOOLS.md loaded; USER injected in main session only; TOOLS optional in prompt or tool context.
- [ ] Example templates and guardrail (USER = private, main-session only) documented.

**Phase 9 – HEARTBEAT skip and heartbeat-state (optional)**

- [ ] heartbeat.skipWhenEmpty implemented and tested; no regression when disabled or when file has content.
- [ ] Optional heartbeat-state.json documented or implemented.

**Phase 10 – BOOT.md and optional memory (future)**

- [ ] BOOT.md and optional memory layer documented; implementation when in scope.

**Phase 11 – Substrate UI and live reload**

- [ ] Substrate store (or getter) used by runtime so each turn reads current content; no one-time snapshot only.
- [ ] RPCs substrate.list, substrate.get, substrate.update, substrate.reload implemented and documented; scope admin/local.
- [ ] UI Substrate page: list/get/update and optional reload from disk; edits take effect on next turn without restart.
- [ ] Path validation and allowed-keys check for substrate.update; no writes outside workspace.
- [ ] Tests for store and RPC handlers; UI shows "no secrets" warning.

---

## 5) Guardrails (Prevent Regressions and Breakage)

- **No secrets in substrate:** Document that IDENTITY.md, SOUL.md, BIRTH.md, CAPABILITIES.md, and HEARTBEAT.md are included in prompts; operators must not put secrets there. Existing privacy scrubber continues to run on prompt content; do not disable it for substrate.
- **Backward compatibility:** If substrate config is absent, behave as today: no substrate loading, no new system messages. Existing deployments without these files must not break.
- **Startup resilience:** Substrate loading must not block or crash startup. On loader error, log and continue with empty substrate.
- **Prompt budget:** Existing system prompt budget / trimming (e.g. `applySystemPromptBudget`) must still apply after adding Identity/Soul/Birth/Capabilities so that token limits are not exceeded.
- **Tests:** Keep and extend existing tests for heartbeat, orchestrator, and runtime. New substrate tests must be deterministic (temp dirs, no network).
- **Capabilities vs approval:** Do not use CAPABILITIES.md to grant or revoke capabilities at runtime. `CapabilityStore` and approval workflow remain the only enforcement.
- **Single loader:** One loader implementation and one call site at startup; avoid ad-hoc file reads for these markdown files elsewhere.
- **File encoding:** Read substrate files as UTF-8; on decode error, skip that file and log (do not crash).
- **USER.md privacy:** USER.md contains information about the human (name, timezone, preferences). Load only in main/direct session; never inject into group or shared contexts. Document in config and operator docs.
- **HEARTBEAT skip backward compatibility:** When `heartbeat.skipWhenEmpty` is false or unset, always run heartbeat as today (use HEARTBEAT.md content if present). Do not change default behavior for existing deployments.
- **TOOLS.md not enforcement:** TOOLS.md is for local setup notes (device names, SSH hosts, voices). Do not use it to grant or revoke capabilities; CapabilityStore and approval workflow remain the only enforcement.
- **BOOT.md not in chat:** If BOOT.md is executed at startup, its output or instructions are not injected into the chat system prompt; run as a separate startup task.
- **Continuity reminder (Text > Brain):** In SOUL.md.example or docs, remind operators/agents that persistence is file-based: write important decisions, lessons, and "remember this" to memory files (e.g. memory/YYYY-MM-DD.md or MEMORY.md) so they survive session restarts.
- **Substrate UI – path safety:** For `substrate.update`, resolve the target path from config and workspace; reject if the resolved path is outside the workspace root or contains `..` or otherwise escapes. Use an allowlist of keys (identity, soul, birth, capabilities, user, tools; optionally heartbeat); reject any other key with BAD_REQUEST.
- **Substrate UI – no restart required:** The runtime must read substrate from the store/getter on each turn, not from a snapshot captured at startup only. After `substrate.update` or `substrate.reload`, the very next agent or heartbeat turn must use the updated content.
- **Substrate UI – secrets warning:** In the Substrate UI, display a short, visible notice that substrate files are included in the agent prompt and must not contain secrets or sensitive data; link or reference the main guardrail on no secrets in substrate.

---

## 6) File Touch List (Reference)

- New: `src/substrate/types.ts`, `src/substrate/loader.ts`, `src/substrate/loader.test.ts`, `src/substrate/index.ts`; **Phase 11:** `src/substrate/store.ts` (or equivalent), gateway handlers for substrate.*, UI Substrate page (e.g. `ui/src/pages/Substrate.tsx`).
- Modified: `src/config.ts`, `src/index.ts` (or gateway build), `src/runtime.ts` (buildPromptMessages), `src/gateway.ts` (deps + RPC handlers), heartbeat runner (optional skip when empty), `openclaw.example.json`, `docs/configuration-reference.md`, `docs/codebase-reference.md`, `docs/rpc-api-reference.md`, UI nav and routes for Substrate page.
- Optional: `IDENTITY.md.example`, `SOUL.md.example`, `BIRTH.md.example`, `USER.md.example`, `TOOLS.md.example`, `AGENTS.md`, `CLAUDE.md`. Optional state: `memory/heartbeat-state.json`. Future: BOOT.md handling, MEMORY.md / memory/YYYY-MM-DD.md loading.

---

## 7) Document Metadata

- **Version:** 1.2  
- **Last updated:** 2026-02-14  
- **Status:** Implementation plan; execute phases in order and check off success criteria.
- **Changelog (1.1):** Integrated OpenClaw template definitions (SOUL, IDENTITY, USER, TOOLS, BOOTSTRAP, HEARTBEAT, AGENTS, BOOT, AGENTS.default) from docs.openclaw.ai/reference/templates/; added USER.md, TOOLS.md, BOOT.md and optional memory layer to substrate; added Phase 8 (USER/TOOLS), Phase 9 (HEARTBEAT skip + heartbeat-state), Phase 10 (BOOT + memory future); expanded guardrails and checkbox success criteria; HEARTBEAT empty = skip and continuity (Text > Brain) noted.
- **Changelog (1.2):** Added Phase 11 (Substrate UI and live reload): expose substrate files to the UI for viewing and editing; substrate store/getter so runtime uses current content each turn; RPCs substrate.list, substrate.get, substrate.update, substrate.reload; UI page with list/get/update and optional reload from disk; success criteria checkboxes and guardrails (path validation, allowed keys, no secrets warning, immediate effect without restart).
