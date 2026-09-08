// Unit tests for ad detection and the ducking state machine. No D-Bus, no
// GNOME Shell: the mixer, the player tracker and the settings are replaced by
// fakes, so the logic is fully deterministic.
//   gjs -m test/test-engine.js
import GLib from 'gi://GLib';
import System from 'system';

import {AdBlocker, isAdMetadata} from '../ducking.js';

let failures = 0;

function check(condition, message) {
    if (condition) {
        print(`  ok   ${message}`);
    } else {
        print(`  FAIL ${message}`);
        failures++;
    }
}

/* ------------------------------------------------------------------ fakes */

const MAX_NORM = 65536;

class FakeStream {
    constructor(id, name, volume) {
        this._id = id;
        this._name = name;
        this._volume = volume;
        this.pushed = 0;
        this._handlers = new Map();
        this._nextHandler = 1;
    }

    get_id() {
        return this._id;
    }

    get_name() {
        return this._name;
    }

    get_volume() {
        return this._volume;
    }

    set_volume(volume) {
        this._volume = volume;
    }

    push_volume() {
        this.pushed++;
    }

    connect(signal, callback) {
        const id = this._nextHandler++;
        this._handlers.set(id, callback);
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    // Emit notify::volume the way Gvc would when the volume changes.
    emitVolumeChanged() {
        for (const callback of this._handlers.values())
            callback(this);
    }
}

class FakeMixer {
    constructor(streams) {
        this._streams = streams;
        this._handlers = new Map();
        this._nextHandler = 1;
    }

    get_sink_inputs() {
        return [...this._streams];
    }

    get_vol_max_norm() {
        return MAX_NORM;
    }

    lookup_stream_id(id) {
        return this._streams.find(s => s._id === id) ?? null;
    }

    connect(signal, callback) {
        const id = this._nextHandler++;
        this._handlers.set(id, [signal, callback]);
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    emit(signal, ...args) {
        for (const [name, callback] of this._handlers.values()) {
            if (name === signal)
                callback(this, ...args);
        }
    }

    addStream(stream) {
        this._streams.push(stream);
        this.emit('stream-added', stream.get_id());
    }

    removeStream(stream) {
        this._streams = this._streams.filter(s => s !== stream);
        this.emit('stream-removed', stream.get_id());
    }
}

class FakeTracker {
    constructor() {
        this.metadata = null;
        this.refreshes = 0;
        this._handlers = new Map();
        this._nextHandler = 1;
    }

    refresh() {
        this.refreshes++;
    }

    connect(signal, callback) {
        const id = this._nextHandler++;
        this._handlers.set(id, callback);
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    setMetadata(metadata) {
        this.metadata = metadata;
        for (const callback of this._handlers.values())
            callback(this);
    }
}

class FakeSettings {
    constructor(values) {
        this._values = {
            'ad-volume-percentage': 0,
            'unmute-delay': 0,
            'show-indicator': true,
            ...values,
        };
    }

    get_int(key) {
        return this._values[key];
    }

    get_boolean(key) {
        return this._values[key];
    }
}

function makeBlocker({streams = [], adVolume = 0, unmuteDelay = 0} = {}) {
    const mixer = new FakeMixer(streams);
    const tracker = new FakeTracker();
    const blocker = new AdBlocker({
        mixer,
        tracker,
        settings: new FakeSettings({
            'ad-volume-percentage': adVolume,
            'unmute-delay': unmuteDelay,
        }),
    });
    return {mixer, tracker, blocker};
}

const AD = {
    'mpris:trackid': '/com/spotify/ad/7af58bd5478e4c63b7a139d025c72772',
    'xesam:title': 'Baaki Sab No No, Only Prasuma Momos',
    'xesam:url': 'https://open.spotify.com/ad/7af58bd5478e4c63b7a139d025c72772',
};
const TRACK = {
    'mpris:trackid': 'spotify:track:0VJpxYwQjnbWxtOp5686Lc',
    'xesam:title': 'A real song',
    'xesam:url': 'https://open.spotify.com/track/0VJpxYwQjnbWxtOp5686Lc',
};

/* -------------------------------------------------------------- detection */

print('ad detection');
check(isAdMetadata(AD), 'ad with /com/spotify/ad/ trackid is an ad');
check(isAdMetadata({'mpris:trackid': 'spotify:ad:abc123'}), 'ad with spotify:ad: trackid is an ad');
check(isAdMetadata({'xesam:url': 'https://open.spotify.com/ad/abc'}), 'ad url alone is an ad');
check(!isAdMetadata(TRACK), 'normal track is not an ad');
check(!isAdMetadata({'mpris:trackid': '/org/mpris/MediaPlayer2/trackid/1'}), 'generic mpris trackid is not an ad');
check(!isAdMetadata(null), 'no metadata is not an ad');
check(!isAdMetadata({}), 'empty metadata is not an ad');
check(!isAdMetadata({'xesam:url': 'https://open.spotify.com/track/ad'}), 'a track whose title mentions ad is not an ad');

/* ------------------------------------------------------------ ducking */

print('ducking');
{
    const stream = new FakeStream(1, 'Spotify', 32768);
    const {mixer, tracker, blocker} = makeBlocker({streams: [stream]});
    blocker.enable();

    tracker.setMetadata(TRACK);
    check(stream.get_volume() === 32768, 'playing a track leaves the volume alone');

    tracker.setMetadata(AD);
    check(stream.get_volume() === 0, 'an ad mutes the spotify stream');
    check(stream.pushed > 0, 'the new volume is pushed to the sound server');
    check(blocker.ducking, 'blocker reports ducking');

    tracker.setMetadata(TRACK);
    check(stream.get_volume() === 32768, 'after the ad the user volume is restored, not 100 %');
    check(!blocker.ducking, 'blocker reports normal playback');

    blocker.disable();
}

{
    // Two ads back to back must not restore the volume in between.
    const stream = new FakeStream(2, 'Spotify', 20000);
    const {tracker, blocker} = makeBlocker({streams: [stream], unmuteDelay: 0});
    blocker.enable();

    tracker.setMetadata(AD);
    check(stream.get_volume() === 0, 'first ad mutes');
    tracker.setMetadata(TRACK);
    tracker.setMetadata(AD);
    check(stream.get_volume() === 0, 'second ad keeps it muted');
    tracker.setMetadata(TRACK);
    check(stream.get_volume() === 20000, 'volume restored once after the ad break');
    blocker.disable();
}

{
    // ad-volume-percentage above zero ducks instead of fully muting.
    const stream = new FakeStream(3, 'Spotify', MAX_NORM);
    const {tracker, blocker} = makeBlocker({streams: [stream], adVolume: 10});
    blocker.enable();
    tracker.setMetadata(AD);
    check(stream.get_volume() === Math.round(MAX_NORM * 0.1), '10 % ad volume ducks to a tenth');
    tracker.setMetadata(TRACK);
    check(stream.get_volume() === MAX_NORM, 'volume restored to full after the ad');
    blocker.disable();
}

{
    // Streams belonging to other applications must never be touched.
    const spotify = new FakeStream(4, 'Spotify', 30000);
    const firefox = new FakeStream(5, 'Firefox', 25000);
    const {tracker, blocker} = makeBlocker({streams: [spotify, firefox]});
    blocker.enable();
    tracker.setMetadata(AD);
    check(spotify.get_volume() === 0, 'spotify stream muted');
    check(firefox.get_volume() === 25000, 'other applications are untouched');
    tracker.setMetadata(TRACK);
    blocker.disable();
}

{
    // Spotify opening a new stream in the middle of an ad.
    const first = new FakeStream(6, 'Spotify', 40000);
    const {mixer, tracker, blocker} = makeBlocker({streams: [first]});
    blocker.enable();
    tracker.setMetadata(AD);
    check(first.get_volume() === 0, 'original stream muted');

    const replacement = new FakeStream(7, 'Spotify', 40000);
    mixer.removeStream(first);
    mixer.addStream(replacement);
    check(replacement.get_volume() === 0, 'a stream created during the ad is ducked too');

    tracker.setMetadata(TRACK);
    check(replacement.get_volume() === 40000, 'the replacement stream gets the pre-ad volume back');
    blocker.disable();
}

{
    // Spotify itself raising the volume during an ad must be corrected.
    const stream = new FakeStream(8, 'Spotify', 30000);
    const {tracker, blocker} = makeBlocker({streams: [stream]});
    blocker.enable();
    tracker.setMetadata(AD);
    stream._volume = 30000;
    stream.emitVolumeChanged();
    check(stream.get_volume() === 0, 'volume raised during an ad is ducked again');
    tracker.setMetadata(TRACK);
    check(stream.get_volume() === 30000, 'volume back to normal after the ad');
    blocker.disable();
}

{
    // Switched off via the panel icon: nothing happens, and turning it back on
    // restores audio that was ducked at that moment.
    const stream = new FakeStream(9, 'Spotify', 22222);
    const {tracker, blocker} = makeBlocker({streams: [stream]});
    blocker.enable();
    tracker.setMetadata(AD);
    check(stream.get_volume() === 0, 'muted while on');

    blocker.toggle();
    check(!blocker.activated, 'toggling switches the blocker off');
    check(stream.get_volume() === 22222, 'switching off restores the volume immediately');

    tracker.setMetadata(AD);
    check(stream.get_volume() === 22222, 'stays put while switched off');

    blocker.toggle();
    check(stream.get_volume() === 0, 'switching back on ducks the running ad');
    tracker.setMetadata(TRACK);
    blocker.disable();
}

{
    // disable() must leave the audio usable even in the middle of an ad.
    const stream = new FakeStream(10, 'Spotify', 44444);
    const {tracker, blocker} = makeBlocker({streams: [stream]});
    blocker.enable();
    tracker.setMetadata(AD);
    check(stream.get_volume() === 0, 'muted');
    blocker.disable();
    check(stream.get_volume() === 44444, 'disabling the extension restores the volume');
}

/* ------------------------------------------------- deferred restoration */

print('deferred restore');
{
    const stream = new FakeStream(11, 'Spotify', 30000);
    const {tracker, blocker} = makeBlocker({streams: [stream], unmuteDelay: 400});
    blocker.enable();

    tracker.setMetadata(AD);
    check(stream.get_volume() === 0, 'muted during the ad');
    tracker.setMetadata(TRACK);
    check(stream.get_volume() === 0, 'restore is deferred while the delay runs');

    const loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
        check(stream.get_volume() === 30000, 'volume restored after the delay elapsed');
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
    blocker.disable();
}

{
    // An ad starting again inside the restore window must cancel the restore.
    const stream = new FakeStream(12, 'Spotify', 30000);
    const {tracker, blocker} = makeBlocker({streams: [stream], unmuteDelay: 400});
    blocker.enable();
    tracker.setMetadata(AD);
    tracker.setMetadata(TRACK);
    tracker.setMetadata(AD);

    const loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
        check(stream.get_volume() === 0, 'still muted: the queued restore was cancelled');
        tracker.setMetadata(TRACK);
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
    blocker.disable();
}

print(failures === 0 ? '\nall tests passed' : `\n${failures} test(s) failed`);
System.exit(failures === 0 ? 0 : 1);
