#!/usr/bin/env bash
# After a branch is merged (locally or via PR), run this to stay on main, pull latest,
# and remove local and remote-tracking refs for merged branches so ROADMAP progress
# doesn't get confused by stale branch names.
# Usage: ./scripts/after-merge.sh   or   bash scripts/after-merge.sh

set -e
MAIN=main

cd "$(git rev-parse --show-toplevel)" || { echo "Not in a git repository."; exit 1; }

CURRENT=$(git rev-parse --abbrev-ref HEAD)

# Checkout main and pull
if [ "$CURRENT" != "$MAIN" ]; then
  echo "Checking out $MAIN..."
  git checkout "$MAIN"
fi
echo "Pulling latest from origin/$MAIN..."
git pull origin "$MAIN"

# Delete local branches that are merged into main
DELETED=0
while IFS= read -r line; do
  b=$(echo "$line" | sed 's/^[* ]*//')
  [ -z "$b" ] || [ "$b" = "$MAIN" ] && continue
  echo "Deleting merged local branch: $b"
  if git branch -d "$b" 2>/dev/null; then
    DELETED=$((DELETED + 1))
  fi
done < <(git branch --merged "$MAIN")
[ "$DELETED" -gt 0 ] && echo "Removed $DELETED local merged branch(es)."

# Prune remote-tracking refs
echo "Pruning remote-tracking refs..."
git remote prune origin
echo "Done. You are on $MAIN with latest and cleaned refs."
