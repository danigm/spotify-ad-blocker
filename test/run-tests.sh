#!/usr/bin/env bash
# Run every test. The live ones need Spotify running with an audio stream and
# are skipped when it has none.
set -uo pipefail

cd "$(dirname "$0")/.."
status=0

echo '== ad detection and ducking state machine =='
gjs -m test/test-engine.js || status=1

echo
echo '== extension lifecycle (enable / click / ad / disable) =='
gjs -m test/test-lifecycle.js || status=1

echo
echo '== real audio stream ducking =='
if pactl list sink-inputs 2>/dev/null | grep -q 'media.name = "Spotify"'; then
    GI_TYPELIB_PATH=/usr/lib/gnome-shell LD_LIBRARY_PATH=/usr/lib/gnome-shell \
        gjs -m test/live-duck.js || status=1
else
    echo 'skipped: no Spotify output stream (start playback in Spotify first)'
fi

echo
echo '== live Spotify metadata through the MPRIS watcher =='
if busctl --user list 2>/dev/null | grep -q org.mpris.MediaPlayer2.spotify; then
    gjs -m test/test-mpris.js 8 || status=1
else
    echo 'skipped: Spotify is not on the session bus'
fi

exit $status
