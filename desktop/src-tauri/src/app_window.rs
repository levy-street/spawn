//! The product itself, inside the app.
//!
//! The wizard possesses this Mac; everything after that — workspaces, the
//! wall of terminals, hosts, access — is the web app, and it runs here in its
//! own window, loaded from the chosen server, rather than in a browser tab.
//! The wizard's session becomes the browser session the web app expects by
//! way of the cookie the server sets when the session is renewed: no token is
//! ever handed to page script, and the page is given no IPC at all — it is
//! exactly the web app, printed on a window this app owns.

use anyhow::{Context, Result};
use tauri::webview::cookie::Cookie;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::{auth, storage};

pub const LABEL: &str = "app";
const SESSION_COOKIE: &str = "spawn_session";

pub async fn open(app: &AppHandle) -> Result<()> {
    let preferences = storage::load_preferences()?;
    let origin = Url::parse(&preferences.server_origin).context("parsing the server origin")?;
    // Mint the browser session first, while nothing is on screen: a window
    // that opened on the sign-in page and then jumped would read as a glitch.
    let cookie = if preferences.account_id.is_some() {
        match auth::browser_session_cookie().await {
            Ok(cookie) => cookie,
            Err(error) => {
                eprintln!("app window: continuing without a browser session: {error:#}");
                None
            }
        }
    } else {
        None
    };

    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => create(app, &origin)?,
    };
    if let Some(header) = cookie {
        match session_cookie(&header, &origin) {
            Ok(cookie) => {
                if let Err(error) = window.set_cookie(cookie) {
                    eprintln!("app window: could not hand over the session: {error}");
                }
            }
            Err(error) => eprintln!("app window: could not read the session cookie: {error:#}"),
        }
    }
    let mut app_url = origin.clone();
    app_url.set_path("/app");
    window
        .navigate(app_url)
        .context("opening the SPAWN D app")?;
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    window.show().context("showing the SPAWN D window")?;
    window.set_focus().context("focusing the SPAWN D window")?;
    Ok(())
}

fn create(app: &AppHandle, origin: &Url) -> Result<tauri::WebviewWindow> {
    // The first load is the cheapest page the origin serves, so the cookie
    // can be set before the app itself is ever requested.
    let mut warm = origin.clone();
    warm.set_path("/healthz");
    let allowed = origin.clone();
    let opener = app.clone();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(warm))
        .title("SPAWN D")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .visible(false)
        // The window is the web app and nothing else. A link to anywhere
        // else — docs, GitHub, a provider's sign-in — belongs in the system
        // browser, which also keeps third-party pages out of this view.
        .on_navigation(move |url| {
            if same_origin(url, &allowed) {
                return true;
            }
            let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            false
        })
        .build()
        .context("creating the SPAWN D window")?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            // Back to a menu-bar app: no Dock tile once the product is closed.
            #[cfg(target_os = "macos")]
            let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    });
    Ok(window)
}

fn same_origin(url: &Url, origin: &Url) -> bool {
    matches!(url.scheme(), "about" | "blob" | "data")
        || (url.scheme() == origin.scheme()
            && url.host_str() == origin.host_str()
            && url.port_or_known_default() == origin.port_or_known_default())
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
    fn only_the_chosen_origin_stays_inside_the_window() {
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
