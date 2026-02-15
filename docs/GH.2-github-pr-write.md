# GH.2 — GitHub PR Write Operations (Implementation Guide)

**Scope:** Enable the agent to **write** to pull requests in a controlled way: **comment on a PR** and **create a PR**. No merge, no workflow dispatch, no repo clone or other high-impact operations.

**Status:** Implementation guide only; no code implementation yet. Use this doc when implementing the feature. Depends on GH.1 (read-only PR) being implemented; auth and repo-scoping align with GH.1.

---

## 1. Goals and success criteria

### Goals

- Agent can **post a comment** on an existing pull request (e.g. `gh pr comment <number> --body "..."`).
- Agent can **create a new pull request** (e.g. `gh pr create --title "..." --body "..."` from the current branch).
- All GitHub access uses **host-configured auth**; no token in tool arguments or prompts.
- Write operations are **mutating** and require **explicit approval** (same model as other mutating tools).
- Implementation fits the existing approval and capability model and does not weaken security.

### Success criteria

- [ ] **Functional:** From the workspace (or configured repo), `gh pr comment <n> --body "..."` and `gh pr create --title "..." --body "..."` can be invoked by the agent after approval and succeed when auth is configured.
- [ ] **Auth:** No GitHub token in tool parameters, schema, or prompt; auth via host `gh auth` or `GH_TOKEN` in process environment only (same as GH.1).
- [ ] **Scope:** Only the two write operations above are exposed; no `pr merge`, `workflow run`, `repo clone`, or other mutating/high-impact commands.
- [ ] **Approval:** Every write invocation goes through the approval gate with intent **mutating** and required capabilities (e.g. `process.exec.mutate`); unapproved calls fail with a clear error and optional requestId.
- [ ] **Security:** Follow `docs/GH-CLI-SECURE-IMPLEMENTATION.md` and existing secret scanner; no new vectors for token leakage.
- [ ] **Docs:** Operator-facing doc explains write operations require approval, how to grant capability, and that auth is same as read-only (GH.1).

---

## 2. Auth and approval model

### Auth (same as GH.1)

- **Host auth or env token only:** Prefer `gh auth login` on the host; alternative `GH_TOKEN` / `GITHUB_TOKEN` in the CursorClaw process environment. No token in tool args or config sent to the model.
- **No token in tool args:** Tool schema must not include `token`, `apiKey`, or `GH_TOKEN`. Implementation runs `gh` in the same process environment.
- **Minimal scope:** If using a PAT, operator should use a fine-grained token with minimal scope (e.g. Pull requests read/write for the single repo). Document in operator guide.

### Approval model

- **Intent:** Treat `pr comment` and `pr create` as **mutating** (and network-impacting). They must require the same capability as other mutating exec operations (e.g. `process.exec.mutate` per `docs/GH-CLI-SECURE-IMPLEMENTATION.md` and `src/security/capabilities.ts`).
- **Gate:** Before running any write operation, call the same `ApprovalGate` used for `gh_pr_read`, with `intent: "mutating"` and a clear `plan` (e.g. "comment on PR #N" or "create PR"). If the gate returns false, throw a clear error (include `requestId` if available) and do not run `gh`.
- **Capabilities:** Use `requiredCapabilitiesForApproval` (or equivalent) so that the operator must have granted `process.exec.mutate` (and any tool-specific capability if added) for the approval to succeed. Document in CAPABILITIES.md.

---

## 3. Scope and out of scope

### In scope for GH.2

| Operation        | gh CLI equivalent                    | Approval   |
|------------------|--------------------------------------|------------|
| Comment on PR    | `gh pr comment <number> --body "..."`| Required   |
| Create PR        | `gh pr create --title "..." --body "..."` (and optional flags) | Required   |

### Out of scope for GH.2

- **No** `gh pr merge` (belongs to a later phase with merge policy and confidence gates; see `docs/GITHUB-CAPABILITY-ANALYSIS.md` Phase 3).
- **No** `gh workflow run`, `gh run rerun`, or CI dispatch.
- **No** `gh repo clone`, `gh repo fork`, or branch deletion.
- **No** posting review comments (file/line); only body comment. File-level review can be a future extension.

---

## 4. Implementation steps (for implementer)

### Step 1: Choose approach

- **Option A — Dedicated tool (recommended):** Add a new tool (e.g. `gh_pr_write`) with parameters such as `action: "comment" | "create"`, and for comment: `number`, `body`; for create: `title`, `body`, optional `base`, `head`. Allowlist only these two operations; map both to mutating intent; run `gh pr comment` or `gh pr create` via existing exec sandbox with same `cwd` and optional `--repo` as GH.1. No token parameter.
- **Option B — Extend exec allowlist:** If `gh` is exposed via exec (GH.1 Option A), extend the subcommand allowlist to include `pr comment` and `pr create` with **mutating** intent and require approval for those subcommands. Reject `pr merge` and all other write subcommands.

Recommendation: Option A (dedicated `gh_pr_write` or similar) for a clear audit trail and consistent pattern with `gh_pr_read`.

### Step 2: Tool schema (Option A)

- **comment:** `action: "comment"`, `number: number` (PR number), `body: string` (comment body). Sanitize or length-limit `body` to avoid abuse (e.g. max 32 KiB); reject empty body.
- **create:** `action: "create"`, `title: string`, `body?: string`, optional `base?: string`, optional `head?: string`. Use current branch as default for `head` if not provided; `base` defaults to default branch. Sanitize title/body (length, no control chars); reject empty title.

### Step 3: Repo scope

- Reuse GH.1 behavior: run `gh` with `cwd` at workspace root and, if configured, `--repo owner/repo` from `tools.gh.repoScope` so the agent cannot target other repositories.

### Step 4: Intent and approval

- Both operations: **mutating** + **network-impacting**. Call approval gate with `intent: "mutating"` and required capabilities (e.g. `process.exec.mutate`). Only run `gh` after approval returns true.

### Step 5: Registration and config

- **Config:** Reuse or extend `tools.gh` from GH.1. Add a flag if needed to enable write (e.g. `tools.gh.allowWrite: boolean`, default false) so operators can enable read-only first and opt in to write. Register the write tool only when `tools.gh.enabled` and `tools.gh.allowWrite` are true.
- **Registration:** Same approval gate and capability store as `gh_pr_read`; ensure capability checks require mutating capability for the new tool.

### Step 6: Operator documentation

- In configuration reference and operator README:
  - Write operations (comment, create PR) require approval and the mutating capability.
  - Auth is the same as read-only (no token in config or tool args).
  - Recommend branch protection so that merge still requires human or a separate gated workflow (see `docs/GITHUB-CAPABILITY-ANALYSIS.md` §4).

### Step 7: Tests

- Unit tests: allowlist allows `comment` and `create` with valid args; rejects unknown action and invalid args (e.g. empty body, missing number). Unapproved calls throw with message containing "approval" and optionally requestId.
- Integration test (optional, manual): with auth and approval granted, run comment and create and assert success or clear error.

---

## 5. Guardrails

- **Body/title length:** Enforce a maximum length (e.g. 32 KiB for body, 256 chars for title) to avoid abuse and API issues.
- **Injection:** Do not pass user-controlled strings into shell; use array args to `execFile` (same as `gh_pr_read`). For `body`, prefer passing via stdin or a temp file if the CLI supports it to avoid quoting issues; otherwise quote/escape per platform.
- **Rate limits:** Document that GitHub API rate limits apply; consider optional soft limits or backoff in a future iteration.

---

## 6. References

- `docs/GH.1-read-only-github-integration.md` — Read-only PR (list, view); auth and repo scope.
- `docs/GH-CLI-SECURE-IMPLEMENTATION.md` — Intent, capabilities, auth.
- `docs/GITHUB-CAPABILITY-ANALYSIS.md` — Phases 2 (PR create, review) and 3 (merge); branch protection.
- `src/tools.ts` — `createGhPrReadTool`, approval gate, exec sandbox.
- `src/security/capabilities.ts` — `requiredCapabilitiesForApproval`, mutating capability.
