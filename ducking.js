// Ad detection and volume ducking.
//
// This module has no dependency on GNOME Shell internals (only on the mixer
// control handed in by the caller), which keeps it testable outside the shell.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const AD_TRACKID_PREFIXES = [
    'spotify:ad',
    '/com/spotify/ad/',
];
const AD_URL_REGEX = /open\.spotify\.com\/ad\//;

// How often to re-read the player and re-assert the volume. A safety net for
// lost D-Bus signals, cheap enough to be unnoticeable.
const RECONCILE_INTERVAL = 2;

// Decide whether an MPRIS metadata dictionary describes an advertisement.
// Spotify marks ads in the mpris:trackid object path and mirrors it in the
// xesam:url; normal tracks use spotify:track:… / open.spotify.com/track/….
export function isAdMetadata(metadata) {
    if (!metadata)
        return false;

    const trackId = metadata['mpris:trackid'];
    if (typeof trackId === 'string' &&
        AD_TRACKID_PREFIXES.some(prefix => trackId.startsWith(prefix)))
        return true;

    const url = metadata['xesam:url'];
    return typeof url === 'string' && AD_URL_REGEX.test(url);
}

export const AdBlocker = GObject.registerClass({
    Signals: {
        // Whether the blocker is switched on (indicator clicked).
        'activated-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        // Whether an ad is currently ducking the audio.
        'ducking-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class AdBlocker extends GObject.Object {
    _init({mixer, tracker, settings}) {
        super._init();

        this._mixer = mixer;
        this._tracker = tracker;
        this._settings = settings;

        this._activated = false;
        this._ducked = false;
        this._applying = false;
        // Volumes this extension overwrote, keyed by stream id, so that the
        // level the user had set comes back instead of blasting to 100 %.
        this._savedVolumes = new Map();
        this._baselineVolume = null;
        this._restoreSource = null;
        this._reconcileSource = null;
        this._trackerSignals = [];
        this._mixerSignals = [];
        this._streamSignals = new Map();
    }

    get activated() {
        return this._activated;
    }

    get ducking() {
        return this._ducked;
    }

    // The audio streams Spotify currently plays through.
    get streams() {
        return this._mixer.get_sink_inputs().filter(stream => this._isSpotifyStream(stream));
    }

    enable() {
        for (const stream of this.streams)
            this._watchStream(stream);

        this._trackerSignals.push(
            this._tracker.connect('metadata-changed', () => this.evaluate()));

        this._mixerSignals.push(
            this._mixer.connect('stream-added', (mixer, id) => {
                const stream = mixer.lookup_stream_id(id);
                if (!this._isSpotifyStream(stream))
                    return;

                // Spotify can open a fresh stream when an ad starts, so the
                // new stream has to be ducked right away.
                this._watchStream(stream);
                this._reassert();
            }),
            this._mixer.connect('stream-removed', (mixer, id) => this._dropStream(id)));

        this._reconcileSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, RECONCILE_INTERVAL, () => {
                this._tracker.refresh();
                this.evaluate();
                this._reassert();
                return GLib.SOURCE_CONTINUE;
            });

        this.activate();
    }

    disable() {
        for (const id of this._trackerSignals)
            this._tracker.disconnect(id);
        this._trackerSignals = [];

        for (const id of this._mixerSignals)
            this._mixer.disconnect(id);
        this._mixerSignals = [];

        for (const stream of this.streams)
            this._unwatchStream(stream);

        if (this._reconcileSource) {
            GLib.source_remove(this._reconcileSource);
            this._reconcileSource = null;
        }
        this._cancelRestore();
        this._unduck();
        this._activated = false;
    }

    activate() {
        this._activated = true;
        this.emit('activated-changed', true);
        this._tracker.refresh();
        this.evaluate();
    }

    deactivate() {
        this._activated = false;
        this.emit('activated-changed', false);
        this._cancelRestore();
        this._unduck();
    }

    toggle() {
        if (this._activated)
            this.deactivate();
        else
            this.activate();
    }

    isAd() {
        return this._activated && isAdMetadata(this._tracker.metadata);
    }

    // Core decision: ad and not ducked means duck, ad over and ducked means
    // bring the volume back. Everything else is a no-op, which keeps this
    // cheap enough to call from signal handlers.
    evaluate() {
        if (!this._activated)
            return;

        const ad = isAdMetadata(this._tracker.metadata);
        if (ad && !this._ducked) {
            this._duck();
        } else if (ad) {
            this._cancelRestore();
        } else if (this._ducked) {
            this._scheduleRestore();
        }
    }

    _isSpotifyStream(stream) {
        if (!stream)
            return false;

        const name = stream.get_name();
        return name !== null && name.toLowerCase() === 'spotify';
    }

    _duck() {
        this._ducked = true;

        const target = this._duckTargetVolume();
        for (const stream of this.streams) {
            const id = stream.get_id();
            if (!this._savedVolumes.has(id)) {
                const volume = stream.get_volume();
                this._savedVolumes.set(id, volume);
                this._baselineVolume = volume;
            }
            this._setVolume(stream, target);
        }

        this._emitDucking();
    }

    _unduck() {
        if (!this._ducked)
            return;

        for (const stream of this.streams) {
            const id = stream.get_id();
            // A stream that appeared during the ad has no stored volume; give
            // it the level the user had before the ad instead.
            const volume = this._savedVolumes.has(id)
                ? this._savedVolumes.get(id) : this._baselineVolume;
            if (volume !== null && volume !== undefined)
                this._setVolume(stream, volume);
        }

        this._savedVolumes.clear();
        this._ducked = false;
        this._emitDucking();
    }

    // Bring the volume back to what the current state requires, e.g. when
    // Spotify reset it on a stream in the middle of an ad.
    _reassert() {
        if (!this._activated || !this._ducked)
            return;

        const target = this._duckTargetVolume();
        for (const stream of this.streams) {
            if (stream.get_volume() !== target)
                this._setVolume(stream, target);
        }
    }

    _scheduleRestore() {
        if (this._restoreSource)
            return;

        // Ad breaks often have a silent gap before the next track and Spotify
        // may queue the next ad right away; waiting keeps the volume from
        // pumping between two ads.
        const delay = Math.max(0, this._settings.get_int('unmute-delay'));
        if (delay === 0) {
            this._unduck();
            return;
        }

        this._restoreSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._restoreSource = null;
            // Re-check: a new ad may have started during the delay.
            if (!isAdMetadata(this._tracker.metadata))
                this._unduck();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRestore() {
        if (this._restoreSource) {
            GLib.source_remove(this._restoreSource);
            this._restoreSource = null;
        }
    }

    _duckTargetVolume() {
        const percent = Math.min(Math.max(this._settings.get_int('ad-volume-percentage'), 0), 100);
        return Math.round(this._mixer.get_vol_max_norm() * percent / 100);
    }

    _setVolume(stream, volume) {
        // Guard against our own write re-entering through notify::volume.
        this._applying = true;
        try {
            stream.set_volume(volume);
            stream.push_volume();
        } finally {
            this._applying = false;
        }
    }

    _watchStream(stream) {
        const id = stream.get_id();
        if (this._streamSignals.has(id))
            return;

        this._streamSignals.set(id, stream.connect('notify::volume', () => {
            if (this._applying)
                return;

            // Spotify or the user touched the volume; make sure it matches
            // what the current situation calls for.
            this.evaluate();
            this._reassert();
        }));
    }

    _unwatchStream(stream) {
        const id = stream.get_id();
        if (!this._streamSignals.has(id))
            return;

        stream.disconnect(this._streamSignals.get(id));
        this._streamSignals.delete(id);
    }

    _dropStream(id) {
        const stream = this._mixer.lookup_stream_id(id);
        if (stream)
            this._unwatchStream(stream);
        this._savedVolumes.delete(id);
    }

    _emitDucking() {
        this.emit('ducking-changed', this._ducked);
    }
});
