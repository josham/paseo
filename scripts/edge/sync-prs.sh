#!/usr/bin/env bash
#
# Check that every branch in branches.txt has an open draft PR on the fork, and keep
# edge/base — the branch those PRs point at — level with upstream/main.
#
# The PRs are a reading surface, not a merge queue. One open draft per carried branch
# is how you see what this fork adds without checking out a single branch: a rendered
# diff, a written description, and somewhere to leave a comment. Nothing is ever merged
# through them; a change reaches a build only by its line in branches.txt.
#
# Two rules make that safe, and this script enforces both:
#
#   - The base is edge/base, a throwaway mirror of upstream/main that nothing builds
#     from. It is not `main`: pointing a merge button at the mirror the whole rebase
#     flow depends on is how the first attempt at this (josham/paseo#1) had to be
#     abandoned. It also keeps upstream's inherited ci.yml quiet, since that fires on
#     `pull_request: branches: [main]` and nothing else.
#   - Every PR stays a draft. A draft has no merge button at all, so the misclick is
#     not merely harmless, it is unavailable.
#
# A branch stacked on another carried branch is based on that branch instead, so its
# diff shows its own change rather than everything underneath it. Which branch that is
# gets worked out here rather than recorded anywhere: it is the nearest carried branch
# that is an ancestor of it, which cannot drift the way an annotation would.
#
# PR numbers are likewise never written down — they are looked up by head branch, so
# the manifest stays the one place a branch is declared.
#
# A branch with an open PR *upstream* is exempt: that PR is already the review surface,
# and two for one change is one too many. This is derived the same way, by asking
# upstream for our open PRs, so the exemption lapses by itself the day upstream closes
# or merges one.
#
# Usage: scripts/edge/sync-prs.sh [--check] [--no-push]
#
#   --check     exit non-zero if anything is missing or misfiled (for CI or a hook)
#   --no-push   report only; do not move edge/base

set -euo pipefail

MANIFEST_REF="${EDGE_MANIFEST_REF:-origin/edge/tooling}"
MANIFEST_PATH="scripts/edge/branches.txt"
BASE_BRANCH="edge/base"
REPO="${EDGE_FORK_REPO:-josham/paseo}"
UPSTREAM_REPO="${EDGE_UPSTREAM_REPO:-getpaseo/paseo}"

check=false
push=true
for arg in "$@"; do
  case "$arg" in
    --check) check=true ;;
    --no-push) push=false ;;
    *) echo "usage: $0 [--check] [--no-push]" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "error: gh is not installed." >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

echo "==> fetching"
git fetch --quiet upstream
git fetch --quiet --prune origin

# edge/base is disposable by design, so it is force-pushed rather than fast-forwarded:
# that is what makes an accidental merge into it a non-event instead of a repair job.
# The lease still guards against someone else's push landing since the fetch above.
upstream_sha="$(git rev-parse upstream/main)"
if [[ "$(git rev-parse --quiet --verify "origin/$BASE_BRANCH" || true)" == "$upstream_sha" ]]; then
  echo "==> $BASE_BRANCH already at upstream/main $(git rev-parse --short upstream/main)"
elif [[ "$push" == true ]]; then
  echo "==> moving $BASE_BRANCH to upstream/main $(git rev-parse --short upstream/main)"
  git push --force-with-lease --quiet origin "$upstream_sha:refs/heads/$BASE_BRANCH"
else
  echo "==> $BASE_BRANCH is behind upstream/main (--no-push, left alone)"
fi

manifest="$(git show "$MANIFEST_REF:$MANIFEST_PATH")"
mapfile -t carried < <(printf '%s\n' "$manifest" | sed 's/#.*//' | tr -d '[:blank:]' | grep -v '^$' || true)
carried=("edge/tooling" "${carried[@]}")

# The base of a stacked branch: the nearest carried branch that is an ancestor of it.
# "Nearest" is the candidate that every other candidate is an ancestor of.
expected_base() {
  local branch="$1" best="" cand
  for cand in "${carried[@]}"; do
    [[ "$cand" == "$branch" ]] && continue
    git rev-parse --quiet --verify "origin/$cand^{commit}" >/dev/null || continue
    git merge-base --is-ancestor "origin/$cand" "origin/$branch" || continue
    if [[ -z "$best" ]] || git merge-base --is-ancestor "origin/$best" "origin/$cand"; then
      best="$cand"
    fi
  done
  printf '%s\n' "${best:-$BASE_BRANCH}"
}

# One call, not one per branch: the fork's open PRs are few and the API is not.
prs="$(gh pr list -R "$REPO" --state open --limit 200 \
  --json number,headRefName,baseRefName,isDraft)"

# Only our own PRs can have one of this fork's branches as their head, so --author
# keeps this to a handful of rows instead of every open PR upstream.
upstream_prs="$(gh pr list -R "$UPSTREAM_REPO" --state open --limit 200 --author "@me" \
  --json number,headRefName)"

problems=0
echo
printf '    %-52s %-6s %s\n' "BRANCH" "PR" "BASE"
for branch in "${carried[@]}"; do
  if ! git rev-parse --quiet --verify "origin/$branch^{commit}" >/dev/null; then
    printf '    %-52s %-6s %s\n' "$branch" "-" "branch missing on origin"
    problems=$((problems + 1))
    continue
  fi

  want_base="$(expected_base "$branch")"
  pr="$(jq -r --arg b "$branch" 'map(select(.headRefName == $b)) | first // empty' <<<"$prs")"
  up="$(jq -r --arg b "$branch" 'map(select(.headRefName == $b)) | first // empty | .number // empty' \
    <<<"$upstream_prs")"

  if [[ -n "$up" && -z "$pr" ]]; then
    printf '    %-52s %-6s %s\n' "$branch" "-" "exempt: $UPSTREAM_REPO#$up is open"
    continue
  fi

  if [[ -n "$up" && -n "$pr" ]]; then
    printf '    %-52s %-6s %s\n' "$branch" "#$(jq -r .number <<<"$pr")" \
      "$UPSTREAM_REPO#$up is open — close this one, one surface per change"
    problems=$((problems + 1))
    continue
  fi

  if [[ -z "$pr" ]]; then
    printf '    %-52s %-6s %s\n' "$branch" "none" "open one against $want_base"
    echo "        gh pr create -R $REPO --draft --base $want_base --head $branch \\"
    echo "          --title '...' --body-file ..."
    problems=$((problems + 1))
    continue
  fi

  num="$(jq -r .number <<<"$pr")"
  have_base="$(jq -r .baseRefName <<<"$pr")"
  draft="$(jq -r .isDraft <<<"$pr")"

  note=""
  if [[ "$have_base" != "$want_base" ]]; then
    note="base is $have_base, want $want_base — gh pr edit $num -R $REPO --base $want_base"
    problems=$((problems + 1))
  fi
  if [[ "$draft" != "true" ]]; then
    note="${note:+$note; }not a draft — gh pr ready $num -R $REPO --undo"
    problems=$((problems + 1))
  fi
  printf '    %-52s %-6s %s\n' "$branch" "#$num" "${note:-$have_base}"
done

# A PR left open for a branch that is no longer carried says the fork ships something
# it does not. Retiring a branch is one deleted line in branches.txt; this is the other
# half of that edit.
stale="$(jq -r --argjson carried "$(printf '%s\n' "${carried[@]}" | jq -R . | jq -s .)" \
  'map(select(.headRefName as $h | ($carried | index($h)) | not)) | .[] | "#\(.number) \(.headRefName)"' \
  <<<"$prs")"
if [[ -n "$stale" ]]; then
  echo
  echo "    open PRs for branches not in $MANIFEST_PATH — close them, or add the line:"
  sed 's/^/        /' <<<"$stale"
  problems=$((problems + 1))
fi

echo
if (( problems )); then
  echo "==> $problems thing(s) to fix"
  [[ "$check" == true ]] && exit 1
else
  echo "==> every carried branch has an open draft PR"
fi
