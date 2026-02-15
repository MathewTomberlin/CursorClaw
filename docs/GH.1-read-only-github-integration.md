# GH.1 — Read-Only GitHub Integration (Implementation Guide)

**Scope:** Enable the agent to **read** pull request information via GitHub CLI: `gh pr list` and `gh pr view` only. No PR creation, merge, or other mutating operations.

**Status:** Implementation guide only; no code implementation yet. Use this doc when implementing the feature.

---

## 1. Goals and success criteria

### Goals

- Agent can list open (and optionally closed) PRs for the current repo.
- Agent can view a single PR’s details (title, body, status, head/base, etc.) by number or branch.
- All GitHub access uses **host-configured auth**; no token in tool arguments or prompts.
- Implementation fits the existing exec allowlist + intent + approval model (or a dedicated tool) and does not weaken security.

### Success criteria

- [ ] **Functional:** From the workspace (or configured repo), `gh pr list` and `gh pr view <n>` (or equivalent) can be invoked by the agent and return correct data when auth is configured.
- [ ] **Auth:** No GitHub token appears in tool parameters, tool schema, or prompt; auth is via host `gh auth status` / `gh auth login` or `GH_TOKEN` in the process environment only.
- [ ] **Scope:** Only the two subcommands (or their dedicated-tool equivalents) are exposed; no `pr create`, `pr merge`, `repo clone`, or other mutating/high-impact commands.
- [ ] **Security:** Implementation follows `docs/GH-CLI-SECURE-IMPLEMENTATION.md` (intent at least network-impacting; optional dedicated tool with allowlist). Existing secret scanner and redaction for GitHub tokens remain in effect.
- [ ] **Docs:** Operator-facing doc explains how to set up auth (`gh auth login` or `GH_TOKEN`) and that only read-only PR operations are allowed.

---

## 2. Auth guardrails (mandatory)

- **Host auth or env token only**
  - Prefer: operator runs `gh auth login` on the host where CursorClaw runs; the agent’s `gh` invocations use that session.
  - Alternative: set `GH_TOKEN` (or `GITHUB_TOKEN`) in the **environment** of the CursorClaw process (e.g. fine-grained PAT or OAuth token). The token must **not** be passed as a tool argument or stored in config that is sent to the model.
- **No token in tool args**
  - The tool schema must **not** include a `token`, `apiKey`, or `GH_TOKEN` parameter. The implementation must call `gh` in the same process environment so `gh` picks up host auth or `GH_TOKEN` automatically.
- **No token in prompts**
  - Existing controls: `privacy/secret-scanner.ts` and `src/security.ts` already detect and redact GitHub token patterns. Do not add code that places tokens into prompts or logs.
- **Minimal scope**
  - If using a PAT, operator should use a fine-grained token with minimal scope (e.g. read-only for Pull requests and Repository metadata for the single repo). Document this in the operator guide.

---

## 3. Implementation steps (for implementer)

### Step 1: Choose approach

- **Option A — Exec allowlist:** Add `gh` to the exec allowlist (`allowBins` and, if used, `STRICT_EXEC_BINS`). Extend `classifyCommandIntent` so that when the binary is `gh`, intent is at least `network-impacting`. **Restrict to subcommands:** in the exec path, when binary is `gh`, allow only `pr list` and `pr view` (e.g. second token `pr`, third token `list` or `view`); reject all other subcommands.
- **Option B — Dedicated tool:** Add a small tool (e.g. `gh_pr_read`) with parameters such as `action: "list" | "view"` and for `view` an optional `number` or `branch`. Implementation allowlists only these two operations, maps them to read-only / network-impacting intent, then runs `gh pr list` or `gh pr view <number>` via the existing exec sandbox with `cwd` at workspace root. No token parameter.

Recommendation: Option B gives a clear allowlist and audit trail; Option A is acceptable if exec is extended with a strict subcommand allowlist for `gh` (only `pr list`, `pr view`).

### Step 2: Restrict to read-only subcommands

- Allowed: **`gh pr list`** (with flags such as `--state open`, `--limit N` if desired).
- Allowed: **`gh pr view`** with a PR number or branch (e.g. `gh pr view 123` or `gh pr view --web` only if you want; prefer non-web for agent consumption).
- **Not allowed:** `pr create`, `pr merge`, `pr checkout`, `repo clone`, `workflow run`, or any other `gh` subcommand. Reject with a clear error if the agent requests them.

### Step 3: Repo scope (optional but recommended)

- Run `gh` with `cwd` set to the workspace root (so it uses the repo for the current workspace).
- Optionally support a config like `tools.gh.repoScope: "owner/repo"` and pass `--repo owner/repo` to every `gh` call so the agent cannot target other repositories. Document in config reference.

### Step 4: Intent and approval

- Treat both `pr list` and `pr view` as **read-only** but **network-impacting**. They should require the same capability as other network read operations (e.g. `process.exec` + `net.fetch` if using existing capability model) and **not** require mutating approval. See `docs/GH-CLI-SECURE-IMPLEMENTATION.md` for capability mapping.

### Step 5: Registration and config

- If using a dedicated tool: add config (e.g. `tools.gh.enabled: boolean`, optional `tools.gh.repoScope`). Register the tool only when `tools.gh.enabled` is true.
- If using exec: add `gh` to `allowBins` and (if applicable) `STRICT_EXEC_BINS`; ensure subcommand filter is in place so only `pr list` and `pr view` are allowed.

### Step 6: Operator documentation

- Add a short section (e.g. in `docs/configuration-reference.md` or operator README) that explains:
  - Read-only GitHub integration is limited to `gh pr list` and `gh pr view`.
  - Operator must authenticate via `gh auth login` on the host or set `GH_TOKEN` (or `GITHUB_TOKEN`) in the environment; no token in config or tool args.
  - Optional: how to create a minimal-scope fine-grained PAT for the repo.

### Step 7: Tests

- Unit tests: allowlist allows `pr list` and `pr view` and rejects `pr create`, `pr merge`, and other subcommands.
- Integration test (optional, can be manual): with auth configured, run `gh pr list` and `gh pr view <n>` and assert output is returned (or that a clear error is returned when not authenticated).

---

## 4. Out of scope for GH.1

- **No** `gh pr create`, `gh pr merge`, or any mutating GitHub operations.
- **No** `gh repo clone`, `gh workflow run`, or other high-impact commands.
- **No** code review posting or CI integration in this guide; those belong to later phases (see `docs/GITHUB-CAPABILITY-ANALYSIS.md`).

---

## 5. References

- `docs/GH-CLI-SECURE-IMPLEMENTATION.md` — Full secure gh design (Option A/B), intent, capabilities, auth.
- `docs/GITHUB-CAPABILITY-ANALYSIS.md` — Current state, phases, and roadmap.
- `src/security.ts` — Token redaction for GitHub tokens.
- `src/tools.ts` — Exec tool, `classifyCommandIntent`, approval gate.
