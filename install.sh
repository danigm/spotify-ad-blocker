#!/usr/bin/env bash
# Install the extension for the current user.
#
# GNOME 50 cannot pick up changed extension JavaScript in a running session:
# org.gnome.Shell.Extensions.ReloadExtension answers "ReloadExtension is
# deprecated and does not work", and the version-validation setting that used
# to force a re-import leaves every other extension with an occupied panel
# slot. So the copy below takes effect at the next login.
set -euo pipefail

UUID='spotify-ad-block@danigm.net'
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST/schemas"
install -m 0644 "$SRC/metadata.json" "$SRC/extension.js" "$SRC/ducking.js" \
    "$SRC/mpris.js" "$SRC/prefs.js" "$DEST/"
install -m 0644 "$SRC/schemas/"*.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"

echo "installed to $DEST"
gnome-extensions info "$UUID" 2>/dev/null | grep -E 'Version|Enabled|State' || true

if gnome-extensions info "$UUID" 2>/dev/null | grep -q 'State: ACTIVE'; then
    echo 'Already ACTIVE in the running session.'
else
    echo 'Log out and back in (or reboot) for the running shell to load it.'
fi
