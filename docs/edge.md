# Paseo Edge

Paseo Edge is this fork's own Linux desktop build: upstream `getpaseo/paseo` plus the
branches we have in flight, packaged as an AppImage you can install and that updates
itself. It exists so we can run our own changes without waiting for upstream review.

Everything here lives in files upstream does not have. Nothing under `packages/` is
modified, and the app's identity and update feed are set with `electron-builder -c`
flags at build time. That is deliberate: a fork that edits upstream files pays for it on
every rebase, forever.

## Branches

| Branch                    | What it is                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `main`                    | A mirror of `upstream/main`. Never commit to it.                                                                       |
| `feat/*`, `fix/*`, `bd/*` | Ordinary work, cut from `upstream/main`. These are the branches that become upstream PRs.                              |
| `edge/tooling`            | This doc, `scripts/edge/`, and `.github/workflows/edge-linux-release.yml`. The only branch the fork owns.              |
| `edge/main`               | Generated. Force-pushed by `scripts/edge/rebuild.sh` on every run. Do not commit to it and do not open PRs against it. |

`edge/main` is rebuilt from scratch rather than maintained, which is what makes retiring
a branch free: when its PR lands upstream, delete its line from
`scripts/edge/branches.txt` and the next rebuild simply does not contain it.

Review still happens on the feature branches — the same ones that go upstream — not on
`edge/main`.

## Adding a change to the build

```bash
git fetch upstream
git checkout -b bd/my-change upstream/main    # always cut from upstream/main
# ... work, commit ...
git push -u origin bd/my-change
```

Then add `bd/my-change` to `scripts/edge/branches.txt` on `edge/tooling`, push that, and
rebuild:

```bash
scripts/edge/rebuild.sh            # --dry-run to build it locally without pushing
scripts/edge/release.sh            # bumps the patch, tags edge-vX.Y.Z, pushes
```

The tag starts the build. It takes roughly 20 minutes, after which the AppImage is on
the [releases page](https://github.com/josham/paseo/releases).

If two of our branches conflict, `rebuild.sh` stops and leaves the conflict in the tree.
Resolve it, `git commit`, and re-run. `git config rerere.enabled true` (do this once)
makes git replay that resolution on later rebuilds, so a recurring conflict costs one
fix rather than one per release — `rebuild.sh` stages what rerere replays and carries
on, so the second rebuild of the same stack is unattended.

`feat/configurable-content-width` and `fix/numeric-settings-clamp-resync` are the
standing example: one extracts `FontSizeRow` into its own module, the other renames it
in place to `PixelSizeRow`. The recorded resolution imports the extracted component
under the feature's name and gives `commitContentWidth` the same "return the clamped
value" contract as the font-size commits. It goes away when either PR lands upstream.

## Building locally

To check a build without cutting a release:

```bash
npm run build:desktop -- --publish never --linux --x64 \
  -c.appId=sh.paseo.desktop.edge -c.productName="Paseo Edge" \
  -c.appImage.artifactName='Paseo-Edge-${arch}.${ext}' \
  -c.publish.owner=josham -c.publish.repo=paseo
```

On Arch the `.deb` and `.rpm` targets fail with `libcrypt.so.1: cannot open shared
object file` — electron-builder's bundled fpm is built against an older glibc. Install
`libxcrypt-compat`, or ignore it: the AppImage and tar.gz are produced before fpm runs,
and CI builds on ubuntu where the library is present.

## Installing

Download `Paseo-Edge-x86_64.AppImage`, `chmod +x`, run it. It installs alongside a stock
Paseo — different app id (`sh.paseo.desktop.edge`), different desktop entry, different
deb/rpm package name — and updates itself from this repo's releases.

What it shares with a stock Paseo, deliberately: `~/.paseo` (so it sees your real
projects and agents) and `~/.config/Paseo` (Electron settings and window state, because
`packages/desktop/src/main.ts` hardcodes the app name). The shared single-instance lock
means you cannot run both at once, which is the behaviour you want — they would
otherwise fight over the same daemon.

## Versions

Edge has its own version line starting at `1.0.0`, unrelated to upstream's numbers.
electron-updater only ever compares it against our own releases, and a plain `X.Y.Z`
with no prerelease suffix is what its `channel=latest`, `allowPrerelease=false`
configuration expects. Which upstream commit a build came from is in the release notes.

## What the CI does and does not run

Upstream's workflows are disabled in this fork, so pushing branches here runs nothing
except `Edge Linux Release` on an `edge-v*` tag. This does not affect PRs sent upstream:
those run in getpaseo's repo, against getpaseo's CI.

Only Linux x64 is built. Windows would be one more job and needs no secrets; macOS needs
an Apple Developer certificate to produce something users can open without fighting
Gatekeeper.

## Licensing

Upstream is Apache-2.0 as of `a8734a972`. Redistributing modified builds is fine:
keep `LICENSE` and any `NOTICE` intact, and say the build is modified — the release notes
do that, and the source for any build is its `edge-v*` tag. Note that Apache-2.0 does not
grant trademark rights, so "Paseo Edge" is a name for builds we share between ourselves,
not one to put in front of the public.
