const St = imports.gi.St;
const Main = imports.ui.main;
const GLib = imports.gi.GLib;
const Gvc = imports.gi.Gvc;
const Mpris = imports.ui.mpris;
const Volume = imports.ui.status.volume;

let adBlocker;
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.spotify';
const BLOCK_LIST = [
    'spotify',
    'advertisement',
    '',
];
const WATCH_TIMEOUT = 3000;

var AdBlocker = class AdBlocker {
    constructor() {
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

        this.enable();
    }

    reloadPlayer() {
        this.player = new Mpris.MprisPlayer(MPRIS_PLAYER);
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

        let spotify = mixer.get_sink_inputs().filter(y => y.get_name().toLowerCase() === 'spotify');
        if (spotify.length)
            return spotify;

        // spotify not found, return default
        return [mixer.get_default_sink()];
    }

    mute() {
        this.streams.map(s => s.change_is_muted(true));
        this.button.set_child(this.ad_icon);
    }

    unmute() {
        this.button.set_child(this.music_icon);
        // Wait a bit to unmute, there's a delay before the next song
        // starts
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500,
            () => {
                this.streams.map(s => s.change_is_muted(false));
                return GLib.SOURCE_REMOVE;
            });
    }

    update() {
        if (!this.activated)
            return;

        let title = this.player.trackTitle.toLowerCase();
        if (title === 'unknown title') {
            this.reloadPlayer();
            this.update();
            return;
        }

        if (BLOCK_LIST.includes(title.trim())) {
            this.mute();
        } else {
            this.unmute();
        }
    }

    enable() {
        this.activated = true;
        this.button.opacity = 255;
        this.reloadPlayer();
        this.playerId = this.player.connect('changed', this.update.bind(this));
        this.watch();
    }

    disable() {
        this.activated = false;
        this.button.opacity = 100;
        if (this.playerId)
            this.player.disconnect(this.playerId);
        this.playerId = 0;
        this.stopWatch();
    }

    watch() {
        this.playerWatchTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            WATCH_TIMEOUT,
            () => {
                if (!this.player._playerProxy) {
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
    Main.panel._rightBox.insert_child_at_index(adBlocker.button, 0);
}

function disable() {
    adBlocker.disable();
    Main.panel._rightBox.remove_child(adBlocker.button);
    adBlocker = null;
}
