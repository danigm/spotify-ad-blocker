import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MprisTracker} from './mpris.js';
import {AdBlocker} from './ducking.js';

const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.spotify';

const MUSIC_ICON = 'folder-music-symbolic';
const AD_ICON = 'tv-symbolic';

export default class SpotifyAdBlockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // The settings object outlives enable/disable, unlike the actors and
        // the blocker, so it is the only emitter whose handlers are tracked.
        this._settingsSignalIds = [];

        this._addIndicator();

        this._tracker = new MprisTracker(MPRIS_PLAYER);
        this._blocker = new AdBlocker({
            mixer: Volume.getMixerControl(),
            tracker: this._tracker,
            settings: this._settings,
        });

        this._settingsSignalIds.push(this._settings.connect('changed::show-indicator',
            () => this._updateIndicatorVisibility()));

        // Optional chaining: disable() destroys the widgets before the blocker
        // runs its own teardown, which still emits state changes.
        this._blocker.connect('ducking-changed', (blocker, ducking) => {
            if (this._icon)
                this._icon.icon_name = ducking ? AD_ICON : MUSIC_ICON;
        });
        this._blocker.connect('activated-changed', (blocker, activated) => {
            if (this._button)
                this._button.opacity = activated ? 255 : 100;
        });

        this._updateIndicatorVisibility();
        this._blocker.enable();
        if (this._icon)
            this._icon.icon_name = this._blocker.ducking ? AD_ICON : MUSIC_ICON;
    }

    // The indicator only reports and toggles; muting works without it. Panel
    // widgets are also the part of the shell API that keeps changing between
    // releases, so a failure here is logged and the rest of the extension
    // carries on instead of leaving the user with ads.
    _addIndicator() {
        this._button = null;
        this._icon = null;

        // An extension that ended up in the error state never gets disable()
        // called, which can leave the panel slot occupied; reclaim it.
        const stale = Main.panel.statusArea[this.uuid];
        if (stale) {
            log('spotify-ad-block: reclaiming the panel slot of a previous attempt');
            stale.destroy();
        }

        try {
            this._button = new PanelMenu.Button(0.0, 'Mute spotify ads', true);
            this._icon = new St.Icon({
                icon_name: MUSIC_ICON,
                style_class: 'system-status-icon',
            });
            this._button.add_child(this._icon);
            this._button.connect('button-press-event', () => {
                this._blocker?.toggle();
                return Clutter.EVENT_STOP;
            });
            Main.panel.addToStatusArea(this.uuid, this._button);
        } catch (e) {
            logError(e, 'spotify-ad-block: no panel indicator');
            this._button?.destroy();
            this._button = null;
            this._icon = null;
        }
    }

    disable() {
        for (const id of this._settingsSignalIds ?? [])
            this._settings.disconnect(id);
        this._settingsSignalIds = [];

        // The button owns the panel slot, so it goes first: nothing below it
        // may keep the old indicator alive.
        this._button?.destroy();
        this._button = null;
        this._icon = null;

        if (this._blocker) {
            this._blocker.disable();
            this._blocker.run_dispose();
            this._blocker = null;
        }

        if (this._tracker) {
            this._tracker.destroy();
            this._tracker.run_dispose();
            this._tracker = null;
        }

        this._settings = null;
    }

    _updateIndicatorVisibility() {
        // GNOME 50 actors expose visible/opacity/icon_name as properties;
        // the old set_*() methods no longer exist.
        if (this._button)
            this._button.visible = this._settings.get_boolean('show-indicator');
    }
}
