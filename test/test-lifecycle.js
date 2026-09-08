// Extension lifecycle test: runs the real extension.js in gjs with the shell's
// UI modules and the D-Bus player replaced by stubs, so enable(), clicking the
// indicator, an ad, and disable() all get exercised.
//
// This exists because a broken disable() once left the panel slot occupied, and
// every later enable() then failed with "Extension point conflict".
//   gjs -m test/test-lifecycle.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {
    AD_METADATA,
    TRACK_METADATA,
    FakeActor,
    FakeMixer,
    FakePanel,
    FakeSettings,
    FakeStream,
    FakeTracker,
    strictActorClass,
} from './fakes.js';

const ROOT = import.meta.url.replace(/^file:\/\//, '').replace(/\/test\/[^/]+$/, '/');
const UUID = 'spotify-ad-block@danigm.net';

let failures = 0;
function check(condition, message) {
    print(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
    if (!condition)
        failures++;
}

function doesNotThrow(fn, message) {
    try {
        fn();
        check(true, message);
    } catch (e) {
        check(false, `${message} (${e.message})`);
    }
}

// Tracker double: the surface extension.js uses, plus the GObject teardown it
// performs. Instances are recorded so the test can feed them metadata.
const trackers = [];
class StubMprisTracker extends FakeTracker {
    constructor() {
        super();
        trackers.push(this);
    }

    destroy() {
    }

    run_dispose() {
    }
}

function writeStubModules(stubDir) {
    const files = {
        'stub-clutter.js': 'export default globalThis.__SAB_STUBS__.clutter;\n',
        'stub-st.js': 'export default globalThis.__SAB_STUBS__.st;\n',
        'stub-main.js': 'export const panel = globalThis.__SAB_STUBS__.panel;\n',
        'stub-panel-menu.js': 'export const Button = globalThis.__SAB_STUBS__.Button;\n',
        'stub-volume.js': 'export const getMixerControl = () => globalThis.__SAB_STUBS__.mixer;\n',
        'stub-mpris.js': 'export const MprisTracker = globalThis.__SAB_STUBS__.MprisTracker;\n',
        'stub-ducking.js': `export {AdBlocker} from 'file://${ROOT}ducking.js';\n`,
        'stub-extension.js': `export const Extension = class {\n` +
            `    constructor() {\n        this.uuid = '${UUID}';\n    }\n\n` +
            `    getSettings() {\n        return globalThis.__SAB_STUBS__.settings;\n    }\n};\n`,
    };

    for (const [name, contents] of Object.entries(files))
        GLib.file_set_contents(`${stubDir}/${name}`, contents);

    // The shell modules the extension imports only exist inside gnome-shell, so
    // rewrite those specifiers to the generated stubs. ducking.js stays real.
    const [ok, bytes] = Gio.File.new_for_path(`${ROOT}extension.js`).load_contents(null);
    const source = new TextDecoder().decode(bytes)
        .replaceAll(`'gi://Clutter'`, `'file://${stubDir}/stub-clutter.js'`)
        .replaceAll(`'gi://St'`, `'file://${stubDir}/stub-st.js'`)
        .replaceAll(`'resource:///org/gnome/shell/ui/main.js'`, `'file://${stubDir}/stub-main.js'`)
        .replaceAll(`'resource:///org/gnome/shell/ui/panelMenu.js'`, `'file://${stubDir}/stub-panel-menu.js'`)
        .replaceAll(`'resource:///org/gnome/shell/ui/status/volume.js'`, `'file://${stubDir}/stub-volume.js'`)
        .replaceAll(`'resource:///org/gnome/shell/extensions/extension.js'`, `'file://${stubDir}/stub-extension.js'`)
        .replaceAll(`'./mpris.js'`, `'file://${stubDir}/stub-mpris.js'`)
        .replaceAll(`'./ducking.js'`, `'file://${stubDir}/stub-ducking.js'`);

    GLib.file_set_contents(`${stubDir}/extension-under-test.js`, source);
    return `file://${stubDir}/extension-under-test.js`;
}

async function main() {
    const stubDir = `${GLib.get_tmp_dir().replace(/\/$/, '')}/sab-lifecycle-stubs`;
    try {
        GLib.spawn_command_line_sync(`rm -rf '${stubDir}'`);
    } catch (e) {
        // nothing there yet
    }
    GLib.mkdir_with_parents(stubDir, 0o700);
    writeStubModules(stubDir);

    const stream = new FakeStream(1, 'Spotify', 30000);
    const firefox = new FakeStream(2, 'Firefox', 28000);
    const mixer = new FakeMixer([stream, firefox]);
    const settings = new FakeSettings();
    const panel = new FakePanel();
    const moduleUrl = writeStubModules(stubDir);

    globalThis.__SAB_STUBS__ = {
        clutter: {EVENT_STOP: true},
        st: {Icon: strictActorClass(FakeActor, 'St.Icon')},
        panel,
        Button: strictActorClass(FakeActor, 'PanelMenu.Button'),
        mixer,
        settings,
        MprisTracker: StubMprisTracker,
    };

    const ExtensionClass = (await import(moduleUrl)).default;
    const extension = new ExtensionClass();

    print('enable');
    extension.enable();
    const button = panel.statusArea[UUID];
    check(panel.added.length === 1, 'indicator added to the panel');
    check(button !== undefined && !button.destroyed, 'indicator exists');
    check(button.visible === true, 'indicator visible with show-indicator on');

    settings.set_boolean('show-indicator', false);
    check(button.visible === false, 'turning show-indicator off hides the icon');
    settings.set_boolean('show-indicator', true);
    check(button.visible === true, 'turning it back on shows the icon');

    print('ad handling');
    const tracker = trackers[0];
    tracker.setMetadata(TRACK_METADATA);
    check(stream.get_volume() === 30000, 'song leaves the volume alone');

    tracker.setMetadata(AD_METADATA);
    check(stream.get_volume() === 0, 'ad mutes the spotify stream');
    check(firefox.get_volume() === 28000, 'other applications untouched');
    check(button.children[0].icon_name === 'tv-symbolic', 'icon switches to the ad icon');

    tracker.setMetadata(TRACK_METADATA);
    check(stream.get_volume() === 30000, 'volume restored after the ad');
    check(button.children[0].icon_name === 'folder-music-symbolic', 'icon back to music');

    print('indicator click');
    doesNotThrow(() => button.emit('button-press-event'), 'clicking the indicator does not throw');
    check(button.opacity === 100, 'click switches the blocker off (dimmed icon)');
    tracker.setMetadata(AD_METADATA);
    check(stream.get_volume() === 30000, 'no ducking while switched off');
    button.emit('button-press-event');
    check(button.opacity === 255, 'clicking again switches it on');
    check(stream.get_volume() === 0, 'ducking works again after re-enabling');

    print('disable');
    extension.disable();
    check(button.destroyed, 'indicator destroyed on disable');
    check(panel.statusArea[UUID] === undefined, 'panel slot released on disable');
    check(stream.get_volume() === 30000, 'audio restored on disable');

    print('re-enable and error recovery');
    doesNotThrow(() => extension.enable(), 'enabling again after disable works');
    const second = panel.statusArea[UUID];
    check(second !== undefined && second !== button, 'a fresh indicator was created');

    // Simulate what an error'd extension leaves behind: the slot still occupied
    // and no disable() coming to release it.
    extension.enable();
    const third = panel.statusArea[UUID];
    check(second.destroyed, 'the stale indicator was destroyed');
    check(third !== undefined && third !== second, 'a stale panel slot got reclaimed');

    doesNotThrow(() => extension.disable(), 'disable() does not throw');
    check(panel.statusArea[UUID] === undefined, 'final disable released the slot');
    doesNotThrow(() => button.emit('button-press-event'), 'a late click after disable does not throw');

    // The panel is the part of the shell API that keeps changing; refusing the
    // indicator must not stop the extension from muting ads.
    print('failing panel API');
    panel.failAddWith = new TypeError('Status indicator must be an instance of PanelMenu.Button');
    doesNotThrow(() => extension.enable(), 'enable() survives an indicator that cannot be added');
    check(panel.statusArea[UUID] === undefined, 'nothing occupies the slot without an indicator');

    const degradedTracker = trackers[trackers.length - 1];
    degradedTracker.setMetadata(AD_METADATA);
    check(stream.get_volume() === 0, 'ads still muted with no indicator');
    doesNotThrow(() => settings.set_boolean('show-indicator', false),
        'the show-indicator preference still works with no indicator');
    degradedTracker.setMetadata(TRACK_METADATA);
    check(stream.get_volume() === 30000, 'volume still restored after the ad with no indicator');
    doesNotThrow(() => extension.disable(), 'disable() works with no indicator');

    GLib.spawn_command_line_sync(`rm -rf '${stubDir}'`);
    print(failures === 0 ? '\nall lifecycle tests passed' : `\n${failures} lifecycle test(s) failed`);
    System.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    print(`FAIL ${e.message ?? e}`);
    print(e.stack);
    System.exit(1);
});
