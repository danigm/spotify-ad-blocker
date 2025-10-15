import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';


let adBlocker;
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.spotify';
const WATCH_TIMEOUT = 3000;

var AdBlocker = class AdBlocker {
    constructor(settings) {
        this.MAX_STREAM_VOLUME = Volume.getMixerControl().get_vol_max_norm();

        // GNOME 48
        if (Mpris.MediaSection == undefined) {
            this.media = new Mpris.MprisSource();
        } else {
            this.media = new Mpris.MediaSection();
        }

        this.settings = settings;
        this.player = null;
        this.playerWatchTimeoutId = 0;
        this.activated = false;
        this.playerId = 0;
        this.streamAddedHandlerId = 0;
        this.streamRemovedHandlerId = 0;
        this.streamVolumeHandlers = new Map();

        this.button = new St.Bin({ style_class: 'panel-button',
                                   reactive: true,
                                   can_focus: true,
                                   track_hover: true });

        this.music_icon = new St.Icon({
            icon_name: 'folder-music-symbolic',
            style_class: 'system-status-icon'
        });

        this.ad_icon = new St.Icon({
            icon_name: 'tv-symbolic',
            style_class: 'system-status-icon'
        });

        this.button.set_child(this.music_icon);
        this.button.connect('button-press-event', this.toggle.bind(this));

        this.muteTimeout = 0;
        this.enable();

        this.settings.connect('changed::show-indicator', () => {
            if (this.settings.get_boolean('show-indicator')) {
                Main.panel._rightBox.insert_child_at_index(this.button, 0);
            } else {
                Main.panel._rightBox.remove_child(this.button);
            }
        });
    }

    reloadPlayer() {
        if (this.playerId) {
            this.player.disconnect(this.playerId);
            this.playerId = 0;
        }

        this.player = this.media._players.get(MPRIS_PLAYER);
        if (this.player) {
            // Update right away in case the 'changed' signal has already been emitted
            this.update();
            this.playerId = this.player.connect('changed', this.update.bind(this));
        }
    }

    toggle() {
        if (!this.activated) {
            this.enable();
        } else {
            this.disable();
        }
    }

    get muted() {
        if (this.streams.length === 0) {
            return false;
        }

        // Subtract 1 from MAX_STREAM_VOLUME because it's 65536 but for some reason
        // sometimes the stream volume is 65535 when set to full volume
        return this.streams.every(s => s.get_volume() < this.MAX_STREAM_VOLUME - 1);
    }

    get streams() {
        let mixer = Volume.getMixerControl();

        let spotify = mixer.get_sink_inputs()
                           .filter(y => y.get_name() && y.get_name().toLowerCase() === 'spotify');
        if (spotify.length)
            return spotify;

        // spotify not found
        return [];
    }

    shouldMute() {
        return this.isAd() && !this.muted;
    }

    mute() {
        if (this.muteTimeout) {
            GLib.source_remove(this.muteTimeout);
            this.muteTimeout = 0;
        }

        this.streams.forEach(s => s.set_volume(this.MAX_STREAM_VOLUME * this.settings.get_int('ad-volume-percentage') / 100));
        // This needs to be called after changing the volume for it to take effect
        this.streams.forEach(s => s.push_volume());

        this.button.set_child(this.ad_icon);
    }

    shouldUnmute() {
        return !this.isAd() && this.muted;
    }

    unmuteAfterDelay() {
        // Don't schedule more than one unmute
        if (this.muteTimeout) {
            return;
        }

        // Wait a bit to unmute, there's a delay before the next song starts
        this.muteTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.settings.get_int('unmute-delay'),
            () => {
                this.muteTimeout = 0;

                // Always double-check before unmuting since this is delayed
                if (this.shouldUnmute()) {
                    this.unmute();
                }

                return GLib.SOURCE_REMOVE;
            });
    }

    unmute() {
        this.streams.forEach(s => s.set_volume(this.MAX_STREAM_VOLUME));
        this.streams.forEach(s => s.push_volume());

        this.button.set_child(this.music_icon);
    }

    isAd() {
        const blocklist = [
            'spotify:ad',
            '/com/spotify/ad/',
        ];

        let trackId = this.player._playerProxy.Metadata['mpris:trackid'];
        if (!trackId)
            return false;

        trackId = trackId.unpack();
        return blocklist.some((b) => trackId.startsWith(b));
    }

    update(didVolumeChange = false) {
        if (!this.activated)
            return;

        if (this.shouldMute()) {
            this.mute();
        } else if (this.shouldUnmute()) {
            if (didVolumeChange) {
                // Don't delay unmuting if it's because of a volume change
                this.unmute();
            } else {
                this.unmuteAfterDelay();
            }
        }
    }

    enable() {
        this.activated = true;
        this.button.opacity = 255;
        this.reloadPlayer();
        this.watch();
        this.connectStreamHandlers();
    }

    disable() {
        this.activated = false;
        this.button.opacity = 100;
        this.disconnectStreamHandlers();
        if (this.playerId)
            this.player.disconnect(this.playerId);
        if (this.muteTimeout) {
            GLib.source_remove(this.muteTimeout);
            this.muteTimeout = 0;
        }
        this.playerId = 0;
        this.stopWatch();
        this.player = null;
    }

    watch() {
        this.playerWatchTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            WATCH_TIMEOUT,
            () => {
                if (!this.player || !this.player._playerProxy) {
                    this.reloadPlayer();
                }
                return GLib.SOURCE_CONTINUE;
            });
    }

    stopWatch() {
        if (this.playerWatchTimeoutId) {
            GLib.source_remove(this.playerWatchTimeoutId);
            this.playerWatchTimeoutId = 0;
        }
    }

    connectStreamHandlers() {
        this.streams.forEach(stream => this.connectStreamVolumeHandler(stream));

        const mixer = Volume.getMixerControl();
        this.streamAddedHandlerId = mixer.connect('stream-added', (control, streamId) => {
            const stream = control.lookup_stream_id(streamId);
            const streamName = stream.get_name();
            if (streamName.toLowerCase() === 'spotify') {
                // A new stream could be created during an ad so we should check right
                // away whether it needs to be muted
                this.update();
                this.connectStreamVolumeHandler(stream);
            }
        });

        this.streamRemovedHandlerId = mixer.connect('stream-removed', (control, streamId) => {
            if (this.streamVolumeHandlers.has(streamId)) {
                const stream = control.lookup_stream_id(streamId);
                const handlerId = this.streamVolumeHandlers.get(streamId);
                if (stream && handlerId) {
                    stream.disconnect(handlerId);
                }
                this.streamVolumeHandlers.delete(streamId);
            }
        });
    }

    connectStreamVolumeHandler(stream) {
        const streamId = stream.get_id();
        if (!this.streamVolumeHandlers.has(streamId)) {
            const handlerId = stream.connect('notify::volume', stream => {
                // Spotify may change the stream volume so we should check whether the
                // stream volume needs to be muted or unmuted if this happens
                this.update();
            });
            this.streamVolumeHandlers.set(streamId, handlerId);
        }
    }

    disconnectStreamHandlers() {
        const mixer = Volume.getMixerControl();
        for (const [streamId, handlerId] of this.streamVolumeHandlers.entries()) {
            const stream = mixer.lookup_stream_id(Number(streamId));
            if (stream && handlerId) {
                stream.disconnect(handlerId);
            }
        }
        this.streamVolumeHandlers.clear();

        if (this.streamAddedHandlerId) {
            mixer.disconnect(this.streamAddedHandlerId);
            this.streamAddedHandlerId = 0;
        }
        if (this.streamRemovedHandlerId) {
            mixer.disconnect(this.streamRemovedHandlerId);
            this.streamRemovedHandlerId = 0;
        }
    }
}


export default class SpoitifyAdBlockExtension extends Extension {
    enable() {
        let settings = this.getSettings();
        adBlocker = new AdBlocker(settings);
        if (adBlocker.settings.get_boolean('show-indicator')) {
            Main.panel._rightBox.insert_child_at_index(adBlocker.button, 0);
        }
    }

    disable() {
        adBlocker.disable();
        Main.panel._rightBox.remove_child(adBlocker.button);
        adBlocker = null;
    }
}
