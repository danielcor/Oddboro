//! Oddboro for the Mac, Linux and Windows. A Tauri shell that runs the office
//! server (Node, as a sidecar) and shows it in a window. What it does, step by
//! step, is in `apps/desktop/CLAUDE.md`.

// A release on Windows is a windowed app, with no console window of its own.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod diagnostics;
mod env;
mod host;
mod secrets;
mod server;
mod update;

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::thread;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use diagnostics::Diagnostics;
use server::Server;

const MAIN: &str = "main";
const LOADING: &str = "loading";
/// What the owner is shown, and what an error report says, when the install
/// is broken.
const NO_NODE: &str = "Oddboro cannot find its copy of Node. Reinstall Oddboro.";
const NO_SERVER: &str = "Oddboro cannot find the office server. Reinstall Oddboro.";

/// Why the shell quit, as its exit code, so a script can tell without the
/// dialog the owner saw. The dialog's words go to the log too (`alert`).
mod exit {
    pub const PORT_TAKEN: i32 = 2;
    pub const NO_NODE: i32 = 3;
    pub const NO_SERVER: i32 = 4;
    pub const BAD_URL: i32 = 5;
    pub const SERVER_FAILED: i32 = 6;
    pub const NO_WINDOW: i32 = 7;
}

fn main() {
    // A version the updater just installed waits for the one it replaced.
    update::wait_for_old();
    let diagnostics = Diagnostics::find().map(Arc::new);
    if let Some(d) = &diagnostics {
        Arc::clone(d).watch_panics();
    }
    let builder = tauri::Builder::default();
    // Linux and Windows have no Dock to bring a hidden window back, so
    // opening Oddboro again shows the one that runs. It goes first, before
    // anything starts.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)));
    let app = builder
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let quitting = handle.clone();
            server::on_quit_signal(move || quitting.exit(0));
            // A Linux desktop may have no tray (GNOME without an extension).
            // The office runs without it, and opening Oddboro again shows it.
            if let Err(e) = tray(&handle) {
                server::note(&env::log_file(), &format!("no menu bar item: {e}"));
            }
            thread::spawn(move || start(&handle, diagnostics.as_deref()));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the office hides it and the office keeps running, while
            // the menu bar item can bring it back. With no tray to do that
            // (GNOME as it ships), closing quits Oddboro instead.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    if tray_shows() {
                        let _ = window.hide();
                        tell_page(window.app_handle(), "oddboro:hidden");
                    } else {
                        window.app_handle().exit(0);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Oddboro could not start");

    app.run(|app, event| match event {
        // The last window closed. The menu bar item keeps the app alive.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show(app),
        // Windows go first, so the wait for Node never shows a spinning wheel.
        RunEvent::Exit => {
            for window in app.webview_windows().values() {
                let _ = window.hide();
            }
            server::stop();
        }
        _ => {}
    });
}

/// Runs on its own thread: picks the server, starts it, and opens the office.
fn start(app: &AppHandle, diagnostics: Option<&Diagnostics>) {
    let version = &app.package_info().version;
    let target = env!("ODDBORO_TARGET");
    let pid = std::process::id();
    let port = env::port();
    // The dev escape hatch: open a server that already runs, such as vite dev.
    let server_url = std::env::var("ODDBORO_SERVER_URL").ok();
    let opens = opening(server_url.as_deref(), port);
    let home = env::office_home().display().to_string();
    let webview = tauri::webview_version().unwrap_or_else(|e| format!("unknown ({e})"));
    server::note(
        &env::log_file(),
        &format!(
            "Oddboro {version} ({target}) opening: pid {pid}, {opens}, home {home}, webview {webview}"
        ),
    );
    if let Some(url) = server_url {
        match Url::parse(&url) {
            Ok(url) => open_main(app, &url),
            Err(e) => fail(
                app,
                exit::BAD_URL,
                &format!("ODDBORO_SERVER_URL is not a URL: {e}"),
            ),
        }
        return;
    }

    // A newer version installs before the server starts, so an update never
    // swaps the server out from under a running office.
    if update::on_launch(app, &env::log_file(), show_updating) {
        return;
    }

    if server::port_taken(port) {
        alert(
            app,
            &format!(
                "Another office is already running on port {port}. Oddboro will quit rather than share it.\n\nQuit the other office, then open Oddboro again."
            ),
        );
        app.exit(exit::PORT_TAKEN);
        return;
    }
    let Some(node) = node_binary() else {
        return broken_install(app, diagnostics, exit::NO_NODE, NO_NODE);
    };
    let Some(code) = server_code(app) else {
        return broken_install(app, diagnostics, exit::NO_SERVER, NO_SERVER);
    };

    show_loading(app);
    let update_token = if update::ENABLED {
        update::token()
    } else {
        String::new()
    };
    let server = Server {
        node,
        code,
        port,
        path: env::login_path(),
        home: env::office_home(),
        log: env::log_file(),
        version: app.package_info().version.to_string(),
        update_token: update_token.clone(),
        diagnostics_dsn: diagnostics.map(|d| d.dsn().to_string()),
    };
    let Ok(url) = Url::parse(&server.url()) else {
        return fail(
            app,
            exit::BAD_URL,
            "Oddboro built a bad URL for its server.",
        );
    };
    update::watch(update::Watch {
        app: app.clone(),
        port,
        token: update_token,
        log: server.log.clone(),
        show: show_updating,
    });
    if let Err(why) = server.supervise(|| open_main(app, &url)) {
        if let Some(d) = diagnostics {
            d.gave_up(&why);
        }
        fail(app, exit::SERVER_FAILED, &why.message(&server.log_tail()));
    }
}

/// A release that lacks a part of itself: reported, since a broken release
/// is what reports are for, then shown to the owner.
fn broken_install(
    app: &AppHandle,
    diagnostics: Option<&Diagnostics>,
    code: i32,
    text: &'static str,
) {
    if let Some(d) = diagnostics {
        d.failed(text);
    }
    fail(app, code, text);
}

/// Node sits beside the shell: in `Contents/MacOS` on a Mac, in `usr/bin`
/// inside the AppImage, in the install folder on Windows. A debug build
/// without the bundle falls back to the copy the stage script leaves in
/// `binaries/`, named for this target.
fn node_binary() -> Option<PathBuf> {
    let exe = std::env::consts::EXE_SUFFIX;
    let beside = std::env::current_exe()
        .ok()?
        .parent()?
        .join(format!("node{exe}"));
    if beside.is_file() {
        return Some(beside);
    }
    dev_path(&format!("binaries/node-{}{exe}", env!("ODDBORO_TARGET")))
}

/// The staged server sits in the bundle's resources, `server/`. A debug build
/// without the bundle falls back to `apps/desktop/stage`.
fn server_code(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("server");
        if bundled.join(server::ENTRY).is_file() {
            return Some(bundled);
        }
    }
    dev_path("../stage").filter(|code| code.join(server::ENTRY).is_file())
}

/// Debug builds only. A release must not carry the builder's source folder,
/// which names their home folder, so the path is left out of it entirely.
#[cfg(debug_assertions)]
fn dev_path(relative: &str) -> Option<PathBuf> {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(relative)
        .canonicalize()
        .ok()
}

#[cfg(not(debug_assertions))]
fn dev_path(_relative: &str) -> Option<PathBuf> {
    None
}

fn show_loading(app: &AppHandle) {
    loading(app, "");
}

/// The office goes away and the loading window says "Updating Oddboro to X.Y.Z".
fn show_updating(app: &AppHandle, version: &str) {
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.hide();
    }
    loading(app, version);
}

/// The small loading window. `updating` is the version it updates to, or
/// empty while the office opens. `loading/loading.js` shows the words.
fn loading(app: &AppHandle, updating: &str) {
    let script = format!(
        "window.oddboroUpdating = {};",
        serde_json::Value::from(updating)
    );
    if let Some(window) = app.get_webview_window(LOADING) {
        let _ = window.eval(format!("{script} window.oddboroShow?.();"));
        let _ = window.show();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, LOADING, WebviewUrl::App("index.html".into()))
        .title("Oddboro")
        .inner_size(360.0, 200.0)
        .resizable(false)
        .center()
        .initialization_script(script)
        .build();
}

/// Opens the office in the main window, or reloads it after a restart.
fn open_main(app: &AppHandle, url: &Url) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.navigate(url.clone());
        return;
    }
    let home = url.clone();
    let built = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url.clone()))
        .title("Oddboro")
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .on_navigation(move |to| stay_or_open(&home, to))
        .on_new_window(|to, _| {
            open_in_browser(&to);
            NewWindowResponse::Deny
        })
        // The window's side of a start, for the log: the page itself says it
        // booted once its script runs (`apps/office/src/hooks.client.ts`).
        .on_page_load(|_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                server::note(
                    &env::log_file(),
                    &format!("office page loaded: {}", payload.url()),
                );
            }
        })
        .build();
    if let Some(loading) = app.get_webview_window(LOADING) {
        let _ = loading.close();
    }
    if let Err(e) = built {
        fail(
            app,
            exit::NO_WINDOW,
            &format!("Oddboro could not open its window: {e}"),
        );
    }
}

/// The office's own origin stays in the window. Links anywhere else open in
/// the default browser. Other schemes (about:, data:, blob:) stay put.
fn stay_or_open(home: &Url, to: &Url) -> bool {
    match to.scheme() {
        "http" | "https" if to.origin() == home.origin() => true,
        "http" | "https" | "mailto" | "tel" => {
            open_in_browser(to);
            false
        }
        _ => true,
    }
}

fn open_in_browser(url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        return;
    }
    let (opener, first) = OPENER;
    let spawned = crate::host::host_command(opener)
        .args(first)
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut open) = spawned {
        thread::spawn(move || open.wait());
    }
}

/// The system's own way to open a link in the default browser or mail app.
/// Windows goes through rundll32, not `cmd /c start`, so cmd never reads the
/// link's & as a command.
#[cfg(target_os = "macos")]
const OPENER: (&str, &[&str]) = ("/usr/bin/open", &[]);
#[cfg(target_os = "linux")]
const OPENER: (&str, &[&str]) = ("xdg-open", &[]);
#[cfg(windows)]
const OPENER: (&str, &[&str]) = ("rundll32", &["url.dll,FileProtocolHandler"]);

/// Brings the office forward, or the loading window while it starts.
fn show(app: &AppHandle) {
    let window = app
        .get_webview_window(MAIN)
        .or_else(|| app.get_webview_window(LOADING));
    if let Some(window) = window {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    tell_page(app, "oddboro:shown");
}

/// Tells the office page its window went to the tray or came back. Hidden,
/// the music pauses, since no control is in sight to stop it, and shown it
/// plays on (`apps/office/src/lib/ui/music.svelte.ts`).
fn tell_page(app: &AppHandle, event: &str) {
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.eval(format!("window.dispatchEvent(new Event('{event}'))"));
    }
}

/// The Mac always shows the menu bar item, and Windows the tray icon.
#[cfg(not(target_os = "linux"))]
fn tray_shows() -> bool {
    true
}

/// Whether the desktop shows tray items now: something owns the
/// StatusNotifierWatcher name on the session bus (KDE, most tiling setups,
/// GNOME with the AppIndicator extension).
#[cfg(target_os = "linux")]
fn tray_shows() -> bool {
    let Ok(bus) = zbus::blocking::Connection::session() else {
        return false;
    };
    bus.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "NameHasOwner",
        &("org.kde.StatusNotifierWatcher",),
    )
    .ok()
    .and_then(|reply| reply.body().deserialize::<bool>().ok())
    .unwrap_or(false)
}

/// The menu bar item (the tray on Linux and Windows): Open Oddboro, Open at
/// login, Quit Oddboro.
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Oddboro", true, None::<&str>)?;
    let at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let login =
        CheckMenuItem::with_id(app, "login", "Open at login", true, at_login, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Oddboro", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &login, &separator, &quit])?;
    TrayIconBuilder::with_id("oddboro")
        .icon(Image::from_bytes(TRAY_ICON)?)
        .icon_as_template(true)
        .tooltip("Oddboro")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show(app),
            "login" => toggle_open_at_login(app, &login),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// The Mac draws the black outline in the menu bar's own colour. Windows shows
/// a tray icon as drawn, so it gets the app's coloured icon, which shows on a
/// dark taskbar and a light one.
#[cfg(not(windows))]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");
#[cfg(windows)]
const TRAY_ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// Flips the LaunchAgent (an autostart entry on Linux, a Run entry in the
/// registry on Windows), then shows what the system actually has.
fn toggle_open_at_login(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let launcher = app.autolaunch();
    let _ = if launcher.is_enabled().unwrap_or(false) {
        launcher.disable()
    } else {
        launcher.enable()
    };
    let _ = item.set_checked(launcher.is_enabled().unwrap_or(false));
}

/// Shows an error. Only call it off the main thread: it waits for OK.
/// The words go to the log first, on one line: the dialog waits for someone to
/// press OK, which nobody does in a test or a support case.
fn alert(app: &AppHandle, message: &str) {
    let line = message.split_whitespace().collect::<Vec<_>>().join(" ");
    server::note(&env::log_file(), &format!("dialog: {line}"));
    app.dialog()
        .message(message)
        .title("Oddboro")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

fn fail(app: &AppHandle, code: i32, message: &str) {
    alert(app, message);
    app.exit(code);
}

/// What the launch line says the shell opens: the server `ODDBORO_SERVER_URL`
/// names, which leaves `ODDBORO_PORT` unused, or the port its own server takes.
fn opening(server_url: Option<&str>, port: u16) -> String {
    match server_url {
        Some(url) => format!("server {url}"),
        None => format!("port {port}"),
    }
}

#[cfg(test)]
mod tests {
    use super::opening;

    #[test]
    fn the_launch_line_names_what_the_shell_opens() {
        assert_eq!(
            opening(Some("http://127.0.0.1:4650"), 4500),
            "server http://127.0.0.1:4650"
        );
        assert_eq!(opening(None, 4590), "port 4590");
    }
}
