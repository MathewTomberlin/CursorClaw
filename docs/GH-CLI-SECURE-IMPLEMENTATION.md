# Secure GitHub CLI (gh) Support for the Agent

**Purpose:** Analyze the codebase and define a way to implement secure `gh` CLI support so the agent can autonomously interact with the repository using the existing approval and capability model.

**Status:** Analysis and implementation plan (not yet implemented).

---

## 1. Codebase summary

### 1.1 How execution and approval work today

- **Exec tool** (`src/tools.ts`): `createExecTool` runs a single binary + args via `ExecSandbox` (default: `HostExecSandbox` in `src/exec/host-sandbox.ts`). Commands are split on whitespace; the **first token** is the binary. Only binaries in `allowedBins` may run; if the binary is not in the allowlist, the request goes to the **approval gate** (when `ask` is `"on-miss"`). Intent is classified (`classifyCommandIntent`) as `read-only` | `mutating` | `network-impacting` | `privilege-impacting`; non–read-only intents require approval. Destructive commands are blocked by signature in `src/security/destructive-denylist.ts` unless the gate supports destructive approval.

- **Allowlist resolution** (`src/index.ts`): `resolveAllowedExecBins` uses config `tools.exec.allowBins` and profile. In **strict** profile, only bins present in **`STRICT_EXEC_BINS`** are allowed (currently `echo`, `pwd`, `ls`, `cat`, `node`). In **developer** profile or **devMode**, all configured `allowBins` are used. So adding `gh` to config alone is not enough in strict mode unless `gh` is also added to `STRICT_EXEC_BINS`.

- **Approval and capabilities** (`src/security/approval-workflow.ts`, `src/security/capabilities.ts`): The **ApprovalWorkflow** creates pending requests with **requiredCapabilities** derived from tool + intent. **CapabilityStore** holds grants (e.g. `process.exec`, `process.exec.mutate`, `net.fetch`). **CapabilityApprovalGate** (in `tools.ts` or security layer) can approve when the operator has granted the required capabilities (or when policy allows, e.g. read-only without grant). Required capabilities for `exec`:
  - read-only: none
  - network-impacting: `process.exec`, `net.fetch`
  - mutating: `process.exec`, `fs.write`, `process.exec.mutate`
  - privilege-impacting: `process.exec`, `process.exec.privileged`
  - high-risk-tool: `process.exec` for exec tool

- **Config** (`src/config.ts`): `tools.exec` has `allowBins`, `profile`, `ask`, `maxBufferBytes`, `maxChildProcessesPerTurn`. No gh-specific config exists yet.

- **Secrets**: `privacy/secret-scanner.ts` and config `privacy.detectors` include `"github-token"`; tokens (e.g. `ghp_*`) are detected and should not appear in prompts or logs. Auth for `gh` should rely on host-configured auth (`gh auth login` or `GH_TOKEN` in the environment) or a dedicated minimal-scope token stored outside the prompt.

### 1.2 Relevant files

| Area            | Files |
|-----------------|-------|
| Exec tool       | `src/tools.ts` (createExecTool, classifyCommandIntent), `src/exec/host-sandbox.ts`, `src/exec/types.ts` |
| Allowlist       | `src/index.ts` (STRICT_EXEC_BINS, resolveAllowedExecBins, createExecTool registration) |
| Approval        | `src/security/approval-workflow.ts`, `src/security/capabilities.ts`, `src/tools.ts` (ApprovalGate, PolicyApprovalGate, CapabilityApprovalGate) |
| Config          | `src/config.ts` (ToolsConfig.exec, default allowBins) |
| Destructive     | `src/security/destructive-denylist.ts` |
| Git/repo usage  | `src/reliability/git-checkpoint.ts` (git in workspace), workspace roots in config |

---

## 2. Security considerations for gh

- **Authentication:** Prefer using the host’s existing `gh` auth (`gh auth status`) or `GH_TOKEN` set in the environment where CursorClaw runs. Do not pass tokens in tool args or prompt; the secret scanner already flags github tokens. For minimal-privilege, the operator can create a fine-grained PAT or use OAuth with minimal scopes (e.g. repo read + PR read/write for the single repo).
- **Scope:** Limit operations to the **current repository** when possible (e.g. workspace root = git repo). Restrict or allowlist subcommands so the agent cannot run arbitrary `gh repo clone <other-org>/<other-repo>` or other high-impact actions without going through approval.
- **Intent:** Most `gh` commands are network-impacting (API calls); many are mutating (e.g. `pr create`, `workflow run`). They should flow through the same approval/capability model as other exec or dedicated tools.
- **Rate limits:** GitHub API rate limits apply; the agent could hit them if it runs many gh commands. Document this and optionally add soft limits or backoff in a future iteration.

---

## 3. Implementation options

### Option A: Add `gh` to the exec allowlist

- **Mechanics:** Add `gh` to default `tools.exec.allowBins` and to `STRICT_EXEC_BINS` in `src/index.ts` so it is allowed in strict profile. The exec tool already splits on whitespace, so `gh pr list` becomes binary `gh`, args `["pr", "list"]` — which is correct for `execFile` (no shell).
- **Intent:** `classifyCommandIntent` does not currently treat `gh` specially; it would fall through to “read-only” (no match for sudo, curl, rm, etc.). So every `gh` invocation would be treated as read-only and would not require approval by intent. That is **incorrect** for most gh usage (API calls and mutations).
- **Changes needed:**  
  - Extend `classifyCommandIntent` so that when the binary is `gh`, intent is at least `network-impacting`, and for mutating subcommands (e.g. `pr create`, `workflow run`, `run`) treat as `mutating`.  
  - Add `gh` to `STRICT_EXEC_BINS` and to default `allowBins`.  
  - Optionally restrict subcommands in the exec tool (e.g. allowlist of `gh <subcommand>` patterns) so that only safe/approved subcommands are allowed without additional approval.
- **Pros:** Small change set; reuses existing exec + approval path.  
- **Cons:** Exec is generic; any `gh` subcommand could be invoked (e.g. `gh repo clone`); subcommand allowlisting would need to be added inside the exec tool or in a wrapper. Arg sanitization for `gh` (e.g. avoiding injection of extra commands) is easier if we only pass through allowlisted subcommands.

### Option B: Dedicated `gh` tool

- **Mechanics:** New tool (e.g. `gh_cli` or `gh`) with a schema such as `{ subcommand: string, args?: string[], cwd?: string }`. The implementation allowlists subcommands (e.g. `pr list`, `pr view`, `issue list`, `repo view`, `workflow run`, `run list`) and maps them to intent (read-only vs mutating). It then calls the approval gate with the appropriate intent and, if approved, runs `gh <subcommand> ...args` via the same host sandbox (or a thin wrapper) with `cwd` set to workspace root or configured repo path.
- **Intent and capabilities:** Read-only subcommands (e.g. `pr list`, `pr view`, `issue list`) → no capability or only `process.exec`; mutating (e.g. `pr create`, `workflow run`) → require approval and `process.exec.mutate` (and possibly a dedicated capability like `repo.gh_write` later). All gh API usage could be considered `network-impacting` for logging.
- **Auth:** No token in args; run `gh` in the process environment so it uses `gh auth` / `GH_TOKEN`. Optionally document that the operator must run `gh auth login` or set `GH_TOKEN` before using the tool.
- **Pros:** Explicit allowlist of subcommands; easier to add repo-scoping (e.g. `--repo owner/repo` from config); clearer audit trail (tool name + subcommand).  
- **Cons:** More code; need to maintain a subcommand list and intent mapping.

---

## 4. Recommended approach

**Recommendation:** **Option B (dedicated gh tool)** for security and clarity, with a small set of allowlisted subcommands and explicit intent/capability mapping. If the team prefers minimal change and accepts broader gh usage through exec, **Option A** is viable after fixing intent classification and optionally adding subcommand allowlisting to exec for the `gh` binary.

Concrete recommendation for Option B:

1. **New capability (optional but useful):** Add a capability such as `repo.gh` or reuse `process.exec` + `net.fetch` for read-only, and `process.exec.mutate` for mutating gh subcommands. Document in `CAPABILITIES.md`.
2. **New tool:** `createGhCliTool` in `src/tools.ts` (or `src/tools/gh-cli.ts`):
   - Schema: `subcommand` (e.g. `"pr list"`, `"pr view"`, `"workflow run"`), optional `args` array, optional `cwd`.
   - Allowlist of allowed subcommands with intent (read-only vs mutating). Examples:
     - Read-only: `pr list`, `pr view`, `issue list`, `issue view`, `repo view`, `run list`, `run view`, `workflow list`, `status`.
     - Mutating (require approval): `pr create`, `workflow run`, `run rerun`, etc.
   - Run via existing `ExecSandbox` (e.g. `HostExecSandbox`) with binary `gh` and args = subcommand split + user args; set `cwd` to workspace root or config.
   - Call existing `ApprovalGate` with intent; use `requiredCapabilitiesForApproval` or extend capabilities for gh mutating actions.
3. **Config:** Optional `tools.gh` (or under `tools.exec`) with:
   - `enabled: boolean`
   - `allowedSubcommands: string[]` or a structured allowlist (subcommand → intent)
   - `repoScope?: string` (e.g. `owner/repo`) to force `--repo owner/repo` for all calls so the agent cannot target other repos.
4. **Registration:** In `src/index.ts`, if `config.tools.gh?.enabled`, register the gh tool with the same `approvalGate` and optional `capabilityStore`/workflow used for exec.
5. **Auth:** Document that `gh` must be authenticated on the host (e.g. `gh auth login`) or via `GH_TOKEN`; do not read or pass tokens in the tool. Rely on existing secret scanner to avoid leaking tokens in prompts.
6. **Testing:** Unit tests for allowlist (allowed vs disallowed subcommands), intent mapping, and approval gate integration; integration test that a read-only gh call succeeds when capabilities are granted and a mutating one requires approval.

---

## 5. Implementation checklist (Option B)

- [ ] Add `tools.gh` (or equivalent) to config type and defaults in `src/config.ts` (e.g. `enabled: false`, `allowedSubcommands` or structured allowlist, optional `repoScope`).
- [ ] Implement `createGhCliTool` (and optionally `requiredCapabilitiesForApproval` for tool name `gh_cli` in `capabilities.ts`).
- [ ] Subcommand allowlist: define read-only vs mutating; reject unknown subcommands.
- [ ] Run `gh` via `ExecSandbox` with `cwd` from workspace root; optionally inject `--repo` when `repoScope` is set.
- [ ] Register the tool in `src/index.ts` when enabled; pass `approvalGate` and ensure capability checks align with existing approval workflow.
- [ ] Document in `CAPABILITIES.md` and in `docs/configuration-reference.md` (gh tool config, auth requirements).
- [ ] Add tests (allowlist, intent, approval path).
- [ ] Ensure no GH token is passed in args or prompt; document operator setup (`gh auth login` or `GH_TOKEN`).

---

## 6. Option A quick path (if preferred)

If using Option A (exec allowlist) instead:

- [ ] Add `gh` to `STRICT_EXEC_BINS` and to default `tools.exec.allowBins` in `src/config.ts`.
- [ ] In `classifyCommandIntent`, when the first token (binary) is `gh`, return at least `network-impacting`; optionally parse the second token (e.g. `pr`, `workflow`) and args to classify as `mutating` for `pr create`, `workflow run`, etc.
- [ ] Optionally in the exec tool: when binary is `gh`, check a subcommand allowlist and reject or require approval for disallowed subcommands.
- [ ] Document that gh is available via exec and that auth must be configured on the host; document rate limits and repo scope (operator responsibility or future config).

---

## 7. Summary

The codebase already has a clear model for secure execution: **allowlist + intent classification + approval workflow + capabilities**. Secure gh support fits this model by either (A) adding `gh` to the exec allowlist and fixing intent for gh, or (B) adding a dedicated gh tool with an explicit subcommand allowlist and intent/capability mapping. Option B is recommended for tighter control and clearer auditability; Option A is acceptable with correct intent classification and optional subcommand checks. Auth should rely on host-configured `gh` or `GH_TOKEN`; no tokens in tool args or prompts.
