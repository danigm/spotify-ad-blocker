#!/usr/bin/env bash
# Install the extension from this repository into the current user's
# GNOME Shell extensions directory.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

uuid="$(sed -n 's/^[[:space:]]*"uuid":[[:space:]]*"\([^"]*\)".*/\1/p' "$src/metadata.json")"
if [[ -z "$uuid" ]]; then
    echo "Could not read uuid from $src/metadata.json" >&2
    exit 1
fi

dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

# Replace any previous install so removed files don't linger
rm -rf "$dest"
mkdir -p "$dest/schemas"

install -m 644 "$src/metadata.json" "$src/extension.js" "$src/prefs.js" "$dest/"
install -m 644 "$src/schemas/"*.gschema.xml "$dest/schemas/"
glib-compile-schemas "$dest/schemas"

echo "Installed $uuid to $dest"
echo "Log out and back in (Wayland), then run: gnome-extensions enable $uuid"
