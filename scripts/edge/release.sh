#!/usr/bin/env bash
#
# Tag the current origin/edge/main as a Paseo Edge release and push the tag, which is
# what starts .github/workflows/edge-linux-release.yml.
#
# Versions are Paseo Edge's own plain-semver line, unrelated to upstream's numbers:
# electron-updater compares them within our feed only, and a plain X.Y.Z (no
# prerelease suffix) is what the updater's latest/allowPrerelease=false settings
# expect. Which upstream commit a build is based on goes in the release notes.
#
# Usage: scripts/edge/release.sh [X.Y.Z]   (default: bump the patch of the latest tag)

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

git fetch --quiet --prune --tags origin

latest="$(git tag --list 'edge-v*' --sort=-v:refname | head -n1)"

version="${1:-}"
if [[ -z "$version" ]]; then
  if [[ -z "$latest" ]]; then
    version="1.0.0"
  else
    IFS=. read -r major minor patch <<<"${latest#edge-v}"
    version="$major.$minor.$((patch + 1))"
  fi
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: expected a plain semver version like 1.0.0, got '$version'." >&2
  exit 1
fi

tag="edge-v$version"

if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  echo "error: tag $tag already exists." >&2
  exit 1
fi

if ! git rev-parse --quiet --verify origin/edge/main >/dev/null; then
  echo "error: origin/edge/main does not exist. Run scripts/edge/rebuild.sh first." >&2
  exit 1
fi

target="$(git rev-parse origin/edge/main)"
base_count="$(git log --first-parent --format=%s "$target" | grep -c '^edge: merge ' || echo 0)"
base="$(git rev-parse --short "$target~$base_count")"

echo "Tagging $tag"
echo "  commit        $(git rev-parse --short "$target") (origin/edge/main)"
echo "  upstream base $base"
git log --first-parent --format=%s "$target" | grep '^edge: merge ' | sed 's/^edge: merge /  + /' || true
echo
read -r -p "Push $tag and publish a release? [y/N] " reply
[[ "$reply" == [yY] ]] || { echo "aborted"; exit 1; }

git tag -a "$tag" "$target" -m "Paseo Edge $version"
git push origin "$tag"

echo
echo "Pushed $tag. Watch the build with:"
echo "  gh run watch -R josham/paseo \$(gh run list -R josham/paseo -w 'Edge Linux Release' -L1 --json databaseId -q '.[0].databaseId')"
