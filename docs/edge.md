# Paseo Edge

Paseo Edge is this fork's own build: upstream `getpaseo/paseo` plus the branches we have
in flight, packaged for Linux (an AppImage), Windows (an installer) and Android (a
sideload APK). The desktop builds update themselves. It exists so we can run our own
changes without waiting for upstream review.

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
`rebuild.sh` strips the comments when it parses; `scripts/edge/release-notes.sh` reads them
back to write the "plus:" list in each release's notes. Adding a branch means adding its line and
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
| `edge/base`               | Disposable. Force-pushed to `upstream/main` by `scripts/edge/sync-prs.sh`, and used only as a base for the fork's PRs. |
| `feat/*`, `fix/*`, `bd/*` | Ordinary work, cut from `upstream/main`. These are the branches that become upstream PRs.                              |
| `pr/<number>-<slug>`      | A re-land of someone else's upstream PR, named for it.                                                                 |
| `edge/tooling`            | This doc, `scripts/edge/`, and the two `edge-*-release.yml` workflows. The only branch the fork owns.                  |
| `edge/main`               | Generated. Force-pushed by `scripts/edge/rebuild.sh` on every run. Do not commit to it and do not open PRs against it. |

`edge/main` is rebuilt from scratch rather than maintained, which is what makes retiring
a branch free: when its PR lands upstream, delete its line from
`scripts/edge/branches.txt` and the next rebuild simply does not contain it.

In practice few lines are ever retired. Upstream closes feature PRs and routes them to
Discussions, and every feature in the list has been closed on those grounds — that is
why Edge exists at all. Only fixes tend to land. `branches.txt` marks which is which,
and names an author where the branch re-lands someone else's PR.

Review still happens on the feature branches — the same ones that go upstream — not on
`edge/main`.

## Pull requests

Every carried branch has one open **draft** PR on this fork, and it stays open for as
long as the fork carries the branch. [The list of them](https://github.com/josham/paseo/pulls)
is the readable index of what Edge adds: a rendered diff and a written description per
change, without checking out a branch to find out. It is also most of an upstream PR
already, for the day a change has somewhere upstream to go.

They are a reading surface, not a merge queue. **Nothing is ever merged through them** —
a change reaches a build only by its line in `scripts/edge/branches.txt`. Two rules keep
that from being a trap:

- **The base is `edge/base`**, a throwaway mirror of `upstream/main` that nothing builds
  from. It is deliberately not `main`: the first attempt at this (josham/paseo#1) used
  the mirror as its base and had to be abandoned, because the PR sat there with a live
  merge button pointing at the branch every rebase depends on. Merging into `edge/base`
  costs nothing — the next `sync-prs.sh` force-pushes it back. Basing on anything but
  `main` also keeps upstream's inherited `ci.yml` quiet: it fires on
  `pull_request: branches: [main]`, and a PR into `main` really does start a
  25-minute run here.
- **Every PR is a draft.** A draft has no merge button at all, so the misclick is not
  merely cheap, it is unavailable.

A branch stacked on another carried branch is based on that branch instead, so its diff
shows only its own change: `edge/container-build-progress` is +202 against
`pr/2453-devcontainer` and +11537 against upstream. Nothing records which branch that
is — `sync-prs.sh` works it out as the nearest carried branch that is an ancestor, so it
cannot drift. PR numbers are likewise not written down anywhere; they are looked up by
head branch, leaving `branches.txt` the one place a branch is declared.

```bash
scripts/edge/sync-prs.sh              # move edge/base, report every branch's PR
scripts/edge/sync-prs.sh --check      # exit non-zero if one is missing or misfiled
```

It prints the `gh pr create` line for a branch that has no PR yet, but does not run it:
the body is the point, and an empty one would be worse than no PR. It also flags an open
PR whose branch has left `branches.txt` — retiring a branch is one deleted line there and
one closed PR here.

A branch with an open PR **upstream** gets no PR here — that one is already the review
surface, and two for one change is one too many. `sync-prs.sh` works this out by asking
upstream for our open PRs, so the exemption lapses by itself the day upstream closes or
merges one.

### What goes in the body

**Thin, by default.** Status and gaps: what it is, where it stands upstream, what it is
stacked on, whether it has a server half, and what was never verified. The _rationale_
stays in the commit messages, which are already dense here — every branch is one to three
commits, each a complete description of one change. A body that restates them is a second
copy that goes stale the moment the branch is amended, while the commit stays true.

**Full, for the branches that could still go upstream.** Only fixes have a route —
upstream closes features with a pointer to Discussions — so for a fix with no upstream PR
yet, a complete body is worth writing, because it becomes that PR's description on the day
it is filed. What blocks those is usually not the prose: `CONTRIBUTING.md` wants a
recording or before/after screenshots, and media cannot be attached through `gh`.

The same split decides how much a review is worth. `edge/agent-tool-hardening` changes who
may spawn an unattended agent and which credentials reach a spawned process, and it reaches
a self-updating build without passing through upstream review or CI — the fork's inherited
CI does not run on these branches, by the same design that keeps it quiet. Point
`/code-review <PR#>` at those.

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

Then open its draft PR, so the branch shows up in the index rather than only in the
manifest — `scripts/edge/sync-prs.sh` prints the `gh pr create` line for any branch that
is missing one. See [Pull requests](#pull-requests).

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

The Windows build has no local equivalent here. electron-builder can cross-package it
under wine, but `after-pack.js` runs a packaged smoke test that has to launch the `.exe`,
so a real check needs a Windows host. Use `workflow_dispatch` against an existing tag
instead — see [Windows](#windows).

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

## Running the daemon

Edge carries only the **client** half of each branch. Every server-side call goes to
whatever daemon you are connected to, so a feature whose work happens in the daemon is
invisible — with no error — unless that daemon is an Edge build too. A silently missing
UI control is the signature: check `~/.paseo/daemon.log` for `WS inbound message
validation failed` before suspecting the app.

Each release therefore carries `paseo-edge-daemon-<version>.tar.gz` beside the
AppImage: the seven Paseo packages, packed from the same commit. Install it with

```bash
scripts/edge/install-daemon.sh              # newest release
scripts/edge/install-daemon.sh edge-v1.4.0  # a specific one
```

It installs into `~/.local/share/paseo-edge-daemon` and writes
`~/.local/bin/paseo-edge-daemon`, so a service unit running
`paseo-edge-daemon daemon start --foreground` picks up the new build on its next
restart with no unit edit. The daemon runs as plain Node — no Electron, no browser
process. It needs `node` and `npm` on the machine, and the install pulls third-party
dependencies from the registry, so it is a small artifact plus a network install rather
than a self-contained drop-in.

The bundle is npm tarballs rather than a checkout because `npm pack` is the only thing
that runs each package's `prepack`, and `@getpaseo/server`'s prepack is what builds
`dist/` and the daemon web UI. Installing the repo from git would skip it: npm runs
`prepare` for git dependencies, which none of these packages define, and npm cannot
address a subdirectory of a monorepo.

### Keeping the two halves together

The app updates itself and the daemon does not follow. `autoDownload` is on and there is
no setting to turn updates off, so the AppImage is replaced whenever a release lands
while the installed daemon stays where it was. Nothing catches that drift on its own:
both halves report _upstream's_ version, so the app's version-mismatch check sees a
match between an old daemon and a new client.

```bash
scripts/edge/install-sync.sh --enable
```

That installs a path unit on the AppImage which reinstalls the matching daemon bundle
whenever the app updates itself. It does not restart the daemon — it fires on a file
event with no idea whether an agent is mid-run, and a restart stops every agent the
daemon is hosting. It tells you a restart is outstanding instead; run it when you are
idle:

```bash
systemctl --user restart paseo-daemon
```

## A second install, for testing

The launcher above deliberately shares everything worth sharing: your real projects,
your real agents, the daemon you work through. That is wrong for trying out a build.
`install-test-instance.sh` installs a throwaway Edge that shares none of it.

```bash
scripts/edge/install-test-instance.sh                      # newest release
scripts/edge/install-test-instance.sh edge-v1.6.1          # a specific one
scripts/edge/install-test-instance.sh --appimage ./release/Paseo-Edge-x86_64.AppImage
scripts/edge/install-test-instance.sh --status
scripts/edge/install-test-instance.sh --remove [--purge]
```

Four separations, which together are the whole idea:

|              | test instance                        | the install you work in                     |
| ------------ | ------------------------------------ | ------------------------------------------- |
| app          | `~/.local/share/paseo-edge-test/app` | `~/Applications/Paseo-Edge-x86_64.AppImage` |
| userData     | `~/.config/Paseo-Edge-test`          | `~/.config/Paseo-Edge`                      |
| `PASEO_HOME` | `~/.paseo-edge-test`                 | `~/.paseo`                                  |
| daemon       | `127.0.0.1:6799`, its own            | `0.0.0.0:6767`, systemd                     |

The launcher sets `PASEO_HOME` and `PASEO_ELECTRON_USER_DATA_DIR`, and the app resolves
its daemon through `resolvePaseoHome(process.env)` — so a test instance looks for a
daemon in its own home, finds its own, and has no way to reach yours. Run several at
once with `--name` and `--port`. `--remove` takes the app and profile; the instance's
`PASEO_HOME` survives unless you add `--purge`, because that is where anything you were
testing lives.

The port has to be seeded into the instance's `config.json`, not passed in the
environment: `daemonLaunchEnvironment()` strips every `DAEMON_SETTING_ENV_KEY` —
`PASEO_LISTEN` and `PORT` among them — from a managed launch, so that a desktop app
cannot leak its own environment into the daemon it spawns.

### Which daemon it runs

By default the app runs the daemon it ships with, exactly as a fresh install does: one
commit on both sides, nothing else to install, and it stops when you quit the app. Point
`--daemon` elsewhere when the daemon is what you are testing:

```bash
--daemon edge-v1.6.1                      # that release's bundle, into the instance
--daemon ./paseo-edge-daemon-1.6.1.tar.gz # a bundle you built
--daemon ~/workspace/paseo/paseo          # a built checkout, straight from dist/
```

Any of those seeds the profile with `manageBuiltInDaemon: false` and writes
`<instance>/bin/paseo-edge-<name>-daemon`, a foreground launcher with the instance's home
and port already set. Start it before the app; stop it with Ctrl-C. It is deliberately
not a service — nothing on the machine should depend on a test daemon staying up.

### What the script does that you would otherwise forget

- **Extracts the AppImage** instead of installing it. `electron-updater` only replaces an
  AppImage when `$APPIMAGE` is set, so extracting is what pins the build under test —
  otherwise the instance quietly stops being the version you installed. Measured on 1.8.0:
  the check ends at `APPIMAGE env is not defined` before any network call. The updater
  feed is also repointed at a channel with no asset, whose 404 is the one updater error
  Paseo swallows in silence. Costs ~430 MB per instance. `--keep-updates` opts out.
- **Turns the relay off.** A config that omits `daemon.relay.enabled` gets the opt-in
  default of `true`, so a test daemon otherwise connects to `relay.paseo.sh` on first
  start and appears as another device on your account. `--relay` when that is the point.
- **Leaves the speech models alone.** A fresh `PASEO_HOME` downloads its own copy on
  first daemon start — 985 MB, measured. `--share-models` symlinks the live install's
  instead, which is safe enough to offer and too destructive to assume.
- **Installs no desktop entry** unless you ask with `--desktop-entry`. Every current
  Paseo build reports the same Wayland `app_id` (`getpaseo-desktop`), so a second entry
  claiming that `StartupWMClass` makes it ambiguous which entry a window matches — and
  the cost of that lands on the install you work in, whose windows may take the test
  instance's icon.

## Windows

Every `edge-v*` tag builds Windows installers too, in the same release:
`Paseo-Edge-Setup-<version>-x64.exe` and an `-arm64` build, plus a `.zip` of each for a
no-installer copy. They update themselves from this repo, reading `latest.yml` the same
way the AppImage reads `latest-linux.yml`.

Windows needed nothing from the fork beyond a workflow. `packages/desktop/electron-builder.yml`
already carries a full `win:` block — NSIS and zip, both arches, `assets/icon.ico`, and the
`bin/paseo.cmd` CLI shim — `after-pack.js` prunes win32 natives and runs the packaged smoke
test there, and upstream's `ci.yml` runs the server and desktop test suites on
`windows-latest`. `.github/workflows/edge-windows-release.yml` mirrors upstream's
`publish-windows` job with our identity overrides, exactly as the Linux one does.

Coexisting with a stock Paseo takes one fork-side file. The Start Menu entry and the
uninstall record follow what we override — `productName` and `appId` — and taskbar grouping
follows the AppUserModelID derived from the id. The install **directory** does not.
electron-builder takes it from `productFilename`, which is `executableName` whenever that is
set, and `packages/desktop/electron-builder.yml` pins `executableName: Paseo`. Through
`edge-v1.9.0` that put Edge in `%LOCALAPPDATA%\Programs\Paseo`, the same directory a stock
Paseo uses, holding one `Paseo.exe` and one `Uninstall Paseo.exe` between two uninstall
records: installing either over the other overwrote it, and uninstalling either stranded
what was left.

Overriding `executableName` would fix the directory by renaming the binary, which
`packages/desktop/e2e/packaged-app-smoke.js` and `scripts/after-pack.js` both hardcode as
`Paseo` — a `packages/` edit, which this fork does not make. So
[`scripts/edge/windows-install-dir.nsh`](../scripts/edge/windows-install-dir.nsh) moves the
directory and leaves the binary alone, passed as `-c.nsis.include`. It hooks `customInit`,
which `installer.nsi` inserts after `initMultiUser` has set `$INSTDIR`, so an install already
recorded in the registry still wins and an update never relocates. An Edge installed before
this fix therefore stays in the shared directory; moving one takes an uninstall and a
reinstall. The `.nsh` carries the reasoning.

`.github/workflows/edge-windows-install-test.yml` is what keeps this fixed: it builds a
branch, installs a stock Paseo, installs Edge over it, and asserts they land in different
directories with an uninstall record each that survives the other being removed. Run it
against a branch before tagging.

```bash
gh workflow run "Edge Windows Install Test" --ref edge/tooling -f ref=edge/main
```

A hosted runner suits this better than the Windows VM: every run starts with neither build
installed, which is the state an install test needs and the most tedious one to reproduce by
hand.

What does carry over: `main.ts` hardcodes the app name via `app.setName`, so both builds
use `%APPDATA%\Paseo` and share a single-instance lock. Launching Edge while a stock Paseo
runs focuses the stock app and exits. Both also register the `paseo://` scheme, so the last
one installed wins the association.

Unlike Linux, there is **nothing else to install**: Windows has no systemd daemon to point
at, so Edge runs its own bundled daemon and both halves of every branch are present by
default. `scripts/edge/install-daemon.sh` and friends are Linux-only and are not needed.

The installers are **unsigned**, as upstream's are — the job needs no secrets. SmartScreen
shows "Windows protected your PC" on first run and on each update; getting rid of that means
buying a code-signing certificate, which is not worth it while the audience is us.

The arm64 build is packaged but not smoke-tested: `after-pack.js` skips the smoke when the
build arch differs from the host's, and the runner is x64. Upstream has the same gap.

To build a tag that already exists without cutting a new one:

```bash
gh workflow run "Edge Windows Release" --ref edge/main -f tag=edge-v1.6.1
```

## Android

Every `edge-v*` tag builds an APK as well, in the same release. The name carries no version,
so this link is always the newest build:

```
https://github.com/josham/paseo/releases/latest/download/paseo-edge-android-arm64.apk
```

Open it on the phone — it is a sideload, so Android asks once for permission to install from
whatever browser you used. Nothing updates it afterwards: come back to that link, or point
[Obtainium](https://github.com/ImranR98/Obtainium) at the repo and let it watch for releases.
Every build is signed with the same key, so installs over the top keep app data.

It installs **alongside** a stock Paseo rather than over it: the APK is `sh.paseo.edge`,
labelled "Paseo Edge". Android refuses to install over an app signed by a different key
anyway, so sharing upstream's id would mean uninstalling the stock app and losing its
data. Two things follow from having both: they show up as separate apps with the same
icon, and both claim the `paseo://` scheme, so a pairing link opens a chooser.

Like the desktop build, Edge on Android is the **client** half only — pair it with an Edge
daemon or the server-side branches are invisible. `pr/2597-sidebar-tree` is entirely
client-side and only works here; `pr/2452-pdf-preview` needs both halves.

Everything upstream's APK does is here, QR pairing included, as long as push notifications
are configured — see below. Without that configuration the build still works and simply
never receives a notification.

`versionCode` and `versionName` stay upstream's, for the same reason "App version" does in
Settings -> About. The Edge number is in the About screen's "Edge build" row and in the
APK's filename. Reinstalling over the same `versionCode` is allowed, so a new Edge build of
the same upstream version installs over the old one normally.

### How it is built

`.github/workflows/edge-android-release.yml` builds from source on the runner —
`expo prebuild` then Gradle, the path [docs/android.md](android.md) documents for F-Droid.
Upstream's `android-apk-release.yml` builds on EAS instead, which would mean an Expo
account, an `EXPO_TOKEN` and build quota, publishing under getpaseo's project. Building on
the runner needs none of that.

`scripts/edge/android-identity.sh` gives the generated project the Edge identity. It is the
Android counterpart of the `electron-builder -c` flags: it touches only `packages/app/android`,
which prebuild regenerates and git ignores, so no upstream file changes. It appends a second
`android { }` block rather than editing the generated one — the later block wins — and
asserts upstream's id and app name are what it expects first, so a rename upstream fails the
build instead of shipping something mislabelled.

Only arm64 is built (`-PreactNativeArchitectures=arm64-v8a`), which is every Android device
made since about 2017. A universal APK would carry three ABIs nobody here runs.

Gradle runs serial and daemon-free there, for the reason [docs/android.md](android.md) gives
under F-Droid builds: Hermes compiles the bundle in the same invocation as the native build,
and in parallel that does not fit on a standard runner. The first attempt died with no error
at all — `The operation was canceled` a minute after the bundle was written, which is what an
OOM-killed runner agent looks like. EAS pays for a larger machine; we take the slower build.

### Push notifications

The daemon does not talk to the phone directly. `packages/server/src/server/push/push-service.ts`
POSTs to Expo's push service, which delivers over FCM. So an Edge build needs both halves of
that chain to be ours, and upstream's APK gets them from credentials the fork does not have:

| What                   | Where it comes from                                                                     | What it is for                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `google-services.json` | a Firebase project with an Android app registered as `sh.paseo.edge`                    | lets the app mint a device token at all                                              |
| Expo `projectId`       | an Expo account with the Firebase service-account key uploaded as its FCM V1 credential | what `getExpoPushTokenAsync` mints against, and whose credentials Expo delivers with |

Configure both or neither. With upstream's `projectId` and our Firebase file, the app returns
a push token and every notification is dropped — nothing is logged at either end. The workflow
enforces the pairing and skips push entirely when both are absent.

One-time setup:

1. Firebase console → new project → add an **Android** app with package name `sh.paseo.edge`
   (no SHA-1 needed) → download `google-services.json`.
2. Same project → Settings → Service accounts → **Generate new private key**. That JSON is
   Expo's FCM credential, not something the build uses.
3. expo.dev → new project → note its **Project ID** and the account name → Credentials →
   Android, application identifier `sh.paseo.edge` → upload the key from step 2 as the
   **FCM V1 service account key**.
4. Hand them to the workflow:

   ```bash
   gh secret set EDGE_ANDROID_GOOGLE_SERVICES_JSON -R josham/paseo \
     < <(base64 -w0 google-services.json)
   gh variable set EDGE_EXPO_PROJECT_ID -R josham/paseo --body "<uuid>"
   gh variable set EDGE_EXPO_OWNER -R josham/paseo --body "<expo-account>"
   gh variable set EDGE_EXPO_SLUG -R josham/paseo --body "<expo-project-slug>"
   ```

`scripts/edge/android-push-config.sh` then writes the Firebase file where `app.config.js`
already looks for it (`packages/app/.secrets/`) and rewrites the `projectId` and `owner` in
that config before prebuild — `owner` and `slug` too, so nothing in the config names a
project that is not ours. It checks the Firebase file actually registers `sh.paseo.edge`
first, because Gradle's own version of that error arrives half an hour into the build.

The daemon needs nothing: it only forwards the token the app gives it, so any Edge daemon —
or a stock one — can push to an Edge app built this way.

### The signing key

Release builds are signed with an Edge key, not the public debug key Expo's template
defaults to. The workflow reads it from two repository secrets,
`EDGE_ANDROID_KEYSTORE_BASE64` and `EDGE_ANDROID_KEYSTORE_PASSWORD`, and fails before the
build starts if either is missing. It also refuses to upload an APK signed by
`CN=Android Debug`, which is the one failure that would otherwise produce a working,
installable, wrong artifact.

The keystore lives at `~/.local/share/paseo-edge/` on Josh's machine, with a `README.txt`
next to it. **Back it up.** GitHub secrets are write-only, so that is the only copy, and
Android ties an installed app to the key that signed it: losing it means every phone with
Edge on it has to uninstall (losing app data) before it can take another build.

### Building one locally

Needs the Android toolchain from [docs/android.md](android.md) and JDK 21:

```bash
npm ci
npm run eas-build-post-install --workspace=@getpaseo/app
(cd packages/app && CI=1 APP_VARIANT=production npx expo prebuild --platform android --clean --no-install)
scripts/edge/android-identity.sh
cd packages/app/android
EDGE_ANDROID_KEYSTORE=~/.local/share/paseo-edge/android-release.keystore \
EDGE_ANDROID_KEYSTORE_PASSWORD="$(cat ~/.local/share/paseo-edge/android-keystore-password.txt)" \
  ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon
```

The APK lands in `packages/app/android/app/build/outputs/apk/release/`. The identity script
refuses to run twice over one project, so re-run prebuild with `--clean` between builds.
Building without the keystore variables fails at Gradle configuration time on purpose:
falling back to the debug key would produce something that installs and looks right.

## Versions

Edge has its own version line starting at `1.0.0`, unrelated to upstream's numbers.
electron-updater only ever compares it against our own releases, and a plain `X.Y.Z`
with no prerelease suffix is what its `channel=latest`, `allowPrerelease=false`
configuration expects. Which upstream commit a build came from is in the release notes.

Two numbers therefore live in every build, and Settings -> About shows both. **App
version** is upstream's, read from `packages/app/package.json`, and it stays upstream's on
purpose: the host page compares that string against the daemon's version, so putting the
Edge number there would report a permanent mismatch to every client of a daemon on
upstream numbering, the stock mobile app included. **Edge build** is ours, carried by
`EDGE_BUILD_VERSION` in `packages/app/src/utils/edge-build.ts` (the
`edge/about-edge-build-row` branch), which the release workflow rewrites from the tag it
is building. A build made anywhere else keeps the `"dev"` placeholder and the row is not
rendered at all, so nothing about upstream's About screen changes.

`packages/desktop/package.json` gets the Edge version too, but only because
electron-builder and electron-updater read it; it never reaches the UI.

## What the CI does and does not run

Pushing a branch here runs nothing: upstream's `ci.yml` only triggers on `main` and on
PRs into it, and our `edge-v*` tags match none of upstream's tag triggers. This does not
affect PRs sent upstream — those run in getpaseo's repo, against getpaseo's CI.

Upstream's workflow files are present on `main` and none of them has ever fired here.
Some are now _registered_ even so — as of 2026-09-10 `gh workflow list --all` shows CI,
Desktop Release, Android APK Release and Release Notes Sync alongside ours, each with
zero runs, while `deploy-website.yml` and the other deploy jobs are still absent.
Publishing `edge-v1.0.0` did not fire `deploy-website.yml` despite its
`release: published` trigger. Registration is not a trigger, so this changes nothing —
but it does mean the disable endpoint works on the four that appear:

```bash
gh api -X PUT repos/josham/paseo/actions/workflows/deploy-website.yml/disable
```

That endpoint 404s on a workflow GitHub has not registered, which is why it could not be
used pre-emptively on the rest.

### Getting a new workflow its first run

`workflow_dispatch` is only offered for workflows GitHub has registered, and it registers
them from the **default branch** — here a mirror of upstream, which we never commit to. So
a workflow added on `edge/tooling` cannot be dispatched until it has run at least once:

```
HTTP 404: workflow edge-windows-release.yml not found on the default branch
```

A `push` trigger has no such requirement and fires from any branch. Bootstrap a new
workflow by adding a temporary `push: branches: [...]` trigger on a throwaway branch,
along with whatever guard keeps that run from publishing, and pushing it. The run
registers the workflow by its path; afterwards `gh workflow run --ref <any-branch>` works
and the branch and its scaffolding can be deleted. That is how the Windows job was proved
against `edge-v1.6.1` before any tag carried it. The Linux and Android jobs got there the
slower way, on their first real tag.

Linux x64, Windows x64/arm64 and Android arm64 are built. macOS is the one that is left:
it needs an Apple Developer certificate to produce something users can open without
fighting Gatekeeper, and iOS cannot be sideloaded at all without one.

## Licensing

Upstream is Apache-2.0 as of `a8734a972`. Redistributing modified builds is fine:
keep `LICENSE` and any `NOTICE` intact, and say the build is modified — the release notes
do that, and the source for any build is its `edge-v*` tag. Note that Apache-2.0 does not
grant trademark rights, so "Paseo Edge" is a name for builds we share between ourselves,
not one to put in front of the public.
