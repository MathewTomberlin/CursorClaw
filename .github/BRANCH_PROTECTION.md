# Branch Protection and Repo Rules (Operator Guide)

This repo should be configured on **GitHub** so that the default branch (`main`) cannot be damaged in an unrecoverable way—by humans or by an AI agent with write access.

Configure in **GitHub → Settings → General → Branch protection** (and optionally **Rules → Rulesets**). This file documents the **recommended** settings; it does not apply them automatically.

## Recommended for `main`

| Setting | Value | Why |
|--------|--------|-----|
| Require a pull request before merging | On (min 1) | No direct push to main; all changes go through a PR. |
| Require status checks to pass | On: `test-build`, `security` | CI must pass (see `.github/workflows/ci.yml`). |
| Require branch to be up to date | On | Avoid merging stale code. |
| Allow force pushes | **Never** | Prevents history rewrite on main. |
| Allow deletion | **Never** for main | Prevents deleting the default branch. |
| Bypass list | None (or only release managers) | So the agent cannot bypass even with write access. |

## What the agent must not do

Even with approval and a GitHub token, the agent should **not**:

- Force-push to any branch.
- Delete the default or protected branches.
- Change branch protection or repository settings.
- Delete or transfer the repository.

Token scope should be minimal (e.g. Contents, Pull requests, Statuses — not Administration).

## After a branch is merged

When a branch is merged into `main` (via PR or locally), keep the repo and ROADMAP workflow clear:

1. **On GitHub:** The workflow `.github/workflows/merge-cleanup.yml` runs when a PR is merged into `main` and deletes the merged branch on the remote. That avoids clutter and confusion about which branch is “current.”
2. **Locally:** Run the after-merge script so your clone is on `main`, up to date, and free of stale refs:
   - **Windows:** `.\scripts\after-merge.ps1` or `npm run after-merge`
   - **Unix/macOS:** `./scripts/after-merge.sh` or `npm run after-merge`

The script checks out `main`, pulls latest, deletes local branches that are already merged into `main`, and prunes remote-tracking refs. That way you (and any agent using this repo) don’t keep working from or referring to a merged branch name when progressing the ROADMAP.

## More detail

See **docs/GITHUB-CAPABILITY-ANALYSIS.md** for full analysis, current gaps, and implementation roadmap.
