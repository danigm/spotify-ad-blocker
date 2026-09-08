// MPRIS2 player watcher.
//
// Deliberately built on the plain D-Bus API rather than the shell's private
// `ui/mpris.js` module: that module is internal UI code whose class names and
// object layout keep changing between GNOME releases (MediaSection became
// MprisSource in 48, its internals are private), and that churn is what broke
// this extension on GNOME upgrades. The MPRIS2 D-Bus spec is stable instead.
//
// Metadata is read through org.freedesktop.DBus.Properties.Get so that the
// periodic reconcile poll and the PropertiesChanged signal share one path.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';

export const MprisTracker = GObject.registerClass({
    Signals: {
        // Emitted when the tracked player started or stopped playing
        // something, i.e. when the current track may have changed.
        'metadata-changed': {},
    },
}, class MprisTracker extends GObject.Object {
    _init(busName) {
        super._init();

        this._busName = busName;
        this._metadata = null;
        this._trackId = null;
        this._reading = false;
        this._signalIds = [];

        // Only used to observe whether the player owns its bus name and to
        // learn about PropertiesChanged emissions. DO_NOT_AUTO_START keeps a
        // closed Spotify from being launched by this extension.
        this._proxy = new Gio.DBusProxy({
            gConnection: Gio.DBus.session,
            gName: busName,
            gObjectPath: OBJECT_PATH,
            gInterfaceName: PLAYER_INTERFACE,
            gFlags: Gio.DBusProxyFlags.DO_NOT_AUTO_START,
        });

        // gjs does not run GInitable for us; without this the proxy never
        // resolves the bus name nor caches any property.
        try {
            this._proxy.init(null);
        } catch (e) {
            logError(e, `spotify-ad-block: cannot talk to ${busName}`);
        }

        this._signalIds.push(this._proxy.connect('notify::g-name-owner', () => {
            this._setMetadata(null);
            this.refresh();
        }));

        this._signalIds.push(this._proxy.connect('g-properties-changed',
            (proxy, changed) => {
                const props = changed.deep_unpack();
                if (props.Metadata === undefined)
                    return;

                this._setMetadata(props.Metadata.deep_unpack());
            }));
    }

    get available() {
        return this._proxy.get_name_owner() !== null;
    }

    // The current metadata as a plain JS object, or null when the player is
    // gone or has not reported anything yet.
    get metadata() {
        return this._metadata;
    }

    // Re-read Metadata from the player. Called on track signals and from the
    // periodic reconcile, so that a lost D-Bus signal cannot leave the volume
    // muted forever.
    refresh() {
        if (this._reading || !this.available)
            return;

        this._reading = true;
        // gjs hands an async D-Bus callback the C signature (source, result)
        // and reports a failed call by throwing from call_finish().
        try {
            Gio.DBus.session.call(this._busName, OBJECT_PATH, PROPERTIES_INTERFACE,
                'Get', new GLib.Variant('(ss)', [PLAYER_INTERFACE, 'Metadata']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, null,
                (source, result) => {
                    this._reading = false;
                    let reply;
                    try {
                        reply = source.call_finish(result);
                    } catch (e) {
                        // Player vanished or is not responding; the next
                        // reconcile will try again.
                        this._setMetadata(null);
                        return;
                    }

                    this._setMetadata(reply.deep_unpack()[0].deep_unpack());
                });
        } catch (e) {
            this._reading = false;
            this._setMetadata(null);
        }
    }

    _setMetadata(metadata) {
        if (metadata) {
            // Every value of the a{sv} dictionary is a variant itself.
            for (const key of Object.keys(metadata)) {
                try {
                    metadata[key] = metadata[key].deep_unpack();
                } catch (e) {
                    // Keep values that cannot be unpacked as they are.
                }
            }
        }

        const trackId = metadata ? metadata['mpris:trackid'] : null;
        if (trackId === this._trackId && !!metadata === !!this._metadata)
            return;

        this._metadata = metadata;
        this._trackId = trackId;
        this.emit('metadata-changed');
    }

    destroy() {
        for (const id of this._signalIds)
            this._proxy.disconnect(id);
        this._signalIds = [];
    }
});
