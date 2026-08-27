//! The one window.
//!
//! SPAWN D has a single window with two faces. Until this computer is possessed the
//! window is the wizard: the bundled sign-in and possession pages, with IPC.
//! After that it is the product: the web app from the chosen server, loaded
//! into the same window, signed in by way of the cookie the server sets when
//! the session is renewed — no token reaches page script, and the remote page
//! gets no IPC because no capability names a remote URL. Any navigation off
//! the chosen origin, and any `window.open`, goes to the system browser.
//! Settings and repair turn the window back into the wizard; the product is
//! one click away again.

use anyhow::{Context, Result};
use tauri::webview::cookie::Cookie;
use tauri::webview::NewWindowResponse;
use tauri::{
    App, AppHandle, Emitter, LogicalSize, Manager, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

use crate::{auth, storage};

#[cfg(target_os = "windows")]
mod windows;

pub const LABEL: &str = "main";
const SESSION_COOKIE: &str = "spawn_session";
const WIZARD_SIZE: (f64, f64) = (960.0, 840.0);
const WIZARD_MIN_SIZE: (f64, f64) = (760.0, 640.0);
const PRODUCT_MIN_WIDTH: f64 = 1100.0;
const PRODUCT_MIN_HEIGHT: f64 = 720.0;
const PRODUCT_MAX_WIDTH: f64 = 1680.0;
const PRODUCT_MAX_HEIGHT: f64 = 1050.0;
/// The share of the screen's work area the product takes.
const PRODUCT_SHARE: f64 = 0.92;

/// Where the wizard lives — `tauri://localhost` in a build, the dev server
/// under `tauri dev` — so the window can be turned back into it.
struct WizardHome(Url);

pub fn create(app: &App) -> Result<WebviewWindow> {
    let home = wizard_home(app);
    let allowed_home = home.clone();
    let opener = app.handle().clone();
    let popup_opener = app.handle().clone();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("SPAWN D")
        .inner_size(WIZARD_SIZE.0, WIZARD_SIZE.1)
        .min_inner_size(WIZARD_MIN_SIZE.0, WIZARD_MIN_SIZE.1)
        .center()
        .visible(false)
        // The window is the wizard or the web app and nothing else. A link to
        // anywhere else — docs, GitHub, a provider's sign-in — belongs in the
        // system browser, which also keeps third-party pages out of this view.
        .on_navigation(move |url| {
            if stays_inside(url, &allowed_home) {
                return true;
            }
            let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            false
        })
        .on_new_window(move |url, _features| {
            let _ = popup_opener.opener().open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        })
        .build()
        .context("creating the SPAWN D window")?;
    #[cfg(target_os = "windows")]
    windows::append_user_agent(&window);
    app.manage(WizardHome(home));
    let handle = app.handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // Closing leaves SPAWN D in the platform's tray surface.
            api.prevent_close();
            if let Some(window) = handle.get_webview_window(LABEL) {
                let _ = window.hide();
            }
            #[cfg(target_os = "macos")]
            let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    });
    Ok(window)
}

/// Whatever this computer is up to: the product once it is possessed, else the
/// wizard where it was left.
pub async fn surface(app: &AppHandle) -> Result<()> {
    let possessed = storage::load_preferences()
        .map(|preferences| preferences.first_run_complete)
        .unwrap_or(false);
    if possessed {
        show_product(app).await
    } else {
        show_wizard(app, None)
    }
}

/// The web app from the chosen server, signed in, in this window.
pub async fn show_product(app: &AppHandle) -> Result<()> {
    let preferences = storage::load_preferences()?;
    let origin = Url::parse(&preferences.server_origin).context("parsing the server origin")?;
    let window = app
        .get_webview_window(LABEL)
        .context("the SPAWN D window is gone")?;
    if window.url().is_ok_and(|url| same_origin(&url, &origin)) {
        // Already the product: fronting it must not reload it and lose the
        // person's place.
        front(app);
        return Ok(());
    }
    // Mint the browser session first, while the wizard is still on screen: a
    // window that opened on the sign-in page and then jumped would read as a
    // glitch.
    if preferences.account_id.is_some() {
        match auth::browser_session_cookie().await {
            Ok(Some(header)) => match session_cookie(&header, &origin) {
                Ok(cookie) => {
                    if let Err(error) = window.set_cookie(cookie) {
                        eprintln!("window: could not hand over the session: {error}");
                    }
                }
                Err(error) => eprintln!("window: could not read the session cookie: {error:#}"),
            },
            Ok(None) => eprintln!("window: the server set no session cookie"),
            Err(error) => eprintln!("window: continuing without a browser session: {error:#}"),
        }
    }
    let (width, height) = product_size(app);
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.center();
    let mut app_url = origin.clone();
    app_url.set_path("/app");
    window
        .navigate(app_url)
        .context("opening the SPAWN D app")?;
    front(app);
    Ok(())
}

/// The bundled wizard in this window, on the surface asked for (settings,
/// repair, update, quit) or wherever it left off.
pub fn show_wizard(app: &AppHandle, surface: Option<&str>) -> Result<()> {
    let window = app
        .get_webview_window(LABEL)
        .context("the SPAWN D window is gone")?;
    let home = app.state::<WizardHome>().0.clone();
    if window.url().is_ok_and(|url| same_origin(&url, &home)) {
        if let Some(surface) = surface {
            app.emit("tray-surface", surface)
                .context("asking the wizard for a surface")?;
        }
    } else {
        // The product has the window: turn it back into the wizard, with the
        // surface in the hash for the page to read on load.
        let mut target = home;
        target.set_fragment(surface);
        let _ = window.set_size(LogicalSize::new(WIZARD_SIZE.0, WIZARD_SIZE.1));
        let _ = window.center();
        window
            .navigate(target)
            .context("returning to the SPAWN D wizard")?;
    }
    front(app);
    Ok(())
}

/// Show and focus the window, with a Dock tile while it is on screen.
pub fn front(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn wizard_home(app: &App) -> Url {
    if tauri::is_dev() {
        if let Some(url) = app.config().build.dev_url.clone() {
            return url;
        }
    }
    packaged_wizard_home()
}

fn packaged_wizard_home() -> Url {
    #[cfg(target_os = "windows")]
    const WIZARD_HOME: &str = "http://tauri.localhost/";
    #[cfg(not(target_os = "windows"))]
    const WIZARD_HOME: &str = "tauri://localhost/";
    Url::parse(WIZARD_HOME).expect("the fixed wizard origin parses")
}

/// Most of the screen, never more than it: a wall of terminals wants room,
/// so the product takes the work area less a margin, capped so a large
/// display gets a large window rather than a wall-to-wall one.
fn product_size(app: &AppHandle) -> (f64, f64) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return (1440.0, 900.0);
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area().size;
    fit(area.width as f64 / scale, area.height as f64 / scale)
}

fn fit(available_width: f64, available_height: f64) -> (f64, f64) {
    let width = (available_width * PRODUCT_SHARE)
        .clamp(PRODUCT_MIN_WIDTH.min(available_width), PRODUCT_MAX_WIDTH);
    let height = (available_height * PRODUCT_SHARE)
        .clamp(PRODUCT_MIN_HEIGHT.min(available_height), PRODUCT_MAX_HEIGHT);
    (width.round(), height.round())
}

/// Navigations that keep the window: the wizard's own pages and the chosen
/// server, read at the moment of navigation so a server switch takes effect.
fn stays_inside(url: &Url, home: &Url) -> bool {
    if matches!(url.scheme(), "about" | "blob" | "data") || same_origin(url, home) {
        return true;
    }
    storage::load_preferences()
        .ok()
        .and_then(|preferences| Url::parse(&preferences.server_origin).ok())
        .is_some_and(|origin| same_origin(url, &origin))
}

fn same_origin(url: &Url, origin: &Url) -> bool {
    url.scheme() == origin.scheme()
        && url.host_str() == origin.host_str()
        && url.port_or_known_default() == origin.port_or_known_default()
}

/// The server's `Set-Cookie`, as it would land in a browser: same name,
/// value, flags and lifetime, pinned to the origin's host so the webview's
/// cookie store accepts it.
fn session_cookie(header: &str, origin: &Url) -> Result<Cookie<'static>> {
    let mut cookie = Cookie::parse(header.to_owned()).context("parsing the session cookie")?;
    if cookie.name() != SESSION_COOKIE {
        anyhow::bail!("unexpected cookie {}", cookie.name());
    }
    if cookie.domain().is_none() {
        let host = origin
            .host_str()
            .context("the server origin has no host")?
            .to_owned();
        cookie.set_domain(host);
    }
    if cookie.path().is_none() {
        cookie.set_path("/");
    }
    cookie.set_secure(origin.scheme() == "https");
    Ok(cookie)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_product_takes_most_of_the_screen_and_never_more() {
        // A 14-inch MacBook Pro's work area, in points.
        assert_eq!(fit(1512.0, 945.0), (1391.0, 869.0));
        // A small external display: the minimums win, and still fit.
        assert_eq!(fit(1280.0, 800.0), (1178.0, 736.0));
        // A screen smaller than the minimums gets the screen.
        assert_eq!(fit(1024.0, 640.0), (1024.0, 640.0));
        // A big display is capped rather than wall-to-wall.
        assert_eq!(fit(2560.0, 1415.0), (1680.0, 1050.0));
    }

    #[test]
    fn only_the_wizard_and_the_chosen_origin_share_the_window() {
        let home = packaged_wizard_home();
        #[cfg(target_os = "macos")]
        assert_eq!(home.as_str(), "tauri://localhost/");
        #[cfg(target_os = "windows")]
        assert_eq!(home.as_str(), "http://tauri.localhost/");
        assert!(same_origin(
            &home.join("index.html#settings").unwrap(),
            &home
        ));
        let origin = Url::parse("https://spawnd.dev").unwrap();
        assert!(same_origin(
            &Url::parse("https://spawnd.dev/app").unwrap(),
            &origin
        ));
        assert!(same_origin(
            &Url::parse("https://spawnd.dev:443/w/1").unwrap(),
            &origin
        ));
        assert!(!same_origin(
            &Url::parse("http://spawnd.dev/app").unwrap(),
            &origin
        ));
        assert!(!same_origin(
            &Url::parse("https://accounts.google.com/o/oauth2").unwrap(),
            &origin
        ));
        assert!(!same_origin(
            &Url::parse("https://evil.spawnd.dev/").unwrap(),
            &origin
        ));
        let local = Url::parse("http://localhost:8010").unwrap();
        assert!(same_origin(
            &Url::parse("http://localhost:8010/app").unwrap(),
            &local
        ));
        assert!(!same_origin(
            &Url::parse("http://localhost:3000/app").unwrap(),
            &local
        ));
    }

    #[test]
    fn the_session_cookie_is_pinned_to_the_origin_as_the_server_set_it() {
        let origin = Url::parse("https://spawnd.dev").unwrap();
        let cookie = session_cookie(
            "spawn_session=abc.def; HttpOnly; Max-Age=2592000; Path=/; SameSite=lax; Secure",
            &origin,
        )
        .unwrap();
        assert_eq!(cookie.name(), "spawn_session");
        assert_eq!(cookie.value(), "abc.def");
        assert_eq!(cookie.domain(), Some("spawnd.dev"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(
            cookie.max_age().map(|age| age.whole_seconds()),
            Some(2_592_000)
        );
        let plain = session_cookie(
            "spawn_session=x; Path=/",
            &Url::parse("http://localhost:8010").unwrap(),
        )
        .unwrap();
        assert_eq!(plain.secure(), Some(false));
        assert!(session_cookie("other=x", &origin).is_err());
    }
}
