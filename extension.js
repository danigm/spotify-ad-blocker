const St = imports.gi.St;
const Main = imports.ui.main;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gvc = imports.gi.Gvc;
const ExtensionUtils = imports.misc.extensionUtils;
const Mpris = imports.ui.mpris;
const Volume = imports.ui.status.volume;

let adBlocker;
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.spotify';
const WATCH_TIMEOUT = 3000;

var AdBlocker = class AdBlocker {
    constructor() {
        this.media = new Mpris.MediaSection();
        this.settings = ExtensionUtils.getSettings();
        this.player = null;
        this.playerWatchTimeoutId = 0;
        this.activated = false;
        this.playerId = 0;
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

        this.muted = false;
        this.muteTimeout = 0;
        this.enable();

        this.volumeBeforeAds = 0;

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

        // spotify not found, return default
        return [mixer.get_default_sink()];
    }

    mute() {
        if (this.muted)
            return;
        this.muted = true;

        if (this.muteTimeout) {
            GLib.source_remove(this.muteTimeout);
            this.muteTimeout = 0;
        }

        if (this.streams.length > 0) {
            this.volumeBeforeAds = this.streams[0].get_volume();
        }
        this.streams.map(s => s.set_volume(this.volumeBeforeAds * this.settings.get_int('ad-volume-percentage') / 100));
        // This needs to be called after changing the volume for it to take effect
        this.streams.map(s => s.push_volume());

        this.button.set_child(this.ad_icon);
    }

    unmuteAfterDelay() {
        if (!this.muted)
            return;
        this.muted = false;

        // Wait a bit to unmute, there's a delay before the next song
        // starts
        this.muteTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.settings.get_int('unmute-delay'),
            // The arrow function is necessary so unmuteNow can use "this"
            () => this.unmute());
    }

    unmute() {
        this.muteTimeout = 0;

        if (this.volumeBeforeAds > 0) {
            this.streams.map(s => s.set_volume(this.volumeBeforeAds));
            this.streams.map(s => s.push_volume());
        }

        this.button.set_child(this.music_icon);
        return GLib.SOURCE_REMOVE;
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

    update() {
        if (!this.activated)
            return;

        if (this.isAd()) {
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
        if (this.muted)
            this.unmute();
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


function init() {
}

function enable() {
    adBlocker = new AdBlocker();
    if (adBlocker.settings.get_boolean('show-indicator')) {
        Main.panel._rightBox.insert_child_at_index(adBlocker.button, 0);
    }
}

function disable() {
    adBlocker.disable();
    Main.panel._rightBox.remove_child(adBlocker.button);
    adBlocker = null;
}
