# After a branch is merged (locally or via PR), run this to stay on main, pull latest,
# and remove local and remote-tracking refs for merged branches so ROADMAP progress
# doesn't get confused by stale branch names.
# Usage: .\scripts\after-merge.ps1   or   pwsh -File scripts/after-merge.ps1

$ErrorActionPreference = "Stop"
$main = "main"

# Ensure we're in a git repo
$root = git rev-parse --show-toplevel 2>$null
if (-not $root) {
  Write-Error "Not in a git repository."
  exit 1
}
Set-Location $root

# Current branch
$current = git rev-parse --abbrev-ref HEAD

# Checkout main and pull
if ($current -ne $main) {
  Write-Host "Checking out $main..."
  git checkout $main
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host "Pulling latest from origin/$main..."
git pull origin $main
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Delete local branches that are merged into main (avoid deleting main itself)
$merged = git branch --merged $main
$deleted = 0
foreach ($line in $merged) {
  $b = $line.Trim().TrimStart("* ")
  if ($b -and $b -ne $main) {
    Write-Host "Deleting merged local branch: $b"
    git branch -d $b
    if ($LASTEXITCODE -eq 0) { $deleted++ }
  }
}
if ($deleted -gt 0) {
  Write-Host "Removed $deleted local merged branch(es)."
}

# Prune remote-tracking refs so we don't keep origin/feature-xyz after remote was deleted
Write-Host "Pruning remote-tracking refs..."
git remote prune origin
Write-Host "Done. You are on $main with latest and cleaned refs."
