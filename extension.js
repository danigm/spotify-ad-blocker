const St = imports.gi.St;
const Main = imports.ui.main;
const GLib = imports.gi.GLib;
const Gvc = imports.gi.Gvc;
const Mpris = imports.ui.mpris;
const Volume = imports.ui.status.volume;

let adBlocker;
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.spotify';

var AdBlocker = class AdBlocker {
    constructor() {
        this.activated = false;
        this.playerId = 0;
        this.button = new St.Bin({ style_class: 'panel-button',
                                   reactive: true,
                                   can_focus: true,
                                   x_fill: true,
                                   y_fill: false,
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

        this.disable();
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

    get stream() {
        let mixer = Volume.getMixerControl();

        let spotify = mixer.get_sink_inputs().find(y => y.get_name().toLowerCase() === 'spotify');
        if (spotify)
            return spotify;

        // spotify not found, return default
        return mixer.get_default_sink();
    }

    mute() {
        this.stream.change_is_muted(true);
        this.button.set_child(this.ad_icon);
    }

    unmute() {
        this.stream.change_is_muted(false);
        this.button.set_child(this.music_icon);
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

        if (title === 'spotify' || title === 'advertisement') {
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
    }

    disable() {
        this.activated = false;
        this.button.opacity = 100;
        if (this.playerId)
            this.player.disconnect(this.playerId);
        this.playerId = 0;
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
