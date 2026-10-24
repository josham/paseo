#!/usr/bin/env bash
#
# Compile the Android app's native and Kotlin code, and nothing else.
#
# This is the pre-release gate `scripts/edge/release.sh` has never had. Linux and
# Windows break loudly in a local `npm run build:desktop`; Android does not break
# anywhere a person can see until an edge-v* tag has already published a release,
# because its compilers only exist inside the project `expo prebuild` generates.
#
# ⚠️ WHY THIS IS A FORK CONCERN. Paseo Edge is the only build of Paseo made from
# source on Android — upstream builds on EAS — so an upstream commit that breaks
# the native build reaches us first, and silently. Upstream #7424 shipped two on
# 2026-10-20: @shopify/react-native-skia 2.2.12 -> 2.6.2 without following two C++
# signature changes in paseo-diff-prototype, and a rewritten gesture-handler patch
# calling two members RNGH 2.32 had dropped. Each cost one published release and
# one ~20-minute CI round trip to find, one symbol at a time. This script finds
# all of them in one run.
#
# WHAT IT DOES NOT DO. No APK, no signing, no lint, no bundle, no release. It
# stops at the last point that can fail for a reason a human wrote: the C++ of
# every native module, and every Kotlin source in the app and its dependencies.
# Packaging and signing are CI's business and have their own failure modes, none
# of which depend on the code in this repo.
#
# Usage:
#   scripts/edge/check-android.sh [--keep] [--abi ABI]
#
#   --keep     leave the generated packages/app/android/ in place afterwards
#              (default: remove it, the way docs/android.md prescribes)
#   --abi ABI  which ABI to compile, default arm64-v8a — the one the release
#              builds and every Android device made since 2017
#
# Needs the opt-in Android toolchain: `android-dev setup` then `android-dev
# doctor`. The NDK and CMake pins there must equal React Native's own, or this
# compiles against a different toolchain than CI does and proves less than it
# appears to.

set -euo pipefail

APP_DIR="packages/app"
ABI="arm64-v8a"
keep=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep) keep=true; shift ;;
        --abi) ABI="$2"; shift 2 ;;
        -h|--help) sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "usage: $0 [--keep] [--abi ABI]" >&2; exit 2 ;;
    esac
done

cd "$(git rev-parse --show-toplevel)"

[[ -d "$APP_DIR" ]] || { echo "error: $APP_DIR is missing — run from the paseo repo." >&2; exit 1; }
[[ -d node_modules ]] || { echo "error: no node_modules — run 'npm install' first." >&2; exit 1; }

# ⚠️ The SDK reaches PATH through the curated farm, not mise's link farm, and a
# non-interactive shell may have neither. Resolve it the way `android-dev env`
# does rather than trusting the caller's environment.
if [[ -z "${ANDROID_HOME:-}" ]]; then
    if command -v android-dev >/dev/null; then
        eval "$(android-dev env)"
    else
        echo "error: ANDROID_HOME is unset and android-dev is not on PATH." >&2
        echo "       Install the toolchain with 'android-dev setup'." >&2
        exit 1
    fi
fi

# The versions Gradle will ask for. Read from React Native rather than pinned here:
# a second copy of these numbers is the thing that silently diverges.
ndk_version="$(sed -n 's/^ndkVersion = "\(.*\)"$/\1/p' node_modules/react-native/gradle/libs.versions.toml)"
[[ -n "$ndk_version" ]] || { echo "error: could not read ndkVersion from react-native." >&2; exit 1; }

if [[ ! -d "$ANDROID_HOME/ndk/$ndk_version" ]]; then
    echo "error: NDK $ndk_version is not installed in $ANDROID_HOME." >&2
    echo "       React Native pins it in gradle/libs.versions.toml. Install it with:" >&2
    echo "         sdkmanager \"ndk;$ndk_version\"" >&2
    echo "       or update the pin in android-dev and re-run 'android-dev setup'." >&2
    exit 1
fi

# ⚠️ patch-package runs at INSTALL time, and `git checkout` moves patches/ without
# touching node_modules. A tree whose patches changed since its last install compiles
# the OLD sources — which is a false failure when a patch was just fixed, and a false
# PASS when node_modules carries a fix the tree does not. CI never sees this because
# every run is a fresh `npm ci`. Caught by checking that each patch's additions are
# actually present in the files it names.
check_patches_applied() {
    local stale=() patch target line
    for patch in patches/*.patch; do
        [[ -f "$patch" ]] || continue
        while IFS= read -r line; do
            case "$line" in
                "+++ b/"*) target="${line#+++ b/}" ;;
                "+"*)
                    local added="${line#+}"
                    # Only lines with something to match, and only for packages installed here.
                    [[ -n "${target:-}" && -f "$target" && ${#added} -gt 12 ]] || continue
                    if ! grep -qF -- "$added" "$target"; then
                        stale+=("${patch##*/} -> $target")
                        break
                    fi
                    ;;
            esac
        done < "$patch"
    done

    (( ${#stale[@]} == 0 )) && return 0

    echo "error: node_modules does not match patches/ — these patches are not applied:" >&2
    printf '         %s\n' "${stale[@]}" >&2
    echo >&2
    echo "       patch-package runs at install time, so a checkout that changed a patch" >&2
    echo "       leaves the old sources in place. Re-extract the affected packages:" >&2
    echo "         rm -rf node_modules/<package> && npm install" >&2
    echo "       Plain 'npm install' is not enough: npm sees the version already present" >&2
    echo "       and does nothing, then patch-package applies the new patch to an already" >&2
    echo "       patched tree." >&2
    exit 1
}

echo "==> patches"
check_patches_applied
echo "    every patch in patches/ is present in node_modules"

echo "==> toolchain"
echo "    ANDROID_HOME  $ANDROID_HOME"
echo "    NDK           $ndk_version"
echo "    ABI           $ABI"
echo "    java          $(java -version 2>&1 | head -n1)"

cleanup() {
    if [[ "$keep" == false && -d "$APP_DIR/android" ]]; then
        echo "==> removing the generated project (pass --keep to inspect it)"
        rm -rf "${APP_DIR:?}/android"
    fi
}
trap cleanup EXIT

echo "==> prebuild"
# --no-install: the lockfile is already installed, and prebuild's own install
# would race it. --clean: a stale project is how a fixed build keeps failing.
( cd "$APP_DIR" && npx expo prebuild --platform android --clean --no-install )

echo "==> compile"
# Serial and daemon-free, which docs/android.md prescribes for source builds:
# parallel workers plus Hermes plus the native build do not fit in one machine.
#
# The two tasks are the whole point. externalNativeBuildRelease is the C++ of every
# native module — where the Skia break landed — and compileReleaseKotlin is every
# Kotlin source including the patched node_modules ones, where the gesture-handler
# break landed. Neither packages anything.
(
    cd "$APP_DIR/android"
    ./gradlew :app:externalNativeBuildRelease :app:compileReleaseKotlin \
        -PreactNativeArchitectures="$ABI" \
        --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
)

echo
echo "==> Android native and Kotlin code compiles."
echo "    Not checked: packaging, signing, lint, or anything at runtime."
