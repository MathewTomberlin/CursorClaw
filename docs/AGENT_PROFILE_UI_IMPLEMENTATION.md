# Agent Profile UI and Sidebar — Implementation Plan

**Purpose:** Add UI to create/delete agent profiles and make the sidebar show data for the currently selected agent profile. Use this document as the implementation guide (e.g. across heartbeats) until complete.

**Prerequisite:** Backend agent profiles are implemented per `docs/AGENT_PROFILES_SKILLS_PROVIDER_IMPLEMENTATION.md` (config `profiles`, `profileId` in RPC params, profile root resolution). This plan adds **profile management RPCs**, **multi-profile gateway support** (so the UI can switch profiles without restart), and **UI changes**.

---

## 1) Overview

| Area | Summary |
|------|--------|
| **Profile CRUD UI** | User can create a new agent profile (id + root) and delete an existing profile from the UI. |
| **Profile selector** | A single "current profile" is selected in the UI; all profile-scoped views and RPCs use this profile. |
| **Sidebar** | Sidebar buttons (Dashboard, Chat, Approvals, Cron, Workspace, Memory, Incidents, Substrate, Heartbeat, Trace) show data for the **currently selected agent profile**. Config remains global (app-level config). |
| **Backend** | Add `profile.list`, `profile.create`, `profile.delete` RPCs; ensure gateway resolves profile root per request so multiple profiles work in one process. |

**Design choice (sidebar):** Use **one list of sidebar buttons** and **one profile selector** (e.g. dropdown at top of nav). Buttons do not repeat per profile; each page sends the selected `profileId` in RPC params so the backend returns that profile’s data. This avoids nested navigation and keeps the UI simple.

---

## 2) Success Criteria

- **Profile list:** UI can list all agent profiles (from config). When no profiles are configured, a single default profile is shown (id `"default"`, current workspace root).
- **Create profile:** User can create a new profile (id, root). Backend adds it to `config.profiles`, creates the profile root directory (and minimal structure if needed), and persists config to disk. New profile is available for selection without requiring restart (see backend multi-profile support).
- **Delete profile:** User can delete an existing profile (with confirmation). Backend removes it from `config.profiles`, optionally removes the profile directory, and persists config. Default profile cannot be deleted when it’s the only one.
- **Profile selector:** UI has a clear way to select the active profile (e.g. dropdown in nav). Selected profile is persisted in session/local storage so it survives refresh.
- **Sidebar scope:** All profile-scoped pages (Chat, Approvals, Cron, Workspace, Memory, Incidents, Substrate, Heartbeat, Trace) pass the selected `profileId` in every RPC call. Dashboard and Config may stay global (Dashboard shows aggregate or default-profile status; Config shows main config).
- **No regressions:** Single-profile (no `profiles` in config) behavior unchanged. Existing tests pass. No path traversal; profile root remains under workspace.
- **Guardrails:** Create/delete validate id and root; no overwrite of existing profile id; delete does not leave config in invalid state (e.g. at least one profile or fallback to default).

---

## 3) Guardrails (Regression and Safety)

- **Path safety:** Profile root must resolve under the workspace (or configured base). Reuse existing `resolveProfileRoot` validation; reject create with root outside base.
- **Backward compatibility:** If `config.profiles` is absent or empty, treat as single profile (id `"default"`, root = workspace). UI shows one profile; no create/delete needed.
- **Config persistence:** profile.create and profile.delete must write `openclaw.json` (or configured path) atomically where possible (write temp file then rename), and validate config after merge so invalid JSON or invalid structure is not written.
- **Idempotency / conflicts:** Create must not add duplicate id. Delete of last profile should either be rejected or revert to single default profile.
- **No cross-profile leakage:** Backend must use the resolved profile root for each request; no shared in-memory state between profiles for substrate, memory, approvals, cron, heartbeat.
- **Tests:** Add tests for profile.list (single vs multi), profile.create (success, duplicate id, invalid root), profile.delete (success, delete default when only one); gateway passes profileId to profile-scoped RPCs and uses correct root.

---

## 4) Implementation Phases

### Phase U.1 – Backend: Profile list and status

- [x] **U.1.1** Expose profile list to UI: either add `profiles` to `GET /status` (array of `{ id, root, modelId? }`) or document that UI uses `config.get` and reads `result.profiles`. Prefer adding `profiles` and `defaultProfileId` to `/status` so the UI does not need full config for the selector.
- [x] **U.1.2** Ensure `config.get` returns `profiles` (and redacted secrets) so Config page can show and edit if needed.

### Phase U.2 – Backend: Profile create and delete RPCs

- [x] **U.2.1** Add RPC `profile.list`: returns `{ profiles: { id, root, modelId? }[], defaultProfileId: string }`. Use config; when no profiles, return `[{ id: "default", root: "." }]` and defaultProfileId `"default"`.
- [x] **U.2.2** Add RPC `profile.create` with params `{ id: string, root: string }`. Validate id (non-empty, no duplicate); validate root (resolve under workspace, no path traversal). Append to `config.profiles` (or create array with default + new). Create directory at resolved root (mkdir -p). Persist config to disk (`resolveConfigPath`, then write merged JSON). Return `{ profile: { id, root }, configPath }`. Scope: admin, local.
- [x] **U.2.3** Add RPC `profile.delete` with params `{ id: string, removeDirectory?: boolean }`. Validate id exists in config.profiles; if it's the only profile, reject or convert to default (no profiles). Remove from config, persist to disk. If removeDirectory, delete the profile root directory (only if under workspace). Return `{ ok: true }`. Scope: admin, local.
- [x] **U.2.4** Document in `docs/rpc-api-reference.md` and add METHOD_SCOPES for profile.*.

### Phase U.3 – Backend: Multi-profile gateway support

- [x] **U.3.1** Gateway deps: add `workspaceDir: string` (process cwd / workspace root) and `config: CursorClawConfig` if not already present, and a way to resolve profile root per request. Option A: pass `resolveProfileRoot` and call it with `(workspaceDir, config, resolvedProfileId)`. Option B: pass a map `profileId -> profileRoot` or `getProfileRoot(profileId)` built at startup from config. Use the same path safety as in config (reject if outside workspace).
- [x] **U.3.2** For profile-scoped RPCs (substrate.*, memory.*, heartbeat.*, approval.*, cron.*), resolve the profile root using `resolvedProfileId`. Today the gateway uses a single `deps.workspaceDir` (one profile root). Change to: compute `profileRoot = getProfileRoot(resolvedProfileId)` (or resolve from config) for these RPCs. That requires the gateway to have access to per-profile roots; index.ts currently wires one profile. So either:
  - **Option A (recommended):** Index builds a **profile context map**: for each profile in config (or default), create the necessary stores (SubstrateStore, ApprovalWorkflow, CapabilityStore, CronService, etc.) with that profile’s root. Pass to gateway something like `getProfileContext(profileId)` returning `{ profileRoot, substrateStore, approvalWorkflow, capabilityStore, cronService, ... }`. Gateway then uses that context for the request. This implies index.ts creates N sets of stores when N profiles exist.
  - **Option B:** Gateway only has `workspaceDir` + config; for each request it computes profileRoot = resolveProfileRoot(workspaceDir, config, resolvedProfileId). Then substrate/memory/heartbeat/approval/cron handlers must accept a dynamic root. That would require refactoring those services to take root per call (or gateway to have one store that can reload per path). Option A is cleaner for existing store design.
- [x] **U.3.3** Implement Option A: In index.ts, when `config.profiles` is present, loop over profiles and for each build the same dependency set (substrate, memory, approvals, cron, etc.) with that profile’s root. Store in a Map<profileId, context>. When no profiles, keep current single context as "default". Pass to gateway a function `getProfileContext(profileId)` that returns the context for that profile (or default). Gateway calls it with `resolvedProfileId` and uses the returned context for substrate, memory, heartbeat, approval, cron RPCs. Ensure agent.run continues to receive session.profileId so runtime uses correct model and profile.
- [x] **U.3.4** Heartbeat poll/getFile/update, substrate list/get/update/reload, memory listLogs/getFile/writeFile, approval list/resolve/capabilities, cron list/add: all use the resolved profile context (profile root and profile-specific stores). Document that these RPCs are profile-scoped.

### Phase U.4 – UI: Profile selector and context

- [x] **U.4.1** Add a **profile context** in the UI (e.g. React context or global state): current `selectedProfileId`, setter, and optional list `profiles` from status or profile.list. Persist selectedProfileId in sessionStorage (e.g. `cursorclaw_selected_profile_id`).
- [x] **U.4.2** Add **profile selector** in the nav (sidebar): dropdown or list showing profile ids; on change update selectedProfileId and persist. When only one profile, selector can be a single label (no dropdown). Load profile list from GET /status (profiles + defaultProfileId) or from profile.list on mount.
- [x] **U.4.3** Ensure all RPC calls that are profile-scoped include `profileId: selectedProfileId` in params. Create a small helper if needed, e.g. `rpcWithProfile(method, params, profileId)` that merges profileId into params. Use it in Approvals, Cron, Workspace, Memory, Incidents, Substrate, Heartbeat, Trace, and Chat (agent.run uses profileId for the session).

### Phase U.5 – UI: Create and delete profile

- [x] **U.5.1** Add a **Profiles** section or modal: "Create profile" and "Delete profile". Create: form with Profile id and Root (e.g. `profiles/assistant`); submit calls `profile.create`; on success refresh profile list and optionally select the new profile. Delete: list profiles (or use selector); "Delete" with confirmation; call `profile.delete`; on success refresh list and if deleted was selected, switch to default.
- [x] **U.5.2** Place the create/delete UI in a sensible place: e.g. Config page (Profiles subsection) or a dedicated "Profiles" nav item, or a small "Manage profiles" in the profile selector dropdown. Prefer Config page "Profiles" subsection plus "New profile" / "Delete" in the selector dropdown for quick access.

### Phase U.6 – UI: Sidebar and pages use selected profile

- [x] **U.6.1** Ensure Dashboard and Config do not require a profile (or use default for display). All other nav targets (Chat, Approvals, Cron, Workspace, Memory, Incidents, Substrate, Heartbeat, Trace) pass selectedProfileId in every RPC. Verify each page: Approvals, Cron, Workspace, Memory, Incidents, Substrate, Heartbeat, Trace, Chat.
- [x] **U.6.2** If GET /status or any RPC returns per-profile data in the future, use selectedProfileId to show the right slice. For now, passing profileId in RPC params is sufficient so the backend returns that profile’s data once U.3 is done.

### Phase U.7 – Tests and docs

- [x] **U.7.1** Tests: profile.list (no profiles → default; with profiles → list); profile.create (success, duplicate id, invalid root); profile.delete (success, delete only profile rejected). Gateway: when profileId is passed, profile-scoped RPC uses correct root (integration test with two profiles).
- [x] **U.7.2** Update `docs/rpc-api-reference.md` with profile.list, profile.create, profile.delete; document profile-scoped RPCs and that /status includes profiles and defaultProfileId.
- [x] **U.7.3** Run full test suite; fix any regressions.

---

## 5) Order of Work (for heartbeats)

Suggested order so each heartbeat can deliver a coherent slice:

1. **Heartbeat 1:** Phase U.1 (profile list in status) + U.2 (profile.list, profile.create, profile.delete RPCs and config write). No UI yet; tests for new RPCs.
2. **Heartbeat 2:** Phase U.3 (multi-profile gateway: profile context map in index, gateway getProfileContext, all profile-scoped RPCs use it). Tests for gateway with two profiles.
3. **Heartbeat 3:** Phase U.4 (UI profile context, profile selector in nav, persist selectedProfileId; all relevant pages pass profileId in RPC).
4. **Heartbeat 4:** Phase U.5 (Create/delete profile UI in Config or selector).
5. **Heartbeat 5:** Phase U.6 (audit all pages for profileId) + U.7 (tests, docs, full suite).

---

## 6) Document metadata

- **Version:** 1.0
- **Status:** Complete. All phases U.1–U.7 implemented; profile list/create/delete, multi-profile gateway, UI selector and CRUD, sidebar scope, tests and docs done.
- **Changelog (1.0):** Initial plan for Agent Profile UI and sidebar with success criteria, guardrails, and phased implementation.
