#!/usr/bin/env bash
#
# Write the release notes for an edge-v* tag to stdout.
#
# Both release workflows call this, and both create the GitHub release if it is not
# there yet: they run from the same tag push and either may get there first. Sharing
# one generator is what keeps the notes from depending on which won — before this,
# whichever job created the release wrote its own version of them.
#
# Usage: scripts/edge/release-notes.sh <edge-vX.Y.Z>
#
# Run from the repo root with the tag checked out: the branch list comes from HEAD's
# own first-parent history, so the notes describe the commit being built rather than
# whatever branches.txt says today.

set -euo pipefail

tag="${1:-}"
[[ -n "$tag" ]] || { echo "Usage: $0 <edge-vX.Y.Z>" >&2; exit 2; }

version="${tag#edge-v}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Expected a tag like edge-v1.2.3, got '$tag'" >&2
    exit 2
fi

# rebuild.sh layers each merge onto the first-parent chain, so the run of fork commits at
# the tip is our stack and what precedes it is the upstream commit this build is based on.
# Count every leading "edge: " subject, not only the merges: a tag cut by folding tooling
# into edge/main by hand carries one more commit on top, and counting merges alone would
# name one of our own merges as the upstream base.
# Fed from a variable rather than a pipe: awk exits at the first upstream subject, git
# then dies on SIGPIPE, and under `set -o pipefail` that failure would kill this script.
subjects="$(git log --first-parent --format=%s HEAD)"
ours="$(awk '/^edge: /{n++; next} {exit} END{print n+0}' <<<"$subjects")"
base="$(git rev-parse --short "HEAD~${ours}")"

echo "Linux, Windows and Android builds of Paseo Edge — a modified build of Paseo maintained at"
echo "[josham/paseo](https://github.com/josham/paseo). Not affiliated with or endorsed by getpaseo."
echo
echo "Based on upstream \`getpaseo/paseo@$base\`, plus:"
echo

# branches.txt is the manifest, so its trailing `# ...` comment is the one description
# of each branch. Reading it here keeps the notes from drifting.
git log --first-parent --format='%s' HEAD |
    grep '^edge: merge ' |
    sed 's/^edge: merge //' |
    while read -r branch; do
        # Split on the first # only: descriptions carry their own (PR #1234).
        desc="$(awk -v b="$branch" '
            { i = index($0, "#")
              key = (i ? substr($0, 1, i - 1) : $0); gsub(/[ \t]/, "", key)
              if (key == b && i) { d = substr($0, i + 1); sub(/^[ \t]*/, "", d); print d; exit } }
        ' scripts/edge/branches.txt)"
        if [ -n "$desc" ]; then echo "- $desc — \`$branch\`"; else echo "- \`$branch\`"; fi
    done

echo
echo "**Linux** — \`Paseo-Edge-x86_64.AppImage\` installs alongside a stock Paseo (separate app id"
echo "and desktop entry) and updates itself from this repo's releases."
echo "\`paseo-edge-daemon-$version.tar.gz\` is the daemon built from the same commit; install it"
echo "with \`scripts/edge/install-daemon.sh\` or the branches' server halves are missing without an error."
echo
echo "**Windows** — \`Paseo-Edge-Setup-$version-x64.exe\` (and an \`-arm64\` build) installs alongside"
echo "a stock Paseo under its own app id, and updates itself from this repo's releases. The"
echo "installer is unsigned, so SmartScreen will warn on first run — the same as upstream's."
echo "It carries its own daemon, so unlike the Linux build there is nothing else to install."
echo
echo "**Android** — \`paseo-edge-android-arm64.apk\` is a sideload for arm64 devices, signed with"
echo "the Edge key. It installs alongside a stock Paseo (\`sh.paseo.edge\`) and does not update"
echo "itself; [releases/latest/download/paseo-edge-android-arm64.apk][apk] is always the newest"
echo "one. It is a client only: pair it with an Edge daemon for the server-side branches."
echo
echo "[apk]: https://github.com/josham/paseo/releases/latest/download/paseo-edge-android-arm64.apk"
