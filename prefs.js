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
 * This function is called when the preferences window is first created to build
 * and return a GTK widget.
 *
 * As of GNOME 42, the preferences window will be a `Adw.PreferencesWindow`. The
 * widget returned by this function will be added to an `Adw.PreferencesPage` or
 * `Adw.PreferencesGroup` if necessary.
 *
 * @returns {Gtk.Widget} the preferences widget
 */
function buildPrefsWidget() {
    // This may be any GtkWidget, although usually you would choose a container
    // container like a GtkBox, GtkGrid or GtkNotebook
    const prefsWidget = new Gtk.Box();

    // Add a widget to the container, usually a preference row such as
    // AdwActionRow, AdwComboRow or AdwRevealerRow
    const label = new Gtk.Label({ label: `${Me.metadata.name}` });
    prefsWidget.append(label);

    return prefsWidget;
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

    const adVolumeRow = new Adw.ActionRow({
        title: 'Volume percentage for ads',
        subtitle: 'Volume percentage to use when ads are playing',
    });
    prefsGroup.add(adVolumeRow);

    const settings = ExtensionUtils.getSettings();

    const adVolumeInput = Gtk.SpinButton.new_with_range(0, 100, 1);
    // Without this, the number input expands to fill all the vertical space
    adVolumeInput.set_valign(Gtk.Align.CENTER);
    settings.bind('ad-volume-percentage', adVolumeInput, 'value',
        Gio.SettingsBindFlags.DEFAULT)

    adVolumeRow.add_suffix(adVolumeInput);
    adVolumeRow.set_activatable_widget(adVolumeInput);
}
