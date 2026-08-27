//! The one window.
//!
//! SPAWN D has a single window with two faces. Until this Mac is possessed the
//! window is the wizard: the bundled sign-in and possession pages, with IPC.
//! After that it is the product: the web app from the chosen server, loaded
//! into the same window, signed in by way of the cookie the server sets when
//! the session is renewed — no token reaches page script, and the remote page
//! gets no IPC because no capability names a remote URL. Whether that cookie
//! is one the webview will actually send is a question with a sharp edge on
//! macOS; see [`session_cookie`], and [`handover_step`] for what happens when
//! the answer is no. Any navigation off the chosen origin, and any
//! `window.open`, goes to the system browser. Settings and repair turn the
//! window back into the wizard; the product is one click away again.
//!
//! The webview also wears a user agent the web app can recognise, so the
//! product face can drop the chrome that would walk someone out of the app and
//! into a website ([`USER_AGENT`]).

use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::webview::cookie::Cookie;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    App, AppHandle, Emitter, LogicalSize, Manager, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

use crate::{auth, storage};

pub const LABEL: &str = "main";
const SESSION_COOKIE: &str = "spawn_session";
/// A week, the same life the server gives the cookie it sets.
const SESSION_MAX_AGE: u32 = 60 * 60 * 24 * 7;
/// The door a carried session is let in through; see [`show_product`].
const DOOR_PATH: &str = "/login";
/// The product's own path on the chosen origin.
const APP_PATH: &str = "/app";
/// What this file says when it says anything, so a run can be read back out of
/// `RUST_LOG`-less stderr with one grep.
const LOG: &str = "spawn-d window";
/// The webview's user agent.
///
/// The web app drops its marketing chrome when it sees the token on the end of
/// this — "Back home", the masthead, the colophon, the brand mark that leaves
/// the product — because inside this window those are doors into a website
/// with no way back. That signal has to survive every navigation the product
/// makes, which is why it rides the agent rather than a query parameter. wry
/// can only *replace* WKWebView's agent, never append to it, so this restates
/// Safari's agent and puts ours last, where a product token belongs.
///
/// Everything before `Version/` is frozen by WebKit itself and has been for
/// years — the app is a WKWebView, and anything sniffing for one still gets
/// the right answer. `Version/` is the only part that tracks a release; it is
/// stated rather than detected because the agent is fixed when the webview is
/// built, and there is no way to read WebKit's own first. Behind by a release
/// is harmless; the token that matters is the last one.
const USER_AGENT: &str = concat!(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ",
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15 ",
    "SpawnDesktop/",
    env!("CARGO_PKG_VERSION"),
);
// The gates are two columns — masthead ranged against the plate — from 1024px
// up (`src/styles.css`), which is the web's own breakpoint. Below it they
// stack, so a window narrower than that silently gave the app a layout the
// browser never shows. 384 head + 576 plate + 64 gap + 80 padding = 1104.
const WIZARD_SIZE: (f64, f64) = (1120.0, 840.0);
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
        .user_agent(USER_AGENT)
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
        // A session the cookie store would not take is waiting for a page on
        // the origin to carry it; this is the first moment there is one. Only
        // a page on that origin will do — handed to the wizard's own
        // `tauri://` page it would be spent on nothing.
        .on_page_load(move |window, payload| {
            let Some(pending) = window.app_handle().try_state::<PendingHandover>() else {
                return;
            };
            let Ok(mut held) = pending.0.lock() else {
                eprintln!("{LOG}: the handover lock is poisoned");
                return;
            };
            if matches!(*held, Handover::Idle | Handover::Done) {
                return;
            }
            let Ok(origin) = storage::load_preferences()
                .and_then(|preferences| Ok(Url::parse(&preferences.server_origin)?))
            else {
                eprintln!("{LOG}: no server origin to hand the session to");
                return;
            };
            if !same_origin(payload.url(), &origin) {
                return;
            }
            let (step, next) = handover_step(&held, payload.event());
            *held = next;
            drop(held);
            if let Some(script) = handover_script(&step) {
                eprintln!("{LOG}: handing the session to the page ({})", step.name());
                if let Err(error) = window.eval(&script) {
                    eprintln!("{LOG}: could not hand the session to the page: {error}");
                }
            }
        })
        .build()
        .context("creating the SPAWN D window")?;
    app.manage(WizardHome(home));
    app.manage(PendingHandover(Mutex::new(Handover::Idle)));
    let handle = app.handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // Closing leaves SPAWN D in the menu bar; no Dock tile meanwhile.
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

/// Whatever this Mac is up to: the product once it is possessed, else the
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
    let mut carry_in_page: Option<String> = None;
    if preferences.account_id.is_some() {
        match auth::browser_session_cookie().await {
            Ok(Some(header)) => match session_cookie(&header, &origin) {
                Ok(cookie) => {
                    let carried = cookie.value().to_owned();
                    let written = window.set_cookie(cookie);
                    if let Err(error) = &written {
                        eprintln!("{LOG}: the cookie store refused the session: {error}");
                    }
                    if written.is_ok() && cookie_landed(&window, &origin) {
                        eprintln!("{LOG}: the cookie store took the session");
                    } else {
                        eprintln!(
                            "{LOG}: the store holds no session it will send to {}; the page will carry it",
                            origin.host_str().unwrap_or("this server")
                        );
                        // Whatever it did keep has to go first. It is
                        // `HttpOnly`, and a page cannot overwrite one of those
                        // — leave it there and the handover below is refused
                        // in silence, which is how this failed before.
                        clear_stored_session(&window, &origin);
                        carry_in_page = Some(carried);
                    }
                }
                Err(error) => eprintln!("{LOG}: could not read the session cookie: {error:#}"),
            },
            Ok(None) => eprintln!("{LOG}: the server set no session cookie"),
            Err(error) => eprintln!("{LOG}: continuing without a browser session: {error:#}"),
        }
    } else {
        eprintln!("{LOG}: no account on this Mac; opening the product signed out");
    }
    let (width, height) = product_size(app);
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.center();
    let mut target = origin.clone();
    if let Some(token) = carry_in_page {
        match app.state::<PendingHandover>().0.lock() {
            Ok(mut held) => *held = Handover::Waiting(token),
            Err(_) => eprintln!("{LOG}: the handover lock is poisoned; opening signed out"),
        }
        // Land on the origin's own sign-in page rather than /app: it is the
        // lightest document there, and it is where this ends up anyway if the
        // handover cannot be completed — so nothing flashes backwards.
        target.set_path(DOOR_PATH);
    } else {
        target.set_path(APP_PATH);
    }
    eprintln!("{LOG}: opening {target}");
    window.navigate(target).context("opening the SPAWN D app")?;
    front(app);
    Ok(())
}

/// A session this webview's cookie store would not carry, and how far the page
/// itself has got with it (see [`handover_step`]).
#[derive(PartialEq, Eq)]
enum Handover {
    /// Nothing to hand over.
    Idle,
    /// Waiting for a page on the chosen origin to take the session.
    Waiting(String),
    /// The page holds the cookie; it still has to be sent to the product.
    Seeded,
    /// Handed over, and the page sent on its way.
    Done,
}

impl std::fmt::Debug for Handover {
    /// Redacted by hand: `Waiting` holds a live session, and a derived `{:?}`
    /// anywhere near a log or an assertion message would print it.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Handover::Idle => "Idle",
            Handover::Waiting(_) => "Waiting(…)",
            Handover::Seeded => "Seeded",
            Handover::Done => "Done",
        })
    }
}

struct PendingHandover(Mutex<Handover>);

/// What a page on the chosen origin is told at this beat of its load, and what
/// the handover becomes as a result.
///
/// Two beats, because they want two different moments. The cookie goes in as
/// soon as the document exists — `Started` is WebKit's `didCommitNavigation`,
/// the same beat wry injects its own scripts at — and the jump to the product
/// waits for the load to finish, which is the one moment a `location.replace`
/// is certain not to cut a navigation still in flight. A `Started` that never
/// arrives is not a dead end: `Finished` then does both.
fn handover_step(state: &Handover, event: PageLoadEvent) -> (Step, Handover) {
    match (state, event) {
        (Handover::Waiting(token), PageLoadEvent::Started) => {
            (Step::Seed(token.clone()), Handover::Seeded)
        }
        (Handover::Waiting(token), PageLoadEvent::Finished) => {
            (Step::SeedAndEnter(token.clone()), Handover::Done)
        }
        (Handover::Seeded, PageLoadEvent::Finished) => (Step::Enter, Handover::Done),
        (Handover::Seeded, PageLoadEvent::Started) => (Step::Nothing, Handover::Seeded),
        (Handover::Idle, _) => (Step::Nothing, Handover::Idle),
        (Handover::Done, _) => (Step::Nothing, Handover::Done),
    }
}

/// The one thing to do to the page at this beat.
#[derive(PartialEq, Eq)]
enum Step {
    Nothing,
    Seed(String),
    Enter,
    SeedAndEnter(String),
}

impl Step {
    /// A name for the log. The token is a live session — it is never printed,
    /// which is also why this type carries no `Debug`.
    fn name(&self) -> &'static str {
        match self {
            Step::Nothing => "nothing",
            Step::Seed(_) => "cookie",
            Step::Enter => "enter",
            Step::SeedAndEnter(_) => "cookie and enter",
        }
    }
}

/// Whether a cookie in the store is this origin's session.
///
/// The host is matched rather than trusted from a filter: a stored cookie's
/// domain comes back lower-cased, and a domain cookie may carry a leading dot.
/// The last clause is the trap in [`session_cookie`], caught from the other
/// side — a `Secure` cookie on an `http` origin is in the jar and will never
/// leave it.
fn is_session_for(cookie: &Cookie<'_>, origin: &Url, host: &str) -> bool {
    cookie.name() == SESSION_COOKIE
        && cookie
            .domain()
            .is_some_and(|domain| domain.trim_start_matches('.').eq_ignore_ascii_case(host))
        && (origin.scheme() == "https" || cookie.secure() != Some(true))
}

/// Whether the store now holds a session this webview will actually send.
///
/// It asks for every cookie rather than using `cookies_for_url`, which filters
/// wry's own list in Rust and waves a `Secure` cookie through on `localhost` —
/// so the one cookie the network stack would never attach read back as
/// "landed". That was half of why the window opened `/app` with no session and
/// the web app bounced it to `/login`.
fn cookie_landed(window: &WebviewWindow, origin: &Url) -> bool {
    let Some(host) = origin.host_str() else {
        return false;
    };
    match window.cookies() {
        Ok(cookies) => cookies
            .iter()
            .any(|cookie| is_session_for(cookie, origin, host)),
        Err(error) => {
            eprintln!("{LOG}: could not read back the session cookie: {error}");
            false
        }
    }
}

/// Take every session cookie this origin has out of the store.
///
/// Only ever called on the way to the in-page handover, and it is what makes
/// that handover possible: the cookie already in the jar is `HttpOnly`, a page
/// cannot overwrite one of those, and `document.cookie` fails silently when it
/// tries. Proven with a WKWebView probe — with the `HttpOnly` twin present the
/// page's write is dropped without a word; with the jar clear the same write
/// sticks and rides the very next request.
fn clear_stored_session(window: &WebviewWindow, origin: &Url) {
    let Some(host) = origin.host_str() else {
        return;
    };
    let Ok(cookies) = window.cookies() else {
        return;
    };
    for cookie in cookies
        .into_iter()
        .filter(|cookie| cookie.name() == SESSION_COOKIE && domain_is(cookie, host))
    {
        if let Err(error) = window.delete_cookie(cookie) {
            eprintln!("{LOG}: could not clear the stored session: {error}");
        }
    }
}

fn domain_is(cookie: &Cookie<'_>, host: &str) -> bool {
    cookie
        .domain()
        .is_some_and(|domain| domain.trim_start_matches('.').eq_ignore_ascii_case(host))
}

/// The script that hands the session to a page already on the origin.
///
/// The last resort, for a store that would not keep the session at all. The
/// webview's own cookie jar takes what a page sets for its own origin — the
/// same path a browser takes for any site — but only while nothing `HttpOnly`
/// holds the name, which is why [`clear_stored_session`] runs first. The
/// session is a bearer token either way; what it loses here is `HttpOnly`, and
/// only inside this app's webview. The alternative was the sign-in page after
/// a possession that had just succeeded.
fn handover_script(step: &Step) -> Option<String> {
    let enter = format!("location.replace('{APP_PATH}');");
    match step {
        Step::Nothing => None,
        Step::Seed(token) => Some(cookie_script(token)),
        Step::Enter => Some(enter),
        Step::SeedAndEnter(token) => Some(format!("{}{enter}", cookie_script(token))),
    }
}

fn cookie_script(token: &str) -> String {
    // Values are opaque JWTs, but never build a script by trusting that.
    let quoted = serde_json::to_string(&format!(
        "{SESSION_COOKIE}={token}; path=/; max-age={SESSION_MAX_AGE}; samesite=lax"
    ))
    .unwrap_or_else(|_| "\"\"".to_owned());
    format!("document.cookie = {quoted};")
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
    Url::parse("tauri://localhost/").expect("a fixed URL parses")
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
///
/// `Secure` is set only when it is true, and is otherwise left unstated — the
/// one line this whole file used to turn on. wry writes the flag into
/// `NSHTTPCookieSecure` whenever it is set *at all*, and CFNetwork reads the
/// **presence** of that key as "this cookie is secure" no matter what value it
/// carries. So `set_secure(false)` on an `http` server minted a Secure cookie,
/// which the webview then stored and never sent — every local run, every
/// self-hosted server on plain http. Verified with a WKWebView probe against a
/// local server: two cookies differing only in that key, and only the one
/// carrying it is dropped. `Some(true)` is safe; `Some(false)` never is.
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
    if origin.scheme() == "https" {
        cookie.set_secure(true);
    } else {
        cookie.set_secure(None);
    }
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
        let home = Url::parse("tauri://localhost/").unwrap();
        assert!(same_origin(
            &Url::parse("tauri://localhost/index.html#settings").unwrap(),
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
        assert!(session_cookie("other=x", &origin).is_err());
    }

    #[test]
    fn an_http_server_never_gets_a_cookie_marked_secure() {
        // The bug this file exists to remember: wry writes `Secure` into the
        // NSHTTPCookie properties whenever it is *set*, and CFNetwork reads
        // the presence of that key as "secure" whatever the value — so
        // `Some(false)` on an http origin minted a Secure cookie the webview
        // stored and would never send. Unstated is the only safe answer.
        for value in [
            "http://localhost:3000",
            "http://mac-mini:8010",
            "http://mac-mini.local:8010",
            "http://127.0.0.1:3000",
            "http://192.168.1.24:3000",
        ] {
            let origin = Url::parse(value).unwrap();
            let cookie = session_cookie("spawn_session=x; HttpOnly; Path=/", &origin).unwrap();
            assert_eq!(cookie.secure(), None, "{value} must not state Secure");
            // Everything else the server said still stands.
            assert_eq!(cookie.http_only(), Some(true));
            assert_eq!(cookie.domain(), origin.host_str());
        }
        // A server that wrongly sent `Secure` over http is corrected too: kept,
        // the cookie could never reach it.
        let plain = session_cookie(
            "spawn_session=x; Path=/; Secure",
            &Url::parse("http://localhost:8010").unwrap(),
        )
        .unwrap();
        assert_eq!(plain.secure(), None);
        // Over https it is stated, whether or not the server bothered to.
        for header in ["spawn_session=x; Path=/", "spawn_session=x; Path=/; Secure"] {
            let secure =
                session_cookie(header, &Url::parse("https://spawnd.dev").unwrap()).unwrap();
            assert_eq!(secure.secure(), Some(true));
        }
    }

    #[test]
    fn a_session_the_webview_would_not_send_does_not_count_as_landed() {
        let plain = Url::parse("http://localhost:3000").unwrap();
        let hosted = Url::parse("https://spawnd.dev").unwrap();
        let cookie = |header: &str| Cookie::parse(header.to_owned()).unwrap();

        // What the fix now writes on http: no Secure, so the store will send it.
        assert!(is_session_for(
            &cookie("spawn_session=x; Domain=localhost; Path=/"),
            &plain,
            "localhost"
        ));
        // What the bug wrote. It is in the jar, and it is not a session.
        assert!(!is_session_for(
            &cookie("spawn_session=x; Domain=localhost; Path=/; Secure"),
            &plain,
            "localhost"
        ));
        // Over https, Secure is exactly right.
        assert!(is_session_for(
            &cookie("spawn_session=x; Domain=spawnd.dev; Path=/; Secure"),
            &hosted,
            "spawnd.dev"
        ));
        // The store answers in its own case, and a domain cookie may lead with
        // a dot; neither makes it somebody else's cookie.
        assert!(is_session_for(
            &cookie("spawn_session=x; Domain=.Charlies-MacBook-Pro.local; Path=/"),
            &Url::parse("http://charlies-macbook-pro.local:8010").unwrap(),
            "charlies-macbook-pro.local"
        ));
        // Another host's session, and another cookie entirely.
        assert!(!is_session_for(
            &cookie("spawn_session=x; Domain=evil.example; Path=/"),
            &plain,
            "localhost"
        ));
        assert!(!is_session_for(
            &cookie("other=x; Domain=localhost; Path=/"),
            &plain,
            "localhost"
        ));
    }

    #[test]
    fn the_page_takes_the_cookie_first_and_the_product_after() {
        // The ordinary run: the document commits, takes the cookie, and is
        // sent on once it has finished loading.
        let waiting = Handover::Waiting("tok".to_owned());
        let (step, next) = handover_step(&waiting, PageLoadEvent::Started);
        assert!(matches!(step, Step::Seed(ref token) if token == "tok"));
        assert_eq!(next, Handover::Seeded);
        let (step, next) = handover_step(&next, PageLoadEvent::Finished);
        assert!(step == Step::Enter);
        assert_eq!(next, Handover::Done);
        // Spent once. Every later page load on the origin — the product's own
        // — passes straight through.
        assert!(handover_step(&next, PageLoadEvent::Started).0 == Step::Nothing);
        assert!(handover_step(&next, PageLoadEvent::Finished).0 == Step::Nothing);
        // A missed `Started` is not a dead end.
        let (step, next) = handover_step(&waiting, PageLoadEvent::Finished);
        assert!(matches!(step, Step::SeedAndEnter(ref token) if token == "tok"));
        assert_eq!(next, Handover::Done);
        // A second commit before the first load finished must not spend it.
        assert!(handover_step(&Handover::Seeded, PageLoadEvent::Started).0 == Step::Nothing);
        // Nothing waiting, nothing said.
        assert!(handover_step(&Handover::Idle, PageLoadEvent::Finished).0 == Step::Nothing);
    }

    #[test]
    fn the_handover_script_sets_one_cookie_and_never_trusts_the_value() {
        assert!(handover_script(&Step::Nothing).is_none());
        let seed = handover_script(&Step::Seed("abc.def".to_owned())).unwrap();
        assert_eq!(
            seed,
            "document.cookie = \"spawn_session=abc.def; path=/; max-age=604800; samesite=lax\";"
        );
        assert!(!seed.contains("location.replace"));
        assert_eq!(
            handover_script(&Step::Enter).unwrap(),
            "location.replace('/app');"
        );
        let both = handover_script(&Step::SeedAndEnter("abc.def".to_owned())).unwrap();
        assert!(both.starts_with(&seed) && both.ends_with("location.replace('/app');"));
        // A value carrying a quote is a value, not a statement: the quote is
        // escaped, so the literal it sits in still opens and closes exactly
        // once and nothing after it is ever read as code.
        let hostile = handover_script(&Step::Seed("\";alert(1);//".to_owned())).unwrap();
        assert!(hostile.contains(r#"\";alert(1);//"#));
        let unescaped = hostile.matches('"').count() - hostile.matches(r#"\""#).count();
        assert_eq!(unescaped, 2);
    }

    #[test]
    fn the_agent_says_which_app_this_is_without_lying_about_the_engine() {
        // Still a WKWebView on a Mac, which is what it is: every surface that
        // reads the platform has to keep working inside the app.
        assert!(USER_AGENT.starts_with("Mozilla/5.0 (Macintosh; Intel Mac OS X"));
        assert!(USER_AGENT.contains("AppleWebKit/605.1.15"));
        assert!(USER_AGENT.contains("Safari/605.1.15"));
        // The product token is last, and carries this build's version. The web
        // app matches on exactly this prefix (`web/src/lib/platform.ts`).
        let token = USER_AGENT.rsplit(' ').next().unwrap();
        assert_eq!(token, format!("SpawnDesktop/{}", env!("CARGO_PKG_VERSION")));
        assert!(token.starts_with("SpawnDesktop/"));
    }
}
