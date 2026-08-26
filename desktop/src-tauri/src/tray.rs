use anyhow::Result;
use tauri::image::Image;
use tauri::menu::{
    Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager, Wry};

/// The menu-bar mark: the brand trident, black on alpha, handed to macOS as a
/// template image so the system inverts it for a light menu bar and dims it
/// when the bar is inactive — the only correct way to wear a logo up there.
/// Bundled at compile time; the tray must be drawn before any file is read.
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray@2x.png");

pub struct TrayState {
    menu: Menu<Wry>,
    status: MenuItem<Wry>,
    sessions: Submenu<Wry>,
    daemon: MenuItem<Wry>,
    app_update: MenuItem<Wry>,
}

pub fn install(app: &mut App) -> Result<()> {
    let preferences = crate::storage::load_preferences().unwrap_or_default();
    let status_text = if preferences.first_run_complete {
        format!(
            "● {} — possessed, checking…",
            preferences.host_name.as_deref().unwrap_or("This Mac")
        )
    } else {
        "SPAWN D — setup needed".into()
    };
    let status = MenuItemBuilder::with_id("status", status_text)
        .enabled(false)
        .build(app)?;
    let open = MenuItemBuilder::with_id("open", "Open SPAWN D").build(app)?;
    let inspect_sessions =
        MenuItemBuilder::with_id("inspect-sessions", "Open SPAWN D to inspect sessions")
            .enabled(false)
            .build(app)?;
    let sessions = SubmenuBuilder::with_id(app, "sessions", "Sessions — checking…")
        .item(&inspect_sessions)
        .build()?;
    let daemon = MenuItemBuilder::with_id("daemon", "Daemon — checking…")
        .enabled(false)
        .build(app)?;
    let app_update = MenuItemBuilder::with_id("app-update", "Update SPAWN D…").build(app)?;
    let repair = MenuItemBuilder::with_id("repair", "Repair…").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit SPAWN D").build(app)?;
    let separator_one = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let separator_three = PredefinedMenuItem::separator(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[
            &status,
            &separator_one,
            &open,
            &sessions,
            &separator_two,
            &daemon,
            &repair,
            &settings,
            &separator_three,
            &quit,
        ])
        .build()?;
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(TRAY_ICON)?)
        .icon_as_template(true)
        .tooltip("SPAWN D")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = app.emit("tray-open-browser", ());
            }
            "repair" => show_surface(app, "repair"),
            "settings" => show_surface(app, "settings"),
            "app-update" => show_surface(app, "update"),
            "quit" => show_surface(app, "quit"),
            _ => {}
        })
        .build(app)?;
    app.manage(TrayState {
        menu,
        status,
        sessions,
        daemon,
        app_update,
    });
    Ok(())
}

pub fn set_app_update_available(app: &AppHandle, available: bool) {
    let state = app.state::<TrayState>();
    let present = state.menu.get("app-update").is_some();
    if available && !present {
        // Immediately after the daemon line, matching the product tray order.
        let _ = state.menu.insert(&state.app_update, 6);
    } else if !available && present {
        let _ = state.menu.remove(&state.app_update);
    }
}

fn show_surface(app: &AppHandle, surface: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("tray-surface", surface);
    }
}

pub fn update(app: &AppHandle, local: &crate::models::LocalStatus) {
    let state = app.state::<TrayState>();
    let host = local
        .status
        .get("host")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("This Mac");
    let instance = local.status.pointer("/instances/0");
    let connection = instance
        .and_then(|value| value.get("connection"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("not running");
    let online = local
        .heartbeat
        .as_ref()
        .is_some_and(|value| value.connected);
    let status = if online {
        "possessed, online"
    } else {
        connection
    };
    let _ = state.status.set_text(format!("● {host} — {status}"));
    let sessions = local.heartbeat.as_ref().map_or(0, |value| value.sessions);
    let _ = state
        .sessions
        .set_text(format!("Sessions — {sessions} running"));
    let version = instance
        .and_then(|value| value.get("version"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let update = instance
        .and_then(|value| value.get("update"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let _ = state
        .daemon
        .set_text(format!("Daemon {version} — {update}"));
}
