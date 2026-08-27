#!/usr/bin/env bash
#
# Regenerate edge/main = upstream/main + edge/tooling + every branch in branches.txt.
#
# edge/main is generated, not maintained: it is rebuilt from upstream/main and
# force-pushed on every run. That is what makes retiring a branch free — delete its
# line from branches.txt and the next rebuild simply does not contain it, with no
# revert commit and no conflict archaeology.
#
# Usage: scripts/edge/rebuild.sh [--dry-run]

set -euo pipefail

MANIFEST_REF="${EDGE_MANIFEST_REF:-origin/edge/tooling}"
MANIFEST_PATH="scripts/edge/branches.txt"
TARGET_BRANCH="edge/main"

dry_run=false
case "${1:-}" in
  --dry-run) dry_run=true ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

cd "$(git rev-parse --show-toplevel)"

# Untracked files are fine (they survive a checkout); modified tracked files are not.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "error: working tree has uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

start_ref="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
restore() { git checkout --quiet "$start_ref"; }

echo "==> fetching"
git fetch --quiet upstream --tags
git fetch --quiet --prune origin

# The manifest is read from the pushed tooling branch rather than the working tree:
# this script runs from whatever branch you are on, and edge/tooling is itself one of
# the things being merged.
manifest="$(git show "$MANIFEST_REF:$MANIFEST_PATH")"
mapfile -t branches < <(printf '%s\n' "$manifest" | sed 's/#.*//' | tr -d '[:blank:]' | grep -v '^$' || true)

base_sha="$(git rev-parse --short upstream/main)"
echo "==> base upstream/main $base_sha"

git checkout --quiet -B "$TARGET_BRANCH" upstream/main

merged=()
skipped=()

merge_branch() {
  local branch="$1"
  local ref="origin/$branch"

  if ! git rev-parse --quiet --verify "$ref^{commit}" >/dev/null; then
    echo "error: $ref does not exist — push the branch, or remove it from $MANIFEST_PATH." >&2
    restore
    exit 1
  fi

  # Re-merging a branch upstream already has can resurrect work upstream later changed.
  if git merge-base --is-ancestor "$ref" upstream/main; then
    echo "    skip  $branch (already in upstream/main — drop it from $MANIFEST_PATH)"
    skipped+=("$branch")
    return
  fi

  if ! git merge --no-ff --no-edit -m "edge: merge $branch" "$ref"; then
    echo >&2
    echo "error: merging $branch conflicted:" >&2
    git --no-pager diff --name-only --diff-filter=U | sed 's/^/    /' >&2
    echo >&2
    echo "Resolve, 'git commit', then re-run this script. rerere replays the resolution," >&2
    echo "so each recurring conflict costs you one fix, not one per rebuild." >&2
    exit 1
  fi
  echo "    merge $branch"
  merged+=("$branch")
}

echo "==> merging"
merge_branch "edge/tooling"
for branch in "${branches[@]}"; do
  [[ "$branch" == "edge/tooling" ]] && continue
  merge_branch "$branch"
done

echo
echo "==> $TARGET_BRANCH = upstream/main $base_sha + ${#merged[@]} branch(es)"
for branch in "${merged[@]}"; do echo "    + $branch"; done
for branch in "${skipped[@]}"; do echo "    ~ $branch (skipped)"; done

if [[ "$dry_run" == true ]]; then
  echo
  echo "dry run: not pushing. Local $TARGET_BRANCH is left at the rebuilt commit."
  exit 0
fi

echo
git push --force-with-lease origin "$TARGET_BRANCH"
restore
echo "==> pushed origin/$TARGET_BRANCH; back on $start_ref"
echo "    release it with: scripts/edge/release.sh"
