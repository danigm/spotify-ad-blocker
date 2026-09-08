// Test doubles shared by the test scripts.

export const MAX_NORM = 65536;

export class FakeStream {
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

    // Emit notify::volume the way Gvc does when someone changes the volume.
    emitVolumeChanged() {
        for (const callback of this._handlers.values())
            callback(this);
    }
}

export class FakeMixer {
    constructor(streams = []) {
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

export class FakeTracker {
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

export class FakeSettings {
    constructor(values) {
        this._values = {
            'ad-volume-percentage': 0,
            'unmute-delay': 0,
            'show-indicator': true,
            ...values,
        };
        this._handlers = new Map();
        this._nextHandler = 1;
    }

    get_int(key) {
        return this._values[key];
    }

    get_boolean(key) {
        return this._values[key];
    }

    set_boolean(key, value) {
        this._values[key] = value;
        for (const [signal, callback] of this._handlers.values()) {
            if (signal === `changed::${key}`)
                callback(this, key);
        }
    }

    connect(signal, callback) {
        const id = this._nextHandler++;
        this._handlers.set(id, [signal, callback]);
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }
}

export const AD_METADATA = {
    'mpris:trackid': '/com/spotify/ad/7af58bd5478e4c63b7a139d025c72772',
    'xesam:title': 'Baaki Sab No No, Only Prasuma Momos',
    'xesam:url': 'https://open.spotify.com/ad/7af58bd5478e4c63b7a139d025c72772',
};

export const TRACK_METADATA = {
    'mpris:trackid': 'spotify:track:0VJpxYwQjnbWxtOp5686Lc',
    'xesam:title': 'A real song',
    'xesam:url': 'https://open.spotify.com/track/0VJpxYwQjnbWxtOp5686Lc',
};

/* --------------------------------------------- GNOME Shell interface stubs */

// Minimal stand-ins for the parts of the shell the extension touches. The
// panel keeps the two behaviours that matter: a role may only be claimed once,
// and destroying the indicator is what releases it again.
//
// GNOME 50 actors set visible/opacity/icon_name through properties; the
// set_*() methods are gone. The actor stubs therefore expose properties only,
// and strictActor() below fails a test that calls a set_*() method.
class FakeSignalled {
    constructor() {
        this._handlers = new Map();
        this._nextHandler = 1;
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
        for (const [name, callback] of [...this._handlers.values()]) {
            if (name === signal)
                callback(...args);
        }
    }
}

export class FakeActor extends FakeSignalled {
    constructor(params = {}) {
        super();
        Object.assign(this, params);
        this.children = [];
        this.destroyed = false;
        this.visible = true;
        this.opacity = 255;
    }

    add_child(child) {
        this.children.push(child);
    }

    // Handlers keep working after destroy(), like the ones on a Clutter actor
    // that the shell has not finished tearing down.
    destroy() {
        this.destroyed = true;
        this.emit('destroy');
    }
}

// gjs only traps unknown property access through a Proxy. Method reads re-bind
// to the target, so a method body does not go back through the trap itself.
const GONE_IN_GNOME_50 = ['set_visible', 'set_opacity', 'set_icon_name'];

export function strictActor(actor, what) {
    return new Proxy(actor, {
        // Writes go to the target directly; the default trap would route them
        // back through the proxy.
        set(target, prop, value) {
            target[prop] = value;
            return true;
        },
        get(target, prop, receiver) {
            if (GONE_IN_GNOME_50.includes(prop)) {
                throw new TypeError(
                    `${what}.${String(prop)}() does not exist in GNOME 50; ` +
                    'assign the property instead');
            }
            const value = Reflect.get(target, prop, receiver);
            // Bind methods, or `Map.prototype.get` style internals lose `this`.
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

// Subclass whose instances are immediately wrapped, so that `new` sites in the
// extension get the strict behaviour without knowing about it.
export function strictActorClass(Base, what) {
    return class extends Base {
        constructor(...args) {
            super(...args);
            return strictActor(this, what);
        }
    };
}

export class FakePanel extends FakeSignalled {
    constructor() {
        super();
        this.statusArea = {};
        this.added = [];
        // Set to an error to make addToStatusArea refuse the indicator, the
        // way a shell with a different panel API would.
        this.failAddWith = null;
    }

    addToStatusArea(role, indicator) {
        if (this.statusArea[role])
            throw new Error(`Extension point conflict: there is already a status indicator for role ${role}`);

        if (this.failAddWith)
            throw this.failAddWith;

        this.statusArea[role] = indicator;
        this.added.push(role);
        indicator.connect('destroy', () => {
            delete this.statusArea[role];
        });
        return indicator;
    }
}
