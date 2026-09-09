import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';


const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.spotify';
const WATCH_TIMEOUT = 3000;

var AdBlocker = class AdBlocker {
    constructor(settings) {
        this.MAX_STREAM_VOLUME = Volume.getMixerControl().get_vol_max_norm();
        this._mpris = Mpris;

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

        this.remuteTimeout = 0;
        this.muteTimeout = 0;
        this.enable();

        this.settings.connect('changed::show-indicator', () => {
            if (this.settings.get_boolean('show-indicator')) {
                Main.panel._rightBox.insert_child_at_index(this.button, 0);
            } else {
                Main.panel._rightBox.remove_child(this.button);
            }
        });

        this.debugBox = null;
        this.debugMode = this.settings.get_boolean('debug-mode');
        this.settings.connect('changed::debug-mode', () => {
            this.debugMode = this.settings.get_boolean('debug-mode');
            this.showDebugControls();
        });

        if (this.debugMode) {
            this.showDebugControls();
        }
    }

    showDebugControls() {
        if (this.debugMode) {
            this.debugBox = this.createDebugBox();
            Main.panel._rightBox.insert_child_at_index(this.debugBox, 0);
        } else {
            Main.panel._rightBox.remove_child(this.debugBox);
            this.debugBox = null;
        }
    }

    createDebugBox() {
        const debugBox = new St.BoxLayout({name: 'debugBox'});

        this.debugMute = new St.Bin({ style_class: 'panel-button', reactive: true, can_focus: true, track_hover: true });
        this.debugUnmute = new St.Bin({ style_class: 'panel-button', reactive: true, can_focus: true, track_hover: true });
        this.debugMute.set_child(new St.Icon({ icon_name: 'audio-volume-muted-symbolic', style_class: 'system-status-icon' }));
        this.debugUnmute.set_child(new St.Icon({ icon_name: 'audio-volume-high-symbolic', style_class: 'system-status-icon' }));
        this.debugMute.connect('button-press-event', this.mute.bind(this));
        this.debugUnmute.connect('button-press-event', this.unmute.bind(this));


        this.debugTrackId = new St.Label({
            text: "track-id",
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        debugBox.insert_child_at_index(this.debugMute, 0);
        debugBox.insert_child_at_index(this.debugUnmute, 0);
        debugBox.insert_child_at_index(this.debugTrackId, 0);

        return debugBox;
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

    get streams() {
        let mixer = Volume.getMixerControl();

        let spotify = mixer.get_sink_inputs()
                           .filter(y => y.get_name() && y.get_name().toLowerCase() === 'spotify');
        if (spotify.length)
            return spotify;

        // spotify not found
        return [];
    }

    muteStreams() {
        if (this.debugMode) {
            console.log('Debug: muteStreams called');
        }

        this.streams.forEach(s => s.set_volume(this.MAX_STREAM_VOLUME * this.settings.get_int('ad-volume-percentage') / 100));
        // This needs to be called after changing the volume for it to take effect
        this.streams.forEach(s => s.push_volume());
    }

    mute() {
        if (this.muteTimeout) {
            GLib.source_remove(this.muteTimeout);
            this.muteTimeout = 0;
        }

        if (this.debugMode) {
            console.log('Debug: mute called');
        }

        this.muteStreams();
        this.button.set_child(this.ad_icon);

        // Remute while isAd
        if (this.remuteTimeout) {
            GLib.source_remove(this.remuteTimeout);
            this.remuteTimeout = 0;
        }
        this.remuteTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200,
            () => {
                if (this.isAd()) {
                    this.muteStreams();
                    return GLib.SOURCE_CONTINUE;
                }
                this.remuteTimeout = 0;
                return GLib.SOURCE_REMOVE;
            });
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
                this.unmute();
                return GLib.SOURCE_REMOVE;
            });
    }

    unmute() {
        if (this.debugMode) {
            console.log('Debug: unmute called');
        }

        if (this.remuteTimeout) {
            GLib.source_remove(this.remuteTimeout);
            this.remuteTimeout = 0;
        }

        this.streams.forEach(s => s.set_volume(this.MAX_STREAM_VOLUME));
        this.streams.forEach(s => s.push_volume());

        this.button.set_child(this.music_icon);
    }

    isAd() {
        const blocklist = [
            'spotify:ad',
            '/com/spotify/ad/',
        ];

        if (!this.player || !this.player._playerProxy) {
            this.reloadPlayer();
            return;
        }

        let trackId = this.player._playerProxy.Metadata['mpris:trackid'];
        if (!trackId)
            return false;

        trackId = trackId.unpack();

        if (this.debugMode) {
            console.log('Debug: isAd called with blocklist: ' + blocklist);
            console.log('Debug: isAd called with trackId: ' + trackId);
            this.debugTrackId.set_text(trackId);
        }

        return blocklist.some((b) => trackId.startsWith(b));
    }

    update() {
        if (!this.activated)
            return;

        if (this.debugMode) {
            console.log('Debug: update called');
        }

        const isad = this.isAd();
        if (isad) {
            this.mute();
        } else {
            this.unmuteAfterDelay();
        }
    }

    enable() {
        this.activated = true;
        this.button.opacity = 255;
        this.reloadPlayer();
        this.watch();
    }

    disable() {
        this.activated = false;
        this.button.opacity = 100;
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
}


export default class SpoitifyAdBlockExtension extends Extension {
    adBlocker = null;

    enable() {
        let settings = this.getSettings();
        this.adBlocker = new AdBlocker(settings);
        if (this.adBlocker.settings.get_boolean('show-indicator')) {
            Main.panel._rightBox.insert_child_at_index(this.adBlocker.button, 0);
        }
    }

    disable() {
        this.adBlocker.disable();
        Main.panel._rightBox.remove_child(this.adBlocker.button);
        this.adBlocker = null;
    }
}
