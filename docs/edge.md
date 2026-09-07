# Paseo Edge

Paseo Edge is this fork's own Linux desktop build: upstream `getpaseo/paseo` plus the
branches we have in flight, packaged as an AppImage you can install and that updates
itself. It exists so we can run our own changes without waiting for upstream review.

Everything here lives in files upstream does not have. Nothing under `packages/` is
modified, and the app's identity and update feed are set with `electron-builder -c`
flags at build time. That is deliberate: a fork that edits upstream files pays for it on
every rebase, forever.

## What's in a build

Every branch a build carries is listed in [`scripts/edge/branches.txt`](../scripts/edge/branches.txt),
one per line, each with a trailing `#` comment saying what it is:

```
pr/2453-devcontainer  # Run agents and terminals inside a dev container (upstream PR #2453, bendavid)
```

That file is the manifest `rebuild.sh` merges from, so it cannot drift from what shipped.
`rebuild.sh` strips the comments when it parses; the release workflow reads them back to
write the "plus:" list in each release's notes. Adding a branch means adding its line and
its one-line description — nothing else to update.

For a specific build, the [release notes](https://github.com/josham/paseo/releases) name
the upstream commit it is based on and list every branch on top of it.

To see what a build actually contains rather than what was intended:

```bash
git log --first-parent --format=%s edge-v1.1.0 | grep '^edge: merge '
```

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

Then add `bd/my-change` to `scripts/edge/branches.txt` on `edge/tooling`, with a trailing
`#` comment describing it — that comment is what the release notes show, so write it for
someone reading the releases page:

```
bd/my-change  # What it does (upstream PR #1234)
```

Push that, and rebuild:

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

On Arch the `.deb` target fails with `libcrypt.so.1: cannot open shared object file` —
electron-builder's bundled fpm is built against an older glibc. Install
`libxcrypt-compat`, or ignore it: the AppImage and tar.gz are produced before fpm runs,
and CI builds on ubuntu where the library is present.

The release builds AppImage, deb, rpm and tar.gz. `rpmbuild` rejects a Name tag
containing a space, which failed the first 1.0.0 build, so deb and rpm take
`packageName=paseo-edge` while `productName` keeps the space for display.

## Installing

Download `Paseo-Edge-x86_64.AppImage`, `chmod +x`, run it. It installs alongside a stock
Paseo — different app id (`sh.paseo.desktop.edge`), different desktop entry, different
deb package name — and updates itself from this repo's releases.

What it shares with a stock Paseo, deliberately: `~/.paseo` (so it sees your real
projects and agents) and `~/.config/Paseo` (Electron settings and window state, because
`packages/desktop/src/main.ts` hardcodes the app name via `app.setName`).

The shared userData means a shared single-instance lock. Launching Edge while stock
Paseo is running does not open an Edge window — it focuses the running stock Paseo and
exits, which looks like the AppImage did nothing. Quit the stock app first, or use the
launcher below to run both.

## Running Edge beside a stock Paseo

From a checkout:

```bash
scripts/edge/install-launcher.sh [/path/to/Paseo-Edge-x86_64.AppImage]
```

Without one — this is the path if someone sent you a link rather than a clone. Download
it, read it, then run it; it writes to `~/.local`, so it is worth the ten seconds:

```bash
curl -fsSLO https://raw.githubusercontent.com/josham/paseo/edge/tooling/scripts/edge/install-launcher.sh
less install-launcher.sh
bash install-launcher.sh ~/Applications/Paseo-Edge-x86_64.AppImage
```

Outside a checkout there is no repo to take the icon from, so it fetches that from the
fork instead. Nothing else differs.

This installs `~/.local/bin/paseo-edge`, a "Paseo Edge" desktop entry, and a
`paseo-edge` icon in the hicolor theme taken from `packages/desktop/assets/icon-dev.png`
— the blue blueprint mark upstream uses for unpackaged runs, so Edge and a stock Paseo
are told apart in a launcher without editing an image. The launcher
points Edge at its own Electron profile through `PASEO_ELECTRON_USER_DATA_DIR`, which
`packages/desktop/src/main.ts` honours in packaged builds and applies before
`requestSingleInstanceLock()`, so the two apps no longer share a lock.

It seeds that profile once with `manageBuiltInDaemon: false`. A fresh profile would
otherwise take the default of `true` and start a second daemon over the same
`~/.paseo` while one is already running. Edge is a second client on the existing
daemon, so it sees your real projects and agents.

Edge starts with no pairing, workspace or appearance state: those live in the
profile's `Local Storage` and `IndexedDB`, and copying them out from under a running
stock Paseo would risk corrupting live LevelDB stores.

## Versions

Edge has its own version line starting at `1.0.0`, unrelated to upstream's numbers.
electron-updater only ever compares it against our own releases, and a plain `X.Y.Z`
with no prerelease suffix is what its `channel=latest`, `allowPrerelease=false`
configuration expects. Which upstream commit a build came from is in the release notes.

## What the CI does and does not run

Pushing a branch here runs nothing: upstream's `ci.yml` only triggers on `main` and on
PRs into it, and our `edge-v*` tags match none of upstream's tag triggers. This does not
affect PRs sent upstream — those run in getpaseo's repo, against getpaseo's CI.

Upstream's workflow files are present on `main` but GitHub has never registered them in
this fork — `gh api repos/josham/paseo/actions/workflows` lists only
`edge-linux-release.yml`. Publishing `edge-v1.0.0` did not fire `deploy-website.yml`
despite its `release: published` trigger. If one ever does wake up, disable it:

```bash
gh api -X PUT repos/josham/paseo/actions/workflows/deploy-website.yml/disable
```

That endpoint 404s on a workflow GitHub has not registered, so it only works after the
workflow has run at least once.

Only Linux x64 is built. Windows would be one more job and needs no secrets; macOS needs
an Apple Developer certificate to produce something users can open without fighting
Gatekeeper.

## Licensing

Upstream is Apache-2.0 as of `a8734a972`. Redistributing modified builds is fine:
keep `LICENSE` and any `NOTICE` intact, and say the build is modified — the release notes
do that, and the source for any build is its `edge-v*` tag. Note that Apache-2.0 does not
grant trademark rights, so "Paseo Edge" is a name for builds we share between ourselves,
not one to put in front of the public.
