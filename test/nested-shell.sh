#!/usr/bin/env bash
# Run a real GNOME Shell (headless, its own D-Bus session, throwaway HOME) with
# only this extension installed, and report what happens.
#
# This is how the extension is validated without touching the running desktop:
# GNOME 50 cannot re-import changed extension JavaScript in a live session.
#   ./test/nested-shell.sh
set -uo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d /tmp/sab-nested.XXXXXX)"
UUID='spotify-ad-block@danigm.net'

export HOME="$ROOT/home"
export XDG_RUNTIME_DIR="$ROOT/run"
export XDG_DATA_DIRS=/usr/share:/usr/local/share
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

install_ext() {
    local dest="$HOME/.local/share/gnome-shell/extensions/$UUID"
    mkdir -p "$dest/schemas"
    install -m 0644 "$SRC/metadata.json" "$SRC/extension.js" "$SRC/ducking.js" \
        "$SRC/mpris.js" "$SRC/prefs.js" "$dest/"
    install -m 0644 "$SRC/schemas/"*.xml "$dest/schemas/"
    glib-compile-schemas "$dest/schemas"
}

install_ext

# Only this extension, nothing else, in the nested instance.
gsettings set org.gnome.shell enabled-extensions "['$UUID']" 2>/dev/null
gsettings set org.gnome.shell disable-user-extensions false 2>/dev/null

dbus-run-session -- bash -c "
    gnome-shell --wayland --display-server --headless --virtual-monitor 1280x800 \
        > '$ROOT/shell.log' 2>&1 &
    shell_pid=\$!

    for i in \$(seq 1 60); do
        if gnome-extensions info $UUID >/dev/null 2>&1; then
            break
        fi
        sleep 0.5
    done

    echo '=== extension state ==='
    gnome-extensions info $UUID 2>&1
    echo '=== panel buttons ==='
    gdbus call --session --dest org.gnome.Shell.Extensions \\
        --object-path /org/gnome/Shell/Extensions \\
        --method org.gnome.Shell.Extensions.GetExtensionErrors $UUID 2>&1
    kill \$shell_pid 2>/dev/null
    wait \$shell_pid 2>/dev/null
"

echo "=== shell log (errors and our extension) ==="
grep -iE "spotify|error|warning|exception|typeerror|conflict" "$ROOT/shell.log" | head -40
echo "=== full log: $ROOT/shell.log ==="
