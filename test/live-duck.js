// End-to-end test of the ducking path against the real sound server.
//
// Uses the real Gvc mixer control (the same class the shell hands the
// extension) and the real Spotify output stream. Only the ad trigger is
// simulated, so the test does not depend on Spotify serving an ad right now.
//
// Spotify must be running with an output stream. Run with:
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell LD_LIBRARY_PATH=/usr/lib/gnome-shell \
//     gjs -m test/live-duck.js
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import System from 'system';

import {AdBlocker} from '../ducking.js';

const AD = {
    'mpris:trackid': '/com/spotify/ad/deadbeef',
    'xesam:title': 'simulated ad',
    'xesam:url': 'https://open.spotify.com/ad/deadbeef',
};
const TRACK = {
    'mpris:trackid': 'spotify:track:deadbeef',
    'xesam:title': 'simulated song',
    'xesam:url': 'https://open.spotify.com/track/deadbeef',
};

// Stands in for MprisTracker; ducking.js only uses `metadata` and connect().
const FakeTracker = GObject.registerClass({
    Signals: {'metadata-changed': {}},
}, class FakeTracker extends GObject.Object {
    _init() {
        super._init();
        this.metadata = null;
    }

    refresh() {
    }

    setMetadata(metadata) {
        this.metadata = metadata;
        this.emit('metadata-changed');
    }
});

// Duck fully and restore immediately: the extension defaults.
const settings = {
    get_int: () => 0,
    get_boolean: () => true,
};

let failures = 0;
function check(condition, message) {
    print(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
    if (!condition)
        failures++;
}

function later(delayMs, callback) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    });
}

const loop = new GLib.MainLoop(null, false);
const mixer = new Gvc.MixerControl({name: 'spotify-ad-block-test'});
const tracker = new FakeTracker();

const spotifyStreams = () => mixer.get_sink_inputs()
    .filter(s => (s.get_name() ?? '').toLowerCase() === 'spotify');

// state-changed fires repeatedly, and the test is only correct run once: a
// second pass would read the volume the first pass left behind as the original.
let started = false;

mixer.connect('state-changed', () => {
    if (started || spotifyStreams().length === 0)
        return;
    started = true;

    const streams = spotifyStreams();
    print(`spotify output streams: ${streams.length}`);
    for (const s of streams) {
        print(`  id=${s.get_id()} name="${s.get_name()}" vol=${s.get_volume()}/${mixer.get_vol_max_norm()}`);
    }

    const stream = streams[0];
    // A level that is neither 0 nor full, so restoring the user's own level is
    // distinguishable from a wrong "restore to 100 %".
    const userVolume = Math.round(mixer.get_vol_max_norm() * 0.6);
    // The test overwrites what the user had set, so remember it.
    const originalVolume = stream.get_volume();
    stream.set_volume(userVolume);
    stream.push_volume();

    const blocker = new AdBlocker({mixer, tracker, settings});
    blocker.enable();

    later(200, () => {
        tracker.setMetadata(TRACK);
        check(stream.get_volume() === userVolume, 'song playing: volume left alone');

        tracker.setMetadata(AD);
        later(300, () => {
            check(stream.get_volume() === 0, `ad started: real stream muted (volume ${stream.get_volume()})`);

            tracker.setMetadata(TRACK);
            later(300, () => {
                check(stream.get_volume() === userVolume,
                    `ad over: stream back at the user level ${userVolume} (volume ${stream.get_volume()})`);
                blocker.disable();
                stream.set_volume(originalVolume);
                stream.push_volume();
                // Give the server round trip a chance to finish; quitting
                // straight away drops the volume the test is restoring.
                later(500, () => loop.quit());
            });
        });
    });
});

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 25, () => {
    failures++;
    print('FAIL no Spotify output stream within 25 s - start playback in Spotify first');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

mixer.open();
loop.run();

print(failures === 0 ? '\nlive ducking OK' : '\nlive ducking FAILED');
System.exit(failures === 0 ? 0 : 1);
