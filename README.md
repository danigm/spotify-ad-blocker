# Mute spotify ads

GNOME Shell extension that mutes the Spotify audio stream while an
advertisement is playing, and brings the volume back when the music resumes.

A panel icon shows the state: a music note normally, a TV symbol during an ad,
a dimmed icon when the extension is switched off. Clicking the icon toggles it.

## Why this fork exists

Upstream (https://github.com/danigm/spotify-ad-blocker) supports GNOME 45 to 49
and stops loading on GNOME 50, where the shell reports the extension as out of
date. Its player handling also reached into the shell's private `ui/mpris.js`,
whose internals changed in GNOME 48, and it set the stream volume to 100 % when
an ad ended, discarding the level the user had chosen.

This tree keeps the same extension id and the same settings, so it drops in
over an existing installation:

* `mpris.js` reads the MPRIS2 D-Bus interface directly (`Properties.Get` plus
  `PropertiesChanged`) instead of the shell's private media-player UI code.
  The MPRIS2 specification is stable, so player tracking no longer breaks on a
  GNOME upgrade.
* `ducking.js` holds the ad detection and the volume state machine. It saves
  the volume of each Spotify stream before ducking and restores exactly that
  level afterwards. Ducked state is tracked by the extension instead of being
  inferred from the current volume, so setting the volume by hand no longer
  confuses it.
* `extension.js` uses `Main.panel.addToStatusArea()` rather than reaching into
  the panel internals, and reclaims its panel slot if an earlier failed
  attempt left it occupied. Panel actors are driven through GNOME 50's property
  API (`visible`, `opacity`, `icon_name`), because the matching `set_*()`
  methods no longer exist on them. If the panel refuses the indicator, the
  error is logged and muting continues without the icon.
* `metadata.json` declares GNOME 50.

## Install

    ./install.sh

GNOME 50 cannot load changed extension code into a running session
(`ReloadExtension` is deprecated and returns an error), so log out and back in
after installing or updating.

## Settings

Right click the extension in GNOME Extensions (or `Extension Manager`) for:

* `show-indicator`: panel icon visibility.
* `ad-volume-percentage`: volume during ads, 0 means fully muted.
* `unmute-delay`: milliseconds to wait after an ad before restoring the volume,
  which avoids the volume pumping between ads in the same break.

## How ads are recognised

Spotify marks advertisements in the MPRIS metadata: `mpris:trackid` starts with
`spotify:ad` or `/com/spotify/ad/`, and `xesam:url` points at
`open.spotify.com/ad/`. Normal tracks use `spotify:track:` and
`open.spotify.com/track/`, so they never match.

## Tests

    ./test/run-tests.sh

* `test/test-engine.js`: ad detection plus the ducking state machine, with the
  mixer, player and settings replaced by doubles. Covers ads, back-to-back ads,
  ducking levels, streams appearing mid-ad, other applications, toggling and
  deferred restore.
* `test/test-lifecycle.js`: runs the real `extension.js` with stubbed shell
  modules. Covers enable, indicator click, ad handling, disable, re-enable and
  the occupied-panel-slot case that a broken `disable()` used to cause. The
  actor stubs expose properties only and reject the `set_*()` methods GNOME 50
  removed, and a panel that refuses the indicator is checked to leave muting
  working.
* `test/live-duck.js`: needs Spotify playing. Drives the real Gvc mixer control
  and the real Spotify output stream, with only the ad trigger simulated.
* `test/test-mpris.js`: needs Spotify running. Reads the live player through
  `MprisTracker` and asserts that both the async read and the values reach the
  extension intact, then reports whether the current item is seen as an ad. It
  is the only test covering the periodic reconcile read.
* `test/pactl-crosscheck.js`: ducks the real stream for a few seconds so
  `pactl list sink-inputs` can confirm the change reached the sound server.

`live-duck.js` and `pactl-crosscheck.js` need the shell's own library path:

    GI_TYPELIB_PATH=/usr/lib/gnome-shell LD_LIBRARY_PATH=/usr/lib/gnome-shell \
      gjs -m test/live-duck.js

## Layout

| file          | role                                                          |
| ------------- | ------------------------------------------------------------- |
| `extension.js` | panel indicator and extension lifecycle                       |
| `ducking.js`   | ad detection and volume ducking, independent of the shell     |
| `mpris.js`     | MPRIS2 player watcher over D-Bus                              |
| `prefs.js`     | preferences page                                              |
| `install.sh`   | copies the files to `~/.local/share/gnome-shell/extensions`   |

## License

GPL-2.0-or-later, as upstream. See `LICENSE.txt`.
