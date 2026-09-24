#!/usr/bin/env bash
#
# Install the units that keep the Edge daemon in step with the Edge app.
#
# The app updates itself: electron-updater has autoDownload on and there is no
# setting to disable it, so the AppImage is replaced whenever a release lands.
# The path unit notices that and installs the daemon bundle from the same
# release, which is the half the app update does not touch.
#
# Nothing here restarts paseo-daemon. That is left to you, because a restart
# stops every agent the daemon is hosting.
#
# Usage: scripts/edge/install-sync.sh [--enable]

set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
units_dir="$HOME/.config/systemd/user"
bin_dir="$HOME/.local/bin"
enable=0
[[ "${1:-}" == "--enable" ]] && enable=1

# The unit runs the installer from a fixed path so it does not depend on a
# checkout still existing -- retiring the worktree is the point of all this.
mkdir -p "$bin_dir" "$units_dir"
install -m 0755 "$here/install-daemon.sh" "$bin_dir/paseo-edge-install-daemon"
install -m 0644 "$here/systemd/paseo-edge-sync.path" "$units_dir/paseo-edge-sync.path"
install -m 0644 "$here/systemd/paseo-edge-sync.service" "$units_dir/paseo-edge-sync.service"

systemctl --user daemon-reload

echo "Installed:"
echo "  $bin_dir/paseo-edge-install-daemon"
echo "  $units_dir/paseo-edge-sync.path"
echo "  $units_dir/paseo-edge-sync.service"

if (( enable )); then
    systemctl --user enable --now paseo-edge-sync.path
    echo
    echo "Watching for app updates. Check it with:"
    echo "  systemctl --user status paseo-edge-sync.path"
else
    echo
    echo "Enable the watch when you are ready:"
    echo "  systemctl --user enable --now paseo-edge-sync.path"
fi
echo
echo "To install the daemon now:  paseo-edge-install-daemon"
echo "To force a run of the sync: systemctl --user start paseo-edge-sync.service"
