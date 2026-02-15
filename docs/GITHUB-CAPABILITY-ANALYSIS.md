# GitHub Capability Analysis: Current State & Recommendations

**Purpose:** Analyze CursorClaw’s current ability to use GitHub (branching, file management, secrets, pull requests, code review, merge-to-main) and how the agent can use history and intelligence to manage the repo responsibly. Includes repo configuration to prevent irreversible damage.

**Status:** Analysis and recommendations (implementation roadmap).

---

## 1. Executive Summary

| Area | Current state | Gap |
|------|---------------|-----|
| **Branching** | Local git only (checkpoints, script-based `agent-memory` branch) | No `gh` or GitHub API; no feature-branch/PR workflow |
| **File management** | Workspace files + git checkout/refs | No GitHub-specific file/PR scope management |
| **Secret management** | Token detection, redaction, host auth plan | No tokens in tools; `gh` auth not wired |
| **Pull requests** | None | No create/list/view/merge PRs |
| **Code review** | None | No automatic or agent-driven reviews |
| **Merge to main** | None | No “confident merge” logic or branch protection awareness |
| **History / intelligence** | Decision journal, memory, confidence model | Not connected to GitHub (no PR/review history) |
| **Repo protection** | Not in codebase | Must be configured on GitHub; documented below |

The codebase is well prepared for **secure** GitHub integration (approval model, capabilities, secret scanning, exec intent) but **no GitHub-specific tooling or workflows are implemented yet**. The design is documented in `docs/GH-CLI-SECURE-IMPLEMENTATION.md`.

---

## 2. Current Capabilities (Evidence from Code)

### 2.1 Branching

- **Local git only**
  - `src/reliability/git-checkpoint.ts`: creates refs `checkpoint/<runId>-<ts>` from HEAD, rollback via `git reset --hard`, cleanup via `git branch -D`. Used for reliability rollback, not for feature branches or PRs.
  - `scripts/commit-memory-branch.js`: switches to `agent-memory`, force-adds memory files, commits, then returns to previous branch. Demonstrates branch create/checkout but is script-driven, not agent-driven.
- **No `gh` or GitHub API:** `gh` is not in `STRICT_EXEC_BINS` or default `tools.exec.allowBins` (`src/index.ts`, `src/config.ts`). No dedicated GitHub tool exists.

**Conclusion:** The agent cannot create or manage feature branches or interact with remote branches via GitHub today.

### 2.2 File Management

- Workspace file operations go through normal tooling (read/write, exec with allowlist).
- Git operations used internally: `rev-parse`, `status`, `branch`, `reset` in `GitCheckpointManager` only.
- No concept of “files in this PR” or “changed files in branch X”; no GitHub file-level API.

**Conclusion:** File management is workspace- and local-git only; no GitHub-scoped file or PR file management.

### 2.3 Secret Management

- **Detection:** `src/privacy/secret-scanner.ts` and config `privacy.detectors` include `"github-token"`; patterns like `ghp_*` are detected and should not appear in prompts or logs.
- **Redaction:** `src/security.ts` redacts `gh[pousr]_...` as `[REDACTED_GH_TOKEN]`.
- **Auth plan (not implemented):** `docs/GH-CLI-SECURE-IMPLEMENTATION.md` specifies using host `gh auth` or `GH_TOKEN` in the environment; no token in tool args or prompt.

**Conclusion:** Secrets are handled for prompts/logs; GitHub auth for a future `gh` tool is designed but not implemented.

### 2.4 Pull Requests

- No `gh pr create/list/view/merge` or GitHub API for PRs.
- `docs/GH-CLI-SECURE-IMPLEMENTATION.md` recommends a dedicated `gh` tool with allowlisted subcommands (e.g. read-only: `pr list`, `pr view`; mutating: `pr create`) and intent/capability mapping.

**Conclusion:** PR creation, listing, viewing, and merging are not implemented.

### 2.5 Code Review (Automatic)

- No integration with GitHub Checks, Review Comments, or code review APIs.
- CI runs on push and pull_request (`.github/workflows/ci.yml`: test, build, security tests, red-team, audit) but the agent does not consume results or post reviews.

**Conclusion:** No automatic or agent-driven code review; CI exists but is not used by the agent for “review” or “merge” decisions.

### 2.6 Merge Confident Code to Main

- **Confidence model:** `src/reliability/confidence-model.ts` scores runs (failures, deep scan, plugin diagnostics, tool call volume, recent tests passing). Used for runtime scoring and rationale, not for merge decisions.
- No logic that:
  - Maps “high confidence” to “safe to merge”
  - Calls `gh pr merge` or GitHub merge API
  - Respects or checks branch protection (e.g. “require status checks”)

**Conclusion:** There is no “merge confident code to main” feature; confidence is used only in the run envelope, not for GitHub actions.

### 2.7 History and Intelligence for Repo Management

- **Decision journal** (`src/decision-journal.ts`, `src/runtime.ts`): Recent entries (e.g. last 5) are read and injected into the system prompt for “rationale continuity.” Used for checkpoints, approvals, and tool denials—not for GitHub events.
- **Memory:** `MEMORY.md`, `memory/`, `remember_this`, `recall_memory` for long-term facts and preferences—no GitHub-specific memory (e.g. “last PR merged”, “branch strategy”).
- **Run store / observations:** Run history and observations exist but are not wired to “what happened on GitHub.”

**Conclusion:** The agent has continuity and memory, but none of it is tied to GitHub (branches, PRs, reviews, merges). The agent cannot yet “use history to manage the repo” in a GitHub sense.

---

## 3. Security and Approval Model (Ready for GitHub)

The existing model can support GitHub operations without redesign:

- **Exec allowlist and intent:** `classifyCommandIntent` in `src/tools.ts` does not treat `gh`; if `gh` were added to exec, intent would need to be at least `network-impacting` and `mutating` for subcommands like `pr create` / `workflow run` (see GH-CLI-SECURE-IMPLEMENTATION.md).
- **Capabilities:** `process.exec`, `process.exec.mutate`, `net.fetch` already exist; a dedicated `repo.gh` or similar could be added for mutating GitHub actions.
- **Approval workflow:** `ApprovalWorkflow` + `CapabilityApprovalGate` in `src/security/` support request/approve/deny and TTL/uses; suitable for “allow this PR create” or “allow merge.”
- **Destructive denylist:** `src/security/destructive-denylist.ts` blocks high-impact shell patterns; could be extended to block dangerous `gh` or git patterns (e.g. force-push to main) if exposed via exec.

So: **branching, PRs, and merge can be added in a way that flows through the same approval and capability model.**

---

## 4. GitHub Repo Configuration to Prevent Irreversible Damage

Branch protection and rules are configured in **GitHub Settings** (and optionally via GitHub API/terraform), not in the repo tree. Below is what to configure so the AI (and humans) cannot easily damage the repo in an unrecoverable way.

### 4.1 Branch Protection for `main`

Configure in **Settings → General → Branch protection → Add rule** for `main`:

| Setting | Recommendation | Rationale |
|--------|----------------|-----------|
| **Require a pull request before merging** | On, minimum 1 approval (or “allow specified actors” for bot) | Prevents direct push/merge to main; all changes go through a PR. |
| **Require status checks to pass** | On; require `test-build` and `security` (from `ci.yml`) | Ensures CI (tests, security, red-team) must pass before merge. |
| **Require branches to be up to date** | On | Reduces accidental merge of stale code. |
| **Do not allow bypassing the above** | No bypass for anyone (or only for a small “release” group) | Ensures the agent cannot bypass checks even with write access. |
| **Restrict who can push to matching branches** | Optional: limit to specific users/bots | Further limits who can push to main. |
| **Allow force pushes** | Disable for everyone | Prevents history rewrite on main. |
| **Allow deletion** | Disable for main | Prevents deleting the default branch. |

These settings make “merge to main” only possible via a PR that passes CI and (if you require reviews) approval, so the agent cannot silently force-push or merge broken code if it only has “create PR” and “merge PR” capabilities under approval.

### 4.2 Rulesets (Repository rules)

If using **Rules → Rulesets**:

- **Target:** `main` (or default branch).
- **Rules:**  
  - Require pull request before merging.  
  - Require status checks: `test-build`, `security`.  
  - Block force pushes and branch deletion for `main`.

This reinforces the same guarantees in a ruleset form.

### 4.3 What the Agent Should Not Be Able to Do (Even With Approval)

Recommend **not** granting the agent (or its token) permission to:

- Force-push to any branch (blocked by branch protection if set as above).
- Delete the default branch or protected branches.
- Change branch protection rules (reserve for org/repo admins).
- Delete the repository or transfer it.
- Modify GitHub Actions workflows in a way that disables required checks (optional: use CODEOWNERS or required review for `.github/`).

Fine-grained PAT or OAuth scopes should be minimal: e.g. **Contents** (read/write for the repo), **Pull requests** (read/write), and **Statuses** (read). Avoid **Administration** and **Metadata** write if not needed.

### 4.4 Documenting in the Repo

Add a short doc (e.g. `.github/BRANCH_PROTECTION.md` or a section in `docs/`) that states:

- `main` is protected: PR required, status checks required, no force push, no deletion.
- The agent is designed to work via PRs and must not bypass these rules.
- Who can change these settings (e.g. repo admins only).

This does not configure GitHub itself but makes the policy explicit for operators and future agent prompts.

---

## 5. Recommended Implementation Roadmap

### Phase 1: Safe GitHub read and branch/PR workflow (no merge)

1. **Implement dedicated `gh` tool** (Option B in GH-CLI-SECURE-IMPLEMENTATION.md):
   - Allowlisted subcommands: e.g. `pr list`, `pr view`, `issue list`, `repo view`, `run list`, `workflow list`, `status` (read-only); `pr create`, `workflow run` (mutating, require approval).
   - Do **not** allowlist `pr merge`, `repo clone`, or other high-impact commands yet.
   - Use host `gh` auth or `GH_TOKEN`; no token in tool args.
   - Optional: `repoScope` config to pin `--repo owner/repo`.
2. **Add `gh` to capabilities:** e.g. reuse `process.exec` + `net.fetch` for read-only, `process.exec.mutate` for mutating, or add `repo.gh` and document in capabilities.
3. **Configure branch protection** on GitHub as in §4.1–4.2 so that even with a future “merge” capability, the agent cannot merge without a PR and passing CI.

### Phase 2: PR creation and optional code review

1. Allow agent to **create** PRs (already in Phase 1 if `pr create` is allowlisted and approval is required).
2. **Automatic “review”:**  
   - Option A: Agent uses existing CI; interpret “CI passed” as a synthetic “review” and inject that into context (e.g. “CI passed for this PR”).  
   - Option B: Use GitHub API or `gh pr review` to post a comment or review (e.g. “Automated: CI passed; confidence score X”).  
   Both require the agent to know the PR number (from `pr create` output or `pr list`).
3. **No merge yet:** Keep `pr merge` off the allowlist so the agent cannot merge; humans (or a separate, gated workflow) merge.

### Phase 3: Merge confident code to main (gated)

1. **Policy:** Only allow “merge” when:
   - The PR was created by the agent (or is the current agent PR).
   - Required status checks have passed (enforced by GitHub).
   - Optional: confidence score above a threshold (e.g. from `ConfidenceModel`) and/or “recent tests passing” from run state.
2. **Allowlist** `pr merge` (or equivalent) only for the dedicated `gh` tool, with a distinct capability (e.g. `repo.gh.merge`) and approval.
3. **History:** Log “merge” decisions in the decision journal and optionally in memory (e.g. “Merged PR #N to main at …”) so the agent can use past merges in rationale.

### Phase 4: History and intelligence

1. **Inject GitHub context into prompts:** e.g. “Open PRs: …”, “Last merge to main: PR #N, …” using `gh pr list` and (if available) run store or memory.
2. **Memory:** Store high-level facts (e.g. “We use branch-per-feature; merge only after CI and approval”) and use `recall_memory` when planning PR/merge actions.
3. **Decision journal:** Continue logging checkpoints, approvals, and tool denials; add entries for “PR created”, “merge requested”, “merge denied” so the agent’s next turn has continuity.

---

## 6. Summary Table: Current vs Target

| Capability | Current | Target (after roadmap) |
|------------|---------|-------------------------|
| Branching | Local git checkpoints + script | Agent can create/use feature branches via `gh` / git |
| File management | Workspace + local git | Unchanged; optional: “files in this PR” from `gh` |
| Secret management | Detection + redaction; auth plan | Same + host auth for `gh` |
| Pull requests | None | Create/list/view; merge only in Phase 3 with gates |
| Code review | None | CI as signal; optional agent-posted review |
| Merge to main | None | Only when PR + CI + optional confidence; approval |
| History / intelligence | Decision journal + memory (no GitHub) | Journal + memory + GitHub context (PRs, last merge) |
| Repo protection | Not in repo | Branch protection + rules on GitHub; documented in repo |

The codebase is in a good position to add GitHub support securely; the main work is implementing the `gh` tool, wiring confidence and CI into a merge policy, and configuring GitHub so that the agent cannot bypass PRs and status checks, ensuring recoverable and auditable changes to `main`.
