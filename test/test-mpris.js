// MPRIS watcher against the real Spotify client. Needs Spotify running.
//
// This is the only test that covers the periodic reconcile read, which exists
// so that a lost PropertiesChanged signal cannot leave the volume muted. That
// path once silently returned nothing for every poll, because gjs gives async
// D-Bus callbacks the C signature (source, result) rather than (result, error).
//   gjs -m test/test-mpris.js [seconds]
import GLib from 'gi://GLib';
import System from 'system';

import {MprisTracker} from '../mpris.js';
import {isAdMetadata} from '../ducking.js';

const TIMEOUT = ARGV.length > 0 ? parseInt(ARGV[0]) : 8;

let failures = 0;
function check(condition, message) {
    print(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
    if (!condition)
        failures++;
}

const tracker = new MprisTracker('org.mpris.MediaPlayer2.spotify');
check(tracker.available, 'the player owns its bus name');

const loop = new GLib.MainLoop(null, false);
let signalCount = 0;
tracker.connect('metadata-changed', () => {
    signalCount++;
    print(`  [signal] ${describe(tracker.metadata)}`);
});

function describe(metadata) {
    if (!metadata)
        return 'no metadata';
    return [
        metadata['mpris:trackid'],
        metadata['xesam:title'] ?? '',
        metadata['xesam:url'] ?? '',
    ].join(' | ');
}

function finish() {
    const metadata = tracker.metadata;
    print(`  current: ${describe(metadata)}`);

    check(metadata !== null, 'metadata read from the player');
    if (metadata) {
        // Values must reach ducking.js as plain strings, not GVariant wrappers.
        check(typeof metadata['mpris:trackid'] === 'string',
            'trackid is an unpacked string');
        check(typeof metadata['xesam:url'] === 'string',
            'url is an unpacked string');
        print(`  ${isAdMetadata(metadata) ? 'ad detected' : 'song, not detected as an ad'}`);
    }

    tracker.destroy();
    loop.quit();
    return GLib.SOURCE_REMOVE;
}

// Poll the way the extension's reconcile timer does, until the async read lands.
let polls = 0;
tracker.refresh();
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
    polls++;
    tracker.refresh();
    if (tracker.metadata !== null || polls >= TIMEOUT)
        return finish();
    return GLib.SOURCE_CONTINUE;
});

loop.run();

print(failures === 0 ? '\nMPRIS watcher OK' : `\n${failures} MPRIS check(s) failed`);
System.exit(failures === 0 ? 0 : 1);
