mod api;
mod auth;
mod crypto;
mod install;
mod models;
mod storage;
mod supervision;
mod tray;
mod trust;
mod updater_config;

use models::{
    AuthOutcome, DesktopPreferences, DeviceApprovalProgress, LocalStatus, PossessionProgress,
};
use serde::Serialize;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
struct AppServices {
    ceremonies: trust::DeviceCeremonies,
    possession: install::PossessionManager,
}

fn command_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
fn app_preferences() -> Result<DesktopPreferences, String> {
    storage::load_preferences().map_err(command_error)
}

#[tauri::command]
fn choose_server(server_url: &str) -> Result<String, String> {
    let normalized = storage::normalize_server_url(server_url)?;
    let mut preferences = storage::load_preferences().map_err(command_error)?;
    if preferences.server_origin != normalized {
        preferences = DesktopPreferences {
            server_origin: normalized.clone(),
            ..Default::default()
        };
    }
    storage::save_preferences(&preferences).map_err(command_error)?;
    Ok(normalized)
}

#[tauri::command]
async fn password_login(origin: &str, email: &str, password: &str) -> Result<AuthOutcome, String> {
    auth::password_login(origin, email, password)
        .await
        .map_err(command_error)
}

#[tauri::command]
async fn password_signup(
    origin: &str,
    email: &str,
    password: &str,
    invite: Option<&str>,
) -> Result<AuthOutcome, String> {
    auth::password_signup(origin, email, password, invite)
        .await
        .map_err(command_error)
}

#[tauri::command]
fn oauth_start_url(origin: &str, provider: &str, invite: Option<&str>) -> Result<String, String> {
    auth::oauth_start_url(origin, provider, invite).map_err(command_error)
}

#[tauri::command]
async fn exchange_oauth_code(origin: &str, code: &str) -> Result<AuthOutcome, String> {
    auth::exchange_oauth_code(origin, code)
        .await
        .map_err(command_error)
}

#[tauri::command]
async fn renew_session() -> Result<(), String> {
    auth::renew_session().await.map_err(command_error)
}

#[tauri::command]
async fn poll_device_approval(
    services: tauri::State<'_, AppServices>,
) -> Result<DeviceApprovalProgress, String> {
    services.ceremonies.poll().await.map_err(command_error)
}

#[tauri::command]
async fn ask_for_device_approval() -> Result<(), String> {
    trust::raise_knock().await.map_err(command_error)
}

#[tauri::command]
async fn begin_possession(
    app: tauri::AppHandle,
    services: tauri::State<'_, AppServices>,
) -> Result<String, String> {
    services.possession.begin(&app).await.map_err(command_error)
}

#[tauri::command]
async fn poll_possession(
    app: tauri::AppHandle,
    services: tauri::State<'_, AppServices>,
    claim_token: &str,
) -> Result<PossessionProgress, String> {
    services
        .possession
        .poll(&app, claim_token)
        .await
        .map_err(command_error)
}

#[tauri::command]
async fn approve_possession(
    app: tauri::AppHandle,
    services: tauri::State<'_, AppServices>,
    claim_token: &str,
    fingerprint_confirmed: bool,
) -> Result<String, String> {
    services
        .possession
        .approve(&app, claim_token, fingerprint_confirmed)
        .await
        .map_err(command_error)
}

#[tauri::command]
fn terminal_install_command() -> Result<String, String> {
    let preferences = storage::load_preferences().map_err(command_error)?;
    Ok(install::installer_command(&preferences.server_origin))
}

#[tauri::command]
async fn local_status(app: tauri::AppHandle, include_doctor: bool) -> Result<LocalStatus, String> {
    let status = supervision::local_status(include_doctor)
        .await
        .map_err(command_error)?;
    tray::update(&app, &status);
    Ok(status)
}

#[tauri::command]
async fn possession_log_tail(
    services: tauri::State<'_, AppServices>,
    claim_token: &str,
) -> Result<String, String> {
    Ok(services.possession.log_tail(claim_token).await)
}

#[tauri::command]
async fn repair_resume() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(supervision::repair_resume)
        .await
        .map_err(command_error)?
        .map_err(command_error)
}

#[tauri::command]
async fn stop_possessing() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(supervision::stop_possessing)
        .await
        .map_err(command_error)?
        .map_err(command_error)
}

#[derive(Serialize)]
struct AppUpdateStatus {
    available: bool,
    version: Option<String>,
    endpoint: &'static str,
}

#[tauri::command]
async fn check_app_update(app: tauri::AppHandle) -> Result<AppUpdateStatus, String> {
    let update = app
        .updater()
        .map_err(command_error)?
        .check()
        .await
        .map_err(command_error)?;
    tray::set_app_update_available(&app, update.is_some());
    Ok(AppUpdateStatus {
        available: update.is_some(),
        version: update.map(|value| value.version),
        endpoint: updater_config::configured_endpoint(),
    })
}

#[tauri::command]
async fn install_app_update(app: tauri::AppHandle) -> Result<bool, String> {
    let Some(update) = app
        .updater()
        .map_err(command_error)?
        .check()
        .await
        .map_err(command_error)?
    else {
        return Ok(false);
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(command_error)?;
    Ok(true)
}

#[tauri::command]
fn sign_out() -> Result<(), String> {
    let mut preferences = storage::load_preferences().map_err(command_error)?;
    storage::clear_token(&preferences.server_origin).map_err(command_error)?;
    preferences.account_id = None;
    preferences.account_email = None;
    preferences.device_id = None;
    preferences.device_approved = false;
    storage::save_preferences(&preferences).map_err(command_error)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppServices::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray::install(app)?;
            if let Some(window) = app.get_webview_window("main") {
                let close_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = close_window.hide();
                    }
                });
                if !storage::load_preferences()
                    .unwrap_or_default()
                    .first_run_complete
                {
                    window.show()?;
                    window.set_focus()?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_preferences,
            choose_server,
            password_login,
            password_signup,
            oauth_start_url,
            exchange_oauth_code,
            renew_session,
            poll_device_approval,
            ask_for_device_approval,
            begin_possession,
            poll_possession,
            approve_possession,
            terminal_install_command,
            local_status,
            possession_log_tail,
            repair_resume,
            stop_possessing,
            check_app_update,
            install_app_update,
            sign_out,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building SPAWN D desktop");
    app.run(|_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            // Explicit Quit SPAWN D exits. Closing the only window is handled
            // above and leaves the menu-bar companion running.
        }
    });
}
