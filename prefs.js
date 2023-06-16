const { Adw, Gio, GLib, Gtk } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

/**
 * Like `extension.js` this is used for any one-time setup like translations.
 *
 * @param {ExtensionMeta} meta - An extension meta object, described below.
 */
function init(meta) {
    console.debug(`initializing ${Me.metadata.name} Preferences`);
}

/**
 * This function is called when the preferences window is first created to fill
 * the `Adw.PreferencesWindow`.
 *
 * This function will only be called by GNOME 42 and later. If this function is
 * present, `buildPrefsWidget()` will NOT be called.
 *
 * @param {Adw.PreferencesWindow} window - The preferences window
 */
function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings();

    const prefsPage = new Adw.PreferencesPage({
        name: 'general',
        title: 'General',
        icon_name: 'dialog-information-symbolic',
    });
    window.add(prefsPage);

    const prefsGroup = new Adw.PreferencesGroup({
        title: 'General',
    });
    prefsPage.add(prefsGroup);

    const showIndicatorRow = new Adw.ActionRow({
        title: 'Show indicator',
        subtitle: 'Whether to show the panel indicator',
    });
    prefsGroup.add(showIndicatorRow);

    const showIndicatorSwitch = new Gtk.Switch({
        active: settings.get_boolean('show-indicator'),
        valign: Gtk.Align.CENTER,
    });
    settings.bind('show-indicator', showIndicatorSwitch, 'active',
        Gio.SettingsBindFlags.DEFAULT);

    showIndicatorRow.add_suffix(showIndicatorSwitch);
    showIndicatorRow.set_activatable_widget(showIndicatorSwitch);

    const adVolumeRow = new Adw.ActionRow({
        title: 'Volume percentage for ads',
        subtitle: 'Volume percentage to use when ads are playing',
    });
    prefsGroup.add(adVolumeRow);

    const adVolumeInput = Gtk.SpinButton.new_with_range(0, 100, 1);
    // Without this, the number input expands to fill all the vertical space
    adVolumeInput.set_valign(Gtk.Align.CENTER);
    settings.bind('ad-volume-percentage', adVolumeInput, 'value',
        Gio.SettingsBindFlags.DEFAULT)

    adVolumeRow.add_suffix(adVolumeInput);
    adVolumeRow.set_activatable_widget(adVolumeInput);

    const unmuteDelayRow = new Adw.ActionRow({
        title: 'Volume restore delay',
        subtitle: 'Delay in milliseconds before restoring volume after ads are finished playing',
    });
    prefsGroup.add(unmuteDelayRow);

    const unmuteDelayInput = Gtk.SpinButton.new_with_range(0, 10000, 100);
    unmuteDelayInput.set_valign(Gtk.Align.CENTER);
    settings.bind('unmute-delay', unmuteDelayInput, 'value',
        Gio.SettingsBindFlags.DEFAULT)

    unmuteDelayRow.add_suffix(unmuteDelayInput);
    unmuteDelayRow.set_activatable_widget(unmuteDelayInput);
}
