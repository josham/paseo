#!/usr/bin/env bash
#
# Install a second, disposable Paseo Edge beside the one you work in.
#
# The test instance is separate in all four places that matter, so nothing it does can
# reach the install you work in:
#
#   app       ~/.local/share/paseo-edge-<name>/app   extracted, so the updater cannot
#                                                    silently replace the build under test
#   userData  ~/.config/Paseo-Edge-<name>            its own Electron profile and
#                                                    single-instance lock
#   daemon    ~/.paseo-edge-<name>                   its own PASEO_HOME: own config,
#                                                    own workspaces, own agents, own log
#   port      127.0.0.1:6799 by default              never the live daemon's
#
# By default the app runs the daemon it ships with, exactly as a fresh install does, so
# client and server are one commit and there is nothing else to install. --daemon takes
# a release tag, a bundle tarball or a built checkout when the point of the test is the
# daemon itself.
#
# Usage:
#   scripts/edge/install-test-instance.sh [edge-vX.Y.Z]
#   scripts/edge/install-test-instance.sh --appimage ./Paseo-Edge-x86_64.AppImage
#   scripts/edge/install-test-instance.sh edge-v1.7.0 --daemon edge-v1.7.0
#   scripts/edge/install-test-instance.sh --appimage ... --daemon ~/workspace/paseo/paseo
#   scripts/edge/install-test-instance.sh --status
#   scripts/edge/install-test-instance.sh --remove [--purge]
#
# Options:
#   --name NAME       instance name, so several can coexist (default: test)
#   --port N          daemon port (default: 6799)
#   --appimage PATH   install a local build instead of a release
#   --daemon WHAT     app (default) | edge-vX.Y.Z | bundle.tar.gz | /path/to/checkout
#   --keep-updates    leave the updater pointed at the real feed (it will self-update)
#   --share-models    symlink the instance's speech models at the live install's (~1 GB)
#   --relay           let the instance reach relay.paseo.sh (off by default, see below)
#   --desktop-entry   also install a launcher entry (see the note where it is written)
#   --status          report what is installed and whether its daemon is up
#   --remove          uninstall; add --purge to delete the instance's PASEO_HOME too

set -euo pipefail

REPO="${PASEO_EDGE_REPO:-josham/paseo}"
name="test"
port=6799
appimage=""
tag=""
daemon_spec="app"
pin_updates=1
share_models=0
relay=0
desktop_entry=0
action="install"
purge=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name) name="$2"; shift 2 ;;
        --port) port="$2"; shift 2 ;;
        --appimage) appimage="$2"; shift 2 ;;
        --daemon) daemon_spec="$2"; shift 2 ;;
        --keep-updates) pin_updates=0; shift ;;
        --share-models) share_models=1; shift ;;
        --relay) relay=1; shift ;;
        --desktop-entry) desktop_entry=1; shift ;;
        --status) action="status"; shift ;;
        --remove) action="remove"; shift ;;
        --purge) purge=1; shift ;;
        -h|--help) sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        edge-v*) tag="$1"; shift ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "--name must be lowercase letters, digits and dashes: got '$name'" >&2; exit 2; }
[[ "$port" =~ ^[0-9]+$ ]] || { echo "--port must be a number: got '$port'" >&2; exit 2; }

slug="paseo-edge-$name"
root="$HOME/.local/share/$slug"
app_dir="$root/app"
daemon_prefix="$root/daemon"
paseo_home="$HOME/.paseo-edge-$name"
profile="$HOME/.config/Paseo-Edge-$name"
launcher="$HOME/.local/bin/$slug"
daemon_launcher="$root/bin/$slug-daemon"
entry="$HOME/.local/share/applications/$slug.desktop"

# Every path and port this script writes to is derived from --name, so a bad name is the
# one way it could reach the live install. Check the results rather than the input: these
# are the exact things that would be destroyed, and they cost nothing to assert.
live_home="$HOME/.paseo"
for pair in "$root:$HOME/.local/share/paseo-edge-daemon" "$paseo_home:$live_home" \
            "$profile:$HOME/.config/Paseo" "$profile:$HOME/.config/Paseo-Edge" \
            "$launcher:$HOME/.local/bin/paseo-edge" "$launcher:$HOME/.local/bin/paseo-edge-daemon" \
            "$launcher:$HOME/.local/bin/paseo"; do
    if [[ "${pair%%:*}" == "${pair##*:}" ]]; then
        echo "Refusing: instance path ${pair%%:*} is the live install's." >&2
        exit 1
    fi
done

# The live daemon's port comes from its own config, not from an assumption about 6767.
live_port=""
if [[ -f "$live_home/config.json" ]] && command -v node >/dev/null 2>&1; then
    live_port="$(node -e '
        const fs=require("fs");
        try{
          const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
          const l=c?.daemon?.listen;
          if(typeof l==="string"){const m=l.match(/:(\d+)$/); if(m) console.log(m[1]);}
        }catch{}' "$live_home/config.json")"
fi
if [[ -n "$live_port" && "$port" == "$live_port" ]]; then
    echo "Refusing: port $port is the live daemon's. Pick another with --port." >&2
    exit 1
fi

status_report() {
    echo "instance : $name"
    if [[ -d "$app_dir" ]]; then
        echo "app      : $app_dir ($(cat "$root/EDGE_TAG" 2>/dev/null || echo "unknown build"))"
        local feed="$app_dir/resources/app-update.yml"
        if [[ -f "$feed" ]]; then
            if grep -q '^channel: latest$' "$feed"; then
                echo "updates  : LIVE — this build will replace itself from the real feed"
            else
                echo "updates  : pinned ($(grep '^channel:' "$feed"))"
            fi
        fi
    else
        echo "app      : not installed"
    fi
    echo "profile  : $profile"
    echo "home     : $paseo_home"
    if [[ -d "$daemon_prefix" ]]; then
        echo "daemon   : $daemon_prefix ($(cat "$daemon_prefix/EDGE_TAG" 2>/dev/null || echo "unknown build")), run $daemon_launcher"
    else
        echo "daemon   : managed by the app"
    fi
    local instance="$paseo_home/paseo.pid"
    if [[ -f "$instance" ]] && command -v node >/dev/null 2>&1; then
        node -e '
            const fs=require("fs");
            try{
              const i=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
              let alive=false; try{process.kill(i.pid,0);alive=true}catch{}
              console.log(`running  : ${alive?"yes":"no (stale instance file)"} pid=${i.pid} listen=${i.listen??"?"}`);
            }catch{}' "$instance"
    else
        echo "running  : no"
    fi
    # Read the port the instance actually has, not the --port default: --status takes
    # no --port, so echoing the variable reported 6799 for an instance seeded on 6801.
    local configured=""
    if [[ -f "$paseo_home/config.json" ]]; then
        configured="$(sed -n 's/.*"listen"[[:space:]]*:[[:space:]]*"[^"]*:\([0-9][0-9]*\)".*/\1/p' \
            "$paseo_home/config.json" | head -1)"
    fi
    if [[ -n "$configured" ]]; then
        echo "port     : $configured (live daemon: ${live_port:-unknown})"
    else
        echo "port     : not seeded yet; an install would use $port (live daemon: ${live_port:-unknown})"
    fi
}

if [[ "$action" == "status" ]]; then
    status_report
    exit 0
fi

if [[ "$action" == "remove" ]]; then
    # PASEO_TEST_APP_NAME makes electron-log write ~/.config/<app name>/logs, outside the
    # instance root. The live install does the same thing under its own names.
    rm -rf "$root" "$profile" "$HOME/.config/Paseo Edge ($name)"
    rm -f "$launcher" "$entry"
    echo "removed $root, $profile, $launcher"
    if [[ "$purge" == 1 ]]; then
        # rm does not descend into symlinks, but --share-models points this one at the live
        # install's 985 MB of models, so drop the link first and leave nothing to reason about.
        [[ -L "$paseo_home/models" ]] && rm -f "$paseo_home/models"
        rm -rf "$paseo_home"
        echo "purged  $paseo_home"
    else
        echo "kept    $paseo_home (its workspaces and agents); --purge deletes it"
    fi
    exit 0
fi

for tool in curl tar node; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Required tool missing: $tool" >&2; exit 1; }
done

api() { curl -fsSL -H 'Accept: application/vnd.github+json' ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} "$@"; }

newest_edge_tag() {
    # Not /releases/latest: the fork inherited every upstream tag, so pick the newest
    # release whose tag is actually ours.
    api "https://api.github.com/repos/$REPO/releases?per_page=50" |
        node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
            const r=JSON.parse(s).filter(x=>!x.draft&&/^edge-v/.test(x.tag_name));
            if(!r.length){console.error("No edge-v* release found");process.exit(1)}
            console.log(r[0].tag_name);})'
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$root" "$root/bin" "$HOME/.local/bin"

if [[ -z "$appimage" ]]; then
    [[ -n "$tag" ]] || tag="$(newest_edge_tag)"
    appimage="$work/Paseo-Edge-x86_64.AppImage"
    url="https://github.com/$REPO/releases/download/$tag/Paseo-Edge-x86_64.AppImage"
    echo "fetching $url"
    curl -fL --retry 3 -o "$appimage" "$url"
    chmod +x "$appimage"
else
    [[ -f "$appimage" ]] || { echo "No such AppImage: $appimage" >&2; exit 1; }
    appimage="$(readlink -f "$appimage")"
    chmod +x "$appimage" 2>/dev/null || true
    tag="${tag:-local}"
fi

# Extracted rather than run as an AppImage, for two reasons that both matter here.
# electron-updater only installs over an AppImage when $APPIMAGE is set, and autoDownload
# is true with no setting to turn it off, so a test instance left as an AppImage would
# quietly stop being the build under test. Extracting also sidesteps the sandbox bug that
# makes an AppImage need --no-sandbox on argv: with $APPIMAGE unset, main.ts never appends
# the switch that half-applies, and Chromium's own sandbox comes up normally.
echo "extracting into $app_dir"
rm -rf "$app_dir" "$work/squashfs-root"
( cd "$work" && "$appimage" --appimage-extract >/dev/null )
mv "$work/squashfs-root" "$app_dir"
printf '%s\n' "$tag" > "$root/EDGE_TAG"

# Belt and braces. Extraction alone is already enough -- measured on 1.8.0, the check ends at
# "APPIMAGE env is not defined, current application is not an AppImage" before any network call,
# and is reported as a clean no-update. This covers the case where that stops being true, or
# where someone runs the AppImage form of the same build: a channel with no asset 404s, and a
# 404 on the channel file is ERR_UPDATER_CHANNEL_FILE_NOT_FOUND -- the one updater error Paseo
# swallows in silence (isUpdateChannelNotPublished in
# packages/desktop/src/features/auto-updater.ts), so it neither downloads nor complains.
feed="$app_dir/resources/app-update.yml"
if [[ "$pin_updates" == 1 && -f "$feed" ]]; then
    sed -i 's/^channel: .*/channel: pinned-no-such-channel/' "$feed"
    echo "pinned   $feed to a channel with no release asset"
fi

# The daemon reads its listen address from config.json in its own PASEO_HOME. Env does not
# work for the app-managed case: daemonLaunchEnvironment() strips every DAEMON_SETTING_ENV_KEY
# (PASEO_LISTEN and PORT among them) from a managed launch, precisely so a desktop app cannot
# leak its own environment into the daemon it spawns.
mkdir -p "$paseo_home"

# A fresh PASEO_HOME re-downloads the local speech models on first daemon start -- 985 MB,
# measured. They are a content-addressed download cache, so sharing one copy is safe enough
# to offer and too destructive to assume: a daemon under test writes into the live install's
# cache, and the whole point here is that it cannot.
if [[ "$share_models" == 1 ]]; then
    if [[ -d "$live_home/models" && ! -e "$paseo_home/models" ]]; then
        ln -s "$live_home/models" "$paseo_home/models"
        echo "linked   $paseo_home/models -> $live_home/models"
    fi
elif [[ ! -e "$paseo_home/models" && -d "$live_home/models" ]]; then
    echo "note     this instance will download its own speech models (~1 GB);"
    echo "         --share-models symlinks the live install's copy instead"
fi

if [[ ! -f "$paseo_home/config.json" ]]; then
    # Relay off unless asked for. A config that omits daemon.relay.enabled gets the opt-in
    # default of true (COMPAT(relayOptInDefault) in packages/server/src/server/config.ts), so
    # a test daemon seeded without this connects to relay.paseo.sh on first start -- measured,
    # once per instance -- and shows up as another device on the account. A local test build
    # should not announce itself anywhere; pass --relay when the relay is what you are testing.
    relay_enabled=false
    [[ "$relay" == 1 ]] && relay_enabled=true
    cat > "$paseo_home/config.json" <<CONFIG
{
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:$port",
    "relay": {
      "enabled": $relay_enabled
    }
  }
}
CONFIG
    echo "seeded   $paseo_home/config.json (listen 127.0.0.1:$port, relay $relay_enabled)"
else
    have="$(node -e '
        const fs=require("fs");
        try{console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))?.daemon?.listen??"")}catch{}
        ' "$paseo_home/config.json")"
    if [[ "$have" != "127.0.0.1:$port" ]]; then
        echo "warning: $paseo_home/config.json already listens on '$have', not 127.0.0.1:$port" >&2
        echo "         leaving it alone; pass --port ${have##*:} or edit that file." >&2
    fi
fi

manage_builtin=true
case "$daemon_spec" in
    app) ;;
    *) manage_builtin=false ;;
esac

if [[ "$daemon_spec" != "app" ]]; then
    case "$daemon_spec" in
        edge-v*)
            script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
            installer="$script_dir/install-daemon.sh"
            [[ -x "$installer" ]] || { echo "install-daemon.sh not found next to this script" >&2; exit 1; }
            # PASEO_EDGE_DAEMON_LAUNCHER is what keeps this off ~/.local/bin/paseo-edge-daemon,
            # which is the launcher the live systemd daemon execs.
            PASEO_EDGE_DAEMON_LAUNCHER="$root/bin/.installed-launcher" \
                "$installer" "$daemon_spec" --prefix "$daemon_prefix"
            daemon_cmd="$daemon_prefix/node_modules/.bin/paseo"
            ;;
        *.tar.gz)
            script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
            installer="$script_dir/install-daemon.sh"
            [[ -x "$installer" ]] || { echo "install-daemon.sh not found next to this script" >&2; exit 1; }
            PASEO_EDGE_DAEMON_LAUNCHER="$root/bin/.installed-launcher" \
                "$installer" --bundle "$(readlink -f "$daemon_spec")" --prefix "$daemon_prefix"
            daemon_cmd="$daemon_prefix/node_modules/.bin/paseo"
            ;;
        *)
            checkout="$(readlink -f "$daemon_spec")"
            entrypoint="$checkout/packages/cli/dist/index.js"
            [[ -f "$entrypoint" ]] || {
                echo "No built CLI at $entrypoint." >&2
                echo "Run 'npm install && npm run build:server' in that checkout first." >&2
                exit 1
            }
            daemon_cmd="node $entrypoint"
            ;;
    esac

    cat > "$daemon_launcher" <<DAEMON
#!/usr/bin/env bash
# Generated by scripts/edge/install-test-instance.sh — rerun that, do not edit this.
# The test instance's daemon: its own home, its own port, no systemd unit. Run it in a
# terminal and stop it with Ctrl-C; nothing else on this machine depends on it.
set -euo pipefail
export PASEO_HOME="$paseo_home"
export PASEO_LISTEN="127.0.0.1:$port"
# 'daemon run', not 'daemon start --foreground': upstream #4575 removed that flag, and a
# detached start would wrap itself in a systemd-run scope, which is the opposite of what a
# throwaway foreground daemon wants.
if [[ \$# -eq 0 ]]; then set -- daemon run; fi
exec $daemon_cmd "\$@"
DAEMON
    chmod +x "$daemon_launcher"
fi

# Seeded, never rewritten: settings changed inside the app are the point of a test
# instance, so this only decides what a fresh profile starts with.
mkdir -p "$profile"
if [[ ! -f "$profile/desktop-settings.json" ]]; then
    cat > "$profile/desktop-settings.json" <<SETTINGS
{
  "version": 1,
  "settings": {
    "daemon": {
      "manageBuiltInDaemon": $manage_builtin,
      "keepRunningAfterQuit": false
    }
  }
}
SETTINGS
    echo "seeded   $profile/desktop-settings.json (manageBuiltInDaemon: $manage_builtin)"
fi

cat > "$launcher" <<LAUNCHER
#!/usr/bin/env bash
# Generated by scripts/edge/install-test-instance.sh — rerun that, do not edit this.
# Paseo Edge test instance "$name", built from $tag.
set -euo pipefail

APP="$app_dir/AppRun"
if [[ ! -x "\$APP" ]]; then
  echo "Test instance not installed: \$APP is missing." >&2
  exit 1
fi

# PASEO_HOME is the whole isolation: the app resolves it through resolvePaseoHome(process.env)
# and hands it to every daemon call, so this instance talks to its own daemon on its own
# port and never sees the live one's workspaces, agents or config.
exec env \\
  PASEO_HOME="$paseo_home" \\
  PASEO_ELECTRON_USER_DATA_DIR="$profile" \\
  PASEO_TEST_APP_NAME="Paseo Edge ($name)" \\
  "\$APP" "\$@"
LAUNCHER
chmod +x "$launcher"

if [[ "$desktop_entry" == 1 ]]; then
    # Deliberately opt-in. Every current Paseo build reports the same Wayland app_id
    # (getpaseo-desktop — Electron's default from the package name, and nothing in the tree
    # overrides it), so a second entry claiming that StartupWMClass makes it ambiguous which
    # entry the compositor matches a window to. The cost lands on the install you work in:
    # its windows may take this instance's icon. Launch from a terminal unless you need it.
    mkdir -p "$(dirname "$entry")"
    cat > "$entry" <<ENTRY
[Desktop Entry]
Name=Paseo Edge ($name)
Comment=Disposable Paseo Edge test instance — own profile, own daemon, own port
Exec=$launcher %U
Icon=paseo-edge
Terminal=false
Type=Application
Categories=Development;
StartupWMClass=getpaseo-desktop
ENTRY
    echo "installed $entry"
fi

echo
echo "Paseo Edge test instance '$name' installed from $tag"
echo "  run      : $launcher"
echo "  app      : $app_dir"
echo "  profile  : $profile"
echo "  home     : $paseo_home (port $port)"
if [[ "$daemon_spec" != "app" ]]; then
    echo "  daemon   : $daemon_launcher   <- start this first, the app will not manage one"
else
    echo "  daemon   : managed by the app, from the same build"
fi
echo
echo "It cannot touch the live install: different app, profile, PASEO_HOME and port."
echo "Remove it with: $0 --name $name --remove [--purge]"
