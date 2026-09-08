// Manual cross-check: duck the real Spotify stream and let an outside tool
// (pactl) observe it. Run with:
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell LD_LIBRARY_PATH=/usr/lib/gnome-shell \
//     gjs -m test/pactl-crosscheck.js
// and in another shell: watch -n0.3 'pactl list sink-inputs | grep -E "media.name|Volume"'
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';

import {AdBlocker} from '../ducking.js';

const AD = {'mpris:trackid': '/com/spotify/ad/crosscheck'};
const TRACK = {'mpris:trackid': 'spotify:track/crosscheck'};

const Tracker = GObject.registerClass({
    Signals: {'metadata-changed': {}},
}, class Tracker extends GObject.Object {
    _init() {
        super._init();
        this._md = TRACK;
    }

    refresh() {
    }

    get metadata() {
        return this._md;
    }

    setMetadata(md) {
        this._md = md;
        this.emit('metadata-changed');
    }
});

const loop = new GLib.MainLoop(null, false);
const mixer = new Gvc.MixerControl({name: 'spotify-ad-block-crosscheck'});
const tracker = new Tracker();

mixer.connect('state-changed', () => {
    const stream = mixer.get_sink_inputs()
        .find(s => (s.get_name() ?? '').toLowerCase() === 'spotify');
    if (!stream)
        return;

    stream.set_volume(Math.round(mixer.get_vol_max_norm() * 0.6));
    stream.push_volume();

    const blocker = new AdBlocker({
        mixer,
        tracker,
        settings: {get_int: () => 0, get_boolean: () => true},
    });
    blocker.enable();

    log('t=0.5s ducking the ad');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        tracker.setMetadata(AD);
        return GLib.SOURCE_REMOVE;
    });
    log('t=6s ad over, restoring');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => {
        tracker.setMetadata(TRACK);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            blocker.disable();
            log(`done, stream volume back to ${stream.get_volume()}`);
            loop.quit();
        });
        return GLib.SOURCE_REMOVE;
    });
});

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 25, () => {
    print('FAIL no Spotify stream found');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

mixer.open();
loop.run();
