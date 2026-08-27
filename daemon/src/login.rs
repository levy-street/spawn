//! `spawnd login` — interactive device-code flow.
//!
//! Flow per `proto/README.md`:
//!   1. POST /api/auth/device/start  -> { device_code, approval_ref, verification_uri, … }
//!   2. Sign and POST /api/auth/device/possession for that exact ceremony.
//!   3. Only after proof succeeds, open/print the approval URL — with this
//!      host's public key appended LOCALLY as a `#k=` URL fragment, the
//!      out-of-band value the browser checks the server's claimed key against.
//!   4. Poll /api/auth/device/poll until success / expiry / denial.
//!   5. On success store {access_token, host_id, server_url}.

use std::io::IsTerminal;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use reqwest::StatusCode;
use zeroize::{Zeroize, Zeroizing};

use spawnd::host_pair_approval::{self, HostPairApprovalTranscript};
use spawnd::signed_signal::public_key_from_wire;

use crate::cli::LoginArgs;
use crate::config;
use crate::creds;
use crate::creds::HostIdentity;
use crate::proto::{
    DevicePollRequest, DevicePollResponse, DevicePossessionRequest, DevicePossessionResponse,
    DeviceStartRequest, DeviceStartResponse,
};

/// What a successful login learned — enough for `possess` to place this
/// registration in the authenticated account's config dir.
pub struct LoginOutcome {
    pub account_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("login interrupted")]
pub struct LoginInterrupted;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct UserFacingError(String);

/// The ceremony's own steps. `possess` runs the same three and appends its own.
pub const LOGIN_STEPS: [&str; 3] = [
    "Register this machine",
    "Approve in your browser",
    "Store credentials",
];

/// What the operator can do while the live region waits. Never a key prompt:
/// under `curl … | sh` the shell owns stdin and no keyboard is available.
pub const WAITING_HINT: &str = "ctrl-c to stop; nothing is registered";

pub fn ceremony_title() -> String {
    format!("POSSESSING {}", detect_hostname())
}

pub async fn run(server_cli: Option<String>, args: LoginArgs) -> Result<LoginOutcome> {
    let ui = crate::tui::Ui::start(&ceremony_title(), &LOGIN_STEPS, WAITING_HINT);
    let outcome = run_with_ui(server_cli, args, &ui).await;
    ui.finish();
    outcome
}

/// The ceremony proper, drawing into a caller-owned live region so `possess`
/// can carry the same frame through installing the background service.
pub async fn run_with_ui(
    server_cli: Option<String>,
    args: LoginArgs,
    ui: &crate::tui::Ui,
) -> Result<LoginOutcome> {
    ui.begin(0, "[ RUNNING ]");
    let force_qr = args.qr;
    let no_qr = args.no_qr;
    let no_browser = args.no_browser;
    // Persist before starting the ceremony so retries and interrupted logins
    // never rotate identity. A corrupt existing seed fails closed.
    let mut stored = creds::load().context("loading stored credentials")?;
    // Re-authenticating an existing instance targets the server it registered
    // with unless one is named explicitly; localhost is a fresh-install default.
    let server = config::server_url_for_instance(server_cli, stored.server_url.as_deref())?;
    let expected = creds::credential_revision(&stored)?;
    let identity = creds::ensure_host_identity(&mut stored)?;
    creds::save(&mut stored, &expected).context("persisting host identity")?;

    let host_name = args.host_name.unwrap_or_else(detect_hostname);
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let version = crate::version::build_version();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

    // 1. start
    let start_url = config::api_url(&server, "/api/auth/device/start")?;
    let start_req = DeviceStartRequest {
        host_name: &host_name,
        os: &os,
        arch: &arch,
        version: &version,
        host_key_algorithm: identity.algorithm,
        host_public_key: &identity.public_key,
    };
    let start_response = client
        .post(start_url.as_str())
        .json(&start_req)
        .send()
        .await
        .map_err(|error| connect_error(&server, &error))?;
    ensure_login_http_status(&server, start_response.status())?;
    let start: DeviceStartResponse = start_response
        .json()
        .await
        .map_err(|_| user_error(format!("{} answered, but it isn't a SPAWN D server. Re-run the install command from the app — it carries the right address.", server_origin(&server))))?;

    // Prove possession before activating the human-visible user code. The
    // private seed stays inside creds; only the fixed-width signature leaves.
    let possession_signature =
        creds::sign_host_pair_possession(&stored, &start.device_code, &start.approval_nonce)?;
    let possession_url = config::api_url(&server, "/api/auth/device/possession")?;
    let possession_response = client
        .post(possession_url.as_str())
        .json(&DevicePossessionRequest {
            device_code: &start.device_code,
            approval_nonce: &start.approval_nonce,
            host_key_algorithm: identity.algorithm,
            host_public_key: &identity.public_key,
            signature: &possession_signature,
        })
        .send()
        .await
        .map_err(|error| connect_error(&server, &error))?;
    ensure_login_http_status(&server, possession_response.status())?;
    let possession: DevicePossessionResponse = possession_response
        .json()
        .await
        .map_err(|_| user_error(format!("{} answered, but it isn't a SPAWN D server. Re-run the install command from the app — it carries the right address.", server_origin(&server))))?;
    if !possession.verified || possession.version != 1 {
        ui.fail(0, "unsupported server");
        return Err(anyhow!(
            "device/possession returned an unsupported verification state"
        ));
    }
    ui.complete(0, &host_name);

    // Match a browser login's ease: open the approval page directly, carrying a
    // handle so it lands on the approval with nothing to type, and poll to
    // completion ourselves. We bake the opaque approval_ref into the URL (the
    // short user_code never appears in a link); a pre-0029 server without a ref
    // falls back to the user_code. The URL additionally carries this host's
    // public key as a `#k=` fragment appended LOCALLY — see `approval_url` for
    // why that is the ceremony's out-of-band host-key check.
    let approve_url = approval_url(&server, &start, &identity.public_key)?;
    let opener_available = browser_opener_available();
    let browser_behavior =
        browser_behavior(std::io::stdin().is_terminal(), opener_available, no_browser);
    ui.begin(1, "[ WAITING FOR YOU ]");

    // The QR carries the full URL including the locally-appended #k= fragment.
    // A camera transfers it out of band; fragments never reach the HTTP server.
    //
    // The browser is no longer opened before this point, so the old
    // "did opening fail?" input is gone: the question is simply whether this
    // machine has a browser to offer at all. Headless hosts get the QR.
    let qr = (!no_qr && (force_qr || !opener_available))
        .then(|| render_qr(&approve_url).ok())
        .flatten();

    ui.block(
        approval_panel(
            false,
            &approve_url,
            ui.width(),
            browser_behavior.offer_enter,
        ),
        &approval_plain_lines(false, &approve_url, qr.as_deref()),
    );

    // A keyboard gets an explicit Enter offer; without one, launch immediately.
    // `--no-browser` suppresses both paths while leaving the link and QR rules
    // unchanged.
    if browser_behavior.offer_enter {
        // The panel above already carries the instruction, so the prompt
        // itself prints nothing — it only waits for the key.
        if crate::tui::press_enter("") && open_browser(&approve_url) {
            ui.log("opened your browser.");
        }
    } else if browser_behavior.open_immediately {
        open_browser(&approve_url);
    }
    if ui.is_rich() {
        if let Some(qr) = &qr {
            ui.block(qr.lines().map(str::to_owned).collect(), &[]);
        }
    }
    ui.status(&waiting_status(0, start.expires_in));

    // 2. poll
    let poll_url = config::api_url(&server, "/api/auth/device/poll")?;
    let mut interval = Duration::from_secs(start.interval.max(1));
    let started_waiting = tokio::time::Instant::now();
    let poll_body = DevicePollRequest {
        device_code: &start.device_code,
        host_key_algorithm: identity.algorithm,
        host_public_key: &identity.public_key,
    };

    let mut elapsed_shown = false;
    let mut hint_shown = false;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            interrupted = tokio::signal::ctrl_c() => {
                interrupted.context("ctrl-c handler")?;
                ui.fail(1, "approval stopped");
                crate::tui::log_line("stopped. Nothing was registered — run spawnd possess to start again.");
                return Err(LoginInterrupted.into());
            }
        }

        let elapsed = started_waiting.elapsed();
        // Rich mode carries elapsed and expiry continuously in the status line,
        // so the periodic reminders would only repeat what is already on screen.
        // Plain mode has no live line and keeps them, unchanged.
        if ui.is_rich() {
            ui.status(&waiting_status(elapsed.as_secs(), start.expires_in));
        } else {
            if !elapsed_shown && elapsed >= Duration::from_secs(30) {
                elapsed_shown = true;
                let remaining = start.expires_in.saturating_sub(elapsed.as_secs());
                let minutes = remaining.div_ceil(60);
                println!(
                    "spawn: still waiting — {} s elapsed (link expires in {minutes} min)",
                    elapsed.as_secs()
                );
            }
            if !hint_shown && elapsed >= Duration::from_secs(60) {
                hint_shown = true;
                println!("spawn: Still waiting — is the browser open? The link is above; it works on any device.");
            }
        }

        let resp = tokio::select! {
            response = client.post(poll_url.as_str()).json(&poll_body).send() => {
                match response {
                    Ok(response) => response,
                    Err(error) => {
                        ui.fail(1, "approval failed");
                        return Err(connect_error(&server, &error));
                    }
                }
            }
            interrupted = tokio::signal::ctrl_c() => {
                interrupted.context("ctrl-c handler")?;
                ui.fail(1, "approval stopped");
                crate::tui::log_line("stopped. Nothing was registered — run spawnd possess to start again.");
                return Err(LoginInterrupted.into());
            }
        };

        let status = resp.status();
        // 200 with body that may carry either {access_token, host_id} or {error: ...}.
        // Some servers return non-2xx for pending/denied; tolerate both.
        if !(status.is_success()
            || status == StatusCode::BAD_REQUEST
            || status == StatusCode::FORBIDDEN
            || status == StatusCode::GONE)
        {
            ui.fail(1, "approval failed");
            return Err(anyhow!("device/poll: HTTP {status}"));
        }
        let body: DevicePollResponse = match resp.json().await {
            Ok(body) => body,
            Err(error) => {
                ui.fail(1, "approval failed");
                return Err(error).context("decoding device/poll response");
            }
        };

        if poll_has_success_fields(&body) {
            let account_id = body.account_id.clone();
            let host_id = match commit_poll_success(
                &mut stored,
                body,
                &identity,
                &server,
                &start.approval_nonce,
                creds::save,
            ) {
                Ok(host_id) => host_id,
                Err(error) => {
                    ui.fail(1, "approval failed");
                    return Err(error);
                }
            };
            ui.complete(1, "approved");
            ui.complete(2, &format!("host {host_id}"));
            return Ok(LoginOutcome { account_id });
        }

        match body.error.as_deref() {
            Some("authorization_pending") | None => {}
            Some("slow_down") => {
                interval += Duration::from_secs(5);
                tracing::debug!(?interval, "server requested slow_down");
            }
            Some("expired_token") => {
                ui.fail(1, "approval expired");
                return Err(user_error("The approval expired before anyone finished it. Run spawnd possess again for a fresh one."));
            }
            Some("denied") => {
                ui.fail(1, "approval declined");
                return Err(user_error(
                    "The approval was declined in the browser. Nothing was registered.",
                ));
            }
            Some("key_conflict") => {
                ui.fail(1, "approval failed");
                return Err(user_error(key_conflict_copy()));
            }
            Some("pin_conflict") => {
                ui.fail(1, "approval failed");
                return Err(user_error("The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh."));
            }
            Some("pin_limit") => {
                ui.fail(1, "approval failed");
                return Err(user_error("This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again."));
            }
            Some(other) => {
                ui.fail(1, "approval failed");
                return Err(anyhow!("device/poll returned error: {other}"));
            }
        }
    }
}

/// The live-region panel for the approval: the only thing on screen the
/// operator has to act on, given its own frame so it stops competing with the
/// ceremony's commentary for attention.
///
/// It offers one thing: the link. There used to be a pairing code to type into
/// the app and this machine's fingerprint beside it, and together they read as
/// three ways to approve where there is one. The link carries the host's key
/// in its fragment, so the browser or phone that opens it checks the identity
/// itself — there is nothing here for a person to compare or to type.
fn approval_panel(
    browser_opened: bool,
    approve_url: &str,
    width: usize,
    interactive: bool,
) -> Vec<String> {
    use crate::tui::{bold, dim, hyperlink, render_panel, wrap_plain, wrap_words};
    let inner = width.saturating_sub(4);
    // Every row is wrapped to the frame's interior: prose by word, the URL by
    // force. An unwrapped row pushes the border out and the whole panel goes
    // ragged on a narrow terminal.
    let prose = |text: &str| -> Vec<String> {
        wrap_words(text, inner)
            .iter()
            .map(|l| dim(l, true))
            .collect()
    };
    let lead = if browser_opened {
        "opened your browser. didn't open? use this link on any device:"
    } else {
        "open this link on any device:"
    };
    let mut rows = vec![String::new()];
    rows.extend(prose(lead));
    // Every wrapped segment carries the same OSC 8 target, so the whole run is
    // clickable rather than just the first line.
    rows.extend(
        wrap_plain(approve_url, inner)
            .iter()
            .map(|line| hyperlink(approve_url, &bold(line, true), true)),
    );
    if interactive {
        // The instruction belongs beside the link it acts on, not adrift below
        // the progress frame where the next repaint would sit on top of it.
        rows.push(String::new());
        rows.push(bold("press Enter to open it here", true));
    }
    render_panel("APPROVE THIS HOST", &rows, width, true)
}

/// The one value on screen that has to be compared by eye, given the weight
/// that job deserves: its own line, bold and accented, with air around it.
///
/// A fingerprint set as dim inline prose is a security check dressed as
/// decoration — it reads as a serial number to skip past rather than the thing
/// standing between this machine and whoever else asked to hold it. Every
/// place one is shown for comparison uses this.
fn fingerprint_rows(fingerprint: &str, inner: usize) -> Vec<String> {
    use crate::tui::{accent, bold, wrap_plain};
    let mut rows = vec![String::new()];
    rows.extend(
        wrap_plain(fingerprint, inner.saturating_sub(4))
            .iter()
            .map(|line| format!("    {}", accent(&bold(line, true), true))),
    );
    rows.push(String::new());
    rows
}

/// The browser-side half of the ceremony's out-of-band check.
///
/// The server told us which browser approved this host; nothing it said proves
/// that browser is the reader's. Only the reader can close that gap, by
/// comparing this against what their browser shows under Access — so the ask
/// has to be legible, and has to say what a mismatch means.
fn browser_fingerprint_panel(fingerprint: &str, width: usize) -> Vec<String> {
    use crate::tui::{dim, render_panel, wrap_words};
    let inner = width.saturating_sub(4);
    let prose = |text: &str| -> Vec<String> {
        wrap_words(text, inner)
            .iter()
            .map(|l| dim(l, true))
            .collect()
    };
    let mut rows = vec![String::new()];
    rows.extend(prose(
        "the browser that approved this machine is pinned to it now. under Access it shows:",
    ));
    rows.extend(fingerprint_rows(fingerprint, inner));
    rows.extend(prose(
        "not what you see there? that approval came from somewhere else — remove this host in the app and start again.",
    ));
    render_panel("CHECK YOUR BROWSER SHOWS THIS", &rows, width, true)
}

/// The same check for pipes, CI and `NO_COLOR`.
fn browser_fingerprint_plain_lines(fingerprint: &str) -> Vec<String> {
    vec![
        "spawn: the browser that approved this machine is pinned to it now.".to_owned(),
        "spawn:   under Access it shows:".to_owned(),
        String::new(),
        format!("spawn:     {fingerprint}"),
        String::new(),
        "spawn:   not what you see there? that approval came from somewhere else —".to_owned(),
        "spawn:   remove this host in the app and start again.".to_owned(),
    ]
}

/// What piped output, CI and `NO_COLOR` see instead of the panel: the same
/// single offer — the link — with a line saying why there is nothing else to
/// compare or type. The pairing code used to be printed here too, and the
/// app's "enter a pairing code" screen existed only because this terminal
/// was the one place the code was shown; neither is a way in any more.
fn approval_plain_lines(browser_opened: bool, approve_url: &str, qr: Option<&str>) -> Vec<String> {
    let mut lines: Vec<String> = approval_link_block(browser_opened, approve_url)
        .trim_end_matches('\n')
        .lines()
        .map(str::to_owned)
        .collect();
    lines.push(String::new());
    if let Some(qr) = qr {
        lines
            .push("spawn:   Scan this with your phone, or open the link on any device:".to_owned());
        lines.push(String::new());
        lines.extend(qr.trim_end_matches('\n').lines().map(str::to_owned));
        lines.push(String::new());
    }
    lines.extend([
        "spawn:   the link carries this host's identity key (the part after '#');".to_owned(),
        "spawn:   your browser checks it automatically before asking you to approve.".to_owned(),
        String::new(),
        "spawn: waiting for approval…".to_owned(),
    ]);
    lines
}

/// The live status line, rebuilt each tick so elapsed and expiry stay current.
fn waiting_status(elapsed: u64, expires_in: u64) -> String {
    let minutes = expires_in.saturating_sub(elapsed).div_ceil(60);
    format!("waiting for approval — {elapsed}s · link expires in {minutes} min")
}

fn approval_link_block(browser_opened: bool, approve_url: &str) -> String {
    if browser_opened {
        format!(
            "spawn: opened your browser to approve this host.\n\
             spawn:   didn't open? use this link on any device:\n\
             spawn:   {approve_url}\n\n"
        )
    } else {
        format!(
            "spawn: approve this host in your browser — open this link on any device:\n\
             spawn:   {approve_url}\n\n"
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BrowserBehavior {
    offer_enter: bool,
    open_immediately: bool,
}

fn browser_behavior(
    interactive: bool,
    opener_available: bool,
    no_browser: bool,
) -> BrowserBehavior {
    if no_browser || !opener_available {
        BrowserBehavior {
            offer_enter: false,
            open_immediately: false,
        }
    } else if interactive {
        BrowserBehavior {
            offer_enter: true,
            open_immediately: false,
        }
    } else {
        BrowserBehavior {
            offer_enter: false,
            open_immediately: true,
        }
    }
}

/// Build the browser approval URL for this ceremony.
///
/// This URL is the possession ceremony's out-of-band channel (it travels
/// terminal→browser without passing through the server again), so two rules
/// are load-bearing:
///
/// 1. **The fragment is ours.** `#k=<host_public_key_wire>` is appended
///    locally from the key this daemon holds; `set_fragment` also overwrites
///    anything the server smuggled into `verification_uri`. Fragments are
///    never sent in HTTP requests, so the server cannot observe or rewrite
///    this value in flight — the browser compares the server's claimed host
///    key against it and refuses to pin on any difference.
/// 2. **Same origin or nothing.** A hostile server could otherwise point
///    `verification_uri` at a page it controls, read or replace the fragment
///    there, and bounce the human into the real approval page with a key of
///    its choosing. The approval page must live on the origin the operator
///    pointed this daemon at, or we refuse to continue.
fn approval_url(
    server: &url::Url,
    start: &DeviceStartResponse,
    host_public_key: &str,
) -> Result<String> {
    let mut parsed = url::Url::parse(&start.verification_uri).with_context(|| {
        format!(
            "the server sent an unusable approval page URL {:?}",
            start.verification_uri
        )
    })?;
    if parsed.origin() != server.origin() {
        bail!(
            "the server's approval page ({}) is not on the server this daemon was pointed at ({}); \
             refusing — a relay that redirects approval elsewhere could substitute the host key",
            parsed.origin().ascii_serialization(),
            server.origin().ascii_serialization(),
        );
    }
    match start.approval_ref.as_deref() {
        Some(reference) => parsed.query_pairs_mut().append_pair("ref", reference),
        None => parsed
            .query_pairs_mut()
            .append_pair("code", &start.user_code),
    };
    parsed.set_fragment(Some(&format!("k={host_public_key}")));
    Ok(parsed.to_string())
}

/// Best-effort: open `url` in the operator's default browser. Returns whether a
/// launcher was started. Never blocks and never fails login — on a headless host
/// (no display) or where no opener exists, the caller prints the URL instead.
fn open_browser(url: &str) -> bool {
    #[cfg(windows)]
    {
        crate::platform::open_url(url).is_ok()
    }
    #[cfg(not(windows))]
    use std::process::{Command, Stdio};
    #[cfg(not(windows))]
    let mut _cmd: Option<Command> = None;
    #[cfg(target_os = "macos")]
    {
        _cmd = Some(Command::new("open"));
    }
    #[cfg(target_os = "linux")]
    {
        // No display ⇒ headless (SSH/server): don't try; the caller prints it.
        if std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some() {
            _cmd = Some(Command::new("xdg-open"));
        }
    }
    #[cfg(not(windows))]
    match _cmd {
        Some(mut cmd) => cmd
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok(),
        None => false,
    }
}

fn browser_opener_available() -> bool {
    #[cfg(windows)]
    {
        true
    }
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new("/usr/bin/open").is_file()
    }
    #[cfg(target_os = "linux")]
    {
        (std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some())
            && command_on_path("xdg-open")
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        false
    }
}

#[cfg(target_os = "linux")]
fn command_on_path(command: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|directory| directory.join(command).is_file())
    })
}

fn render_qr(value: &str) -> Result<String> {
    use qrcode::types::Color;

    let code = qrcode::QrCode::new(value.as_bytes()).context("encoding approval QR")?;
    let width = code.width();
    let quiet = 2usize;
    let module = |x: isize, y: isize| -> bool {
        if x < 0 || y < 0 || x >= width as isize || y >= width as isize {
            false
        } else {
            code[(x as usize, y as usize)] == Color::Dark
        }
    };
    let mut rendered = String::new();
    for y in (-(quiet as isize)..(width + quiet) as isize).step_by(2) {
        rendered.push_str("     ");
        for x in -(quiet as isize)..(width + quiet) as isize {
            rendered.push(match (module(x, y), module(x, y + 1)) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            });
        }
        rendered.push('\n');
    }
    Ok(rendered)
}

fn key_conflict_copy() -> &'static str {
    "This machine was set up before, under a different SPAWN D account, and\n\
     spawn: that account still holds its identity. Nothing was changed.\n\
     spawn:   • To use it under THAT account: sign in there and approve as usual.\n\
     spawn:   • To hand it to THIS account: remove the host from the old account's\n\
     spawn:     Hosts page first, then run  spawnd possess  again.\n\
     spawn:   • To keep both accounts on this machine:  spawnd possess --new-account"
}

pub(crate) fn user_error(message: impl Into<String>) -> anyhow::Error {
    UserFacingError(message.into()).into()
}

pub(crate) fn background_service_error(error: &anyhow::Error) -> anyhow::Error {
    user_error(format!(
        "Couldn't install the background service ({error}). The daemon still works in the foreground: spawnd run. To retry the service: spawnd reconnect."
    ))
}

fn server_origin(server: &url::Url) -> String {
    server.origin().ascii_serialization()
}

fn connect_error(server: &url::Url, error: &reqwest::Error) -> anyhow::Error {
    let rendered = error.to_string().to_ascii_lowercase();
    let origin = server_origin(server);
    let host = server.host_str().unwrap_or("the server");
    if rendered.contains("dns") || rendered.contains("resolve") {
        user_error(format!("Can't find {host}. Check the server address — spawnd status shows what this machine uses."))
    } else if rendered.contains("certificate") || rendered.contains("tls") {
        user_error(format!("Secure connection to {origin} failed. If this machine's clock is wrong, fix that first (spawnd doctor checks it)."))
    } else {
        user_error(format!(
            "{origin} didn't answer. Is the machine online? A firewall or VPN may be blocking it."
        ))
    }
}

fn ensure_login_http_status(server: &url::Url, status: StatusCode) -> Result<()> {
    if status.is_success() {
        return Ok(());
    }
    if matches!(status.as_u16(), 502 | 503) {
        return Err(user_error(format!(
            "{} is having trouble (HTTP {}). Try again in a minute.",
            server_origin(server),
            status.as_u16()
        )));
    }
    Err(user_error(format!(
        "{} answered, but it isn't a SPAWN D server. Re-run the install command from the app — it carries the right address.",
        server_origin(server)
    )))
}

fn poll_has_success_fields(body: &DevicePollResponse) -> bool {
    body.access_token.is_some()
        || body.host_id.is_some()
        || body.host_key_algorithm.is_some()
        || body.host_public_key.is_some()
        || body.host_key_fingerprint.is_some()
        || body.browser_device_id.is_some()
        || body.browser_key_algorithm.is_some()
        || body.browser_public_key.is_some()
        || body.browser_key_fingerprint.is_some()
}

/// Verify the browser's approval proof against values this daemon already holds.
///
/// The nonce and host key come from this daemon's own device/start exchange, so
/// a proof minted for another ceremony, another host, or another account cannot
/// be replayed here. Returns whether a proof was actually verified.
///
/// A missing proof is tolerated and reported as unverified, because a pre-0022
/// server cannot supply one. A present-but-invalid proof aborts the login: no
/// benign condition produces one.
///
/// This does not by itself defeat a hostile server. The transcript commits to
/// the signer's own key, so a server substituting its own keypair can mint a
/// self-consistent proof. Distinguishing that case is what the operator's
/// out-of-band fingerprint comparison below is for.
fn verify_browser_approval(
    body: &DevicePollResponse,
    identity: &HostIdentity,
    approval_nonce: &str,
    browser_public_key: &str,
) -> Result<bool> {
    let (Some(account_id), Some(signature_wire)) = (
        body.account_id.as_deref(),
        body.browser_approval_signature.as_deref(),
    ) else {
        return Ok(false);
    };
    let transcript = HostPairApprovalTranscript::from_wire(
        account_id,
        approval_nonce,
        &identity.public_key,
        browser_public_key,
    )
    .context("decoding the browser approval transcript")?;
    let signature = host_pair_approval::signature_from_wire(signature_wire)
        .context("decoding the browser approval signature")?;
    let browser_key = public_key_from_wire(browser_public_key)
        .context("decoding the approved browser public key")?;
    host_pair_approval::verify_transcript(&browser_key, &transcript, &signature)
        .context("verifying the browser approval proof")?;
    Ok(true)
}

fn commit_poll_success<F>(
    stored: &mut creds::StoredCreds,
    body: DevicePollResponse,
    identity: &HostIdentity,
    server: &url::Url,
    approval_nonce: &str,
    persist: F,
) -> Result<uuid::Uuid>
where
    F: FnOnce(&mut creds::StoredCreds, &creds::CredentialRevision) -> Result<()>,
{
    commit_poll_success_observed(
        stored,
        body,
        identity,
        server,
        approval_nonce,
        persist,
        |_| {},
    )
}

fn commit_poll_success_observed<F, O>(
    stored: &mut creds::StoredCreds,
    mut body: DevicePollResponse,
    identity: &HostIdentity,
    server: &url::Url,
    approval_nonce: &str,
    persist: F,
    observe_wiped_token: O,
) -> Result<uuid::Uuid>
where
    F: FnOnce(&mut creds::StoredCreds, &creds::CredentialRevision) -> Result<()>,
    O: FnOnce(&str),
{
    // Take secret ownership before inspecting any other success field. Every
    // early return below leaves the token inside an auto-zeroizing allocation.
    let mut token = body.access_token.take().map(Zeroizing::new);
    // The browser tuple is first-contact trust input. Do not inspect or decode
    // it until the existing host binding and success shape are exact.
    let result = (|| {
        verify_poll_identity(&body, identity)?;
        if body.error.is_some() {
            return Err(anyhow!("device/poll mixed success and error fields"));
        }
        let token_ref = token
            .as_deref()
            .context("device/poll success omitted access_token")?;
        let host_id = body
            .host_id
            .context("device/poll success omitted host_id")?;
        creds::validate_login_access_token(token_ref)?;
        let browser_device_id = body
            .browser_device_id
            .as_deref()
            .context("device/poll success omitted browser_device_id")?;
        let browser_key_algorithm = body
            .browser_key_algorithm
            .as_deref()
            .context("device/poll success omitted browser_key_algorithm")?;
        let browser_public_key = body
            .browser_public_key
            .as_deref()
            .context("device/poll success omitted browser_public_key")?;
        let browser_key_fingerprint = body
            .browser_key_fingerprint
            .as_deref()
            .context("device/poll success omitted browser_key_fingerprint")?;
        let browser_pin = creds::browser_pin_from_approval(
            browser_device_id,
            browser_key_algorithm,
            browser_public_key,
            browser_key_fingerprint,
        )
        .context("validating approved browser identity from device/poll")?;
        // Check the browser's own signature before storing the pin, so an
        // invalid proof never reaches the credential file.
        let approval_verified =
            verify_browser_approval(&body, identity, approval_nonce, browser_public_key)?;
        // Retain the proof itself, not a verdict about it, so every later load
        // re-derives the verdict rather than trusting this one.
        let browser_pin = if approval_verified {
            crate::tui::log_line("browser approval proof verified");
            creds::attach_browser_approval_proof(
                browser_pin,
                body.account_id
                    .as_deref()
                    .expect("a verified proof carries an account ID"),
                approval_nonce,
                body.browser_approval_signature
                    .as_deref()
                    .expect("a verified proof carries a signature"),
            )
            .context("retaining the verified browser approval proof")?
        } else {
            crate::tui::log_line("warning: this server supplied no browser approval proof");
            browser_pin
        };
        // The proof cannot tell a substituted browser key from the real one, so
        // the operator confirms this fingerprint matches the one their browser
        // shows. This is the only check a hostile server cannot pass — and it
        // is worth exactly as much as the reader's chance of noticing it, so
        // it gets a panel rather than a line that scrolls past.
        crate::tui::log_block(
            browser_fingerprint_panel(browser_key_fingerprint, crate::tui::terminal_width()),
            &browser_fingerprint_plain_lines(browser_key_fingerprint),
        );
        let owned_token = std::mem::take(
            &mut **token
                .as_mut()
                .expect("validated poll access token remains owned"),
        );
        creds::commit_login_update(
            stored,
            owned_token,
            host_id,
            server.to_string(),
            browser_pin,
            persist,
        )?;
        Ok(host_id)
    })();
    if result.is_err() {
        if let Some(token) = token.as_mut() {
            token.zeroize();
            observe_wiped_token(token.as_str());
        } else {
            observe_wiped_token("");
        }
    }
    result
}

fn verify_poll_identity(body: &DevicePollResponse, identity: &HostIdentity) -> Result<()> {
    if body.host_key_algorithm.as_deref() != Some(identity.algorithm)
        || body.host_public_key.as_deref() != Some(identity.public_key.as_str())
        || body.host_key_fingerprint.as_deref() != Some(identity.fingerprint.as_str())
    {
        return Err(anyhow!(
            "device/poll returned a mismatched host identity binding"
        ));
    }
    Ok(())
}

pub(crate) fn detect_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into())
}

#[cfg(test)]
mod tests {
    /// 32 zero bytes: a canonical 43-char base64url ceremony nonce.
    const TEST_ACCOUNT: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    const TEST_APPROVAL_NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    use super::*;

    const BROWSER_KEY: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

    fn identity() -> HostIdentity {
        HostIdentity {
            algorithm: "ed25519",
            public_key: "A".repeat(43),
            fingerprint: "SHA256:fingerprint".into(),
        }
    }

    fn response() -> DevicePollResponse {
        DevicePollResponse {
            access_token: Some("token".into()),
            host_id: Some(uuid::Uuid::nil()),
            host_key_algorithm: Some("ed25519".into()),
            host_public_key: Some("A".repeat(43)),
            host_key_fingerprint: Some("SHA256:fingerprint".into()),
            browser_device_id: None,
            browser_key_algorithm: None,
            browser_public_key: None,
            browser_key_fingerprint: None,
            account_id: None,
            browser_approval_signature: None,
            error: None,
        }
    }

    fn complete_response() -> DevicePollResponse {
        let mut body = response();
        body.browser_device_id = Some("11111111-2222-4333-8444-555555555555".into());
        body.browser_key_algorithm = Some("ed25519".into());
        body.browser_public_key = Some(BROWSER_KEY.into());
        body.browser_key_fingerprint = Some(creds::browser_key_fingerprint(BROWSER_KEY).unwrap());
        body
    }

    fn start_response(verification_uri: &str, approval_ref: Option<&str>) -> DeviceStartResponse {
        DeviceStartResponse {
            device_code: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".into(),
            user_code: "ABCD-EFGH".into(),
            approval_ref: approval_ref.map(str::to_string),
            approval_nonce: TEST_APPROVAL_NONCE.into(),
            verification_uri: verification_uri.into(),
            interval: 5,
            expires_in: 600,
        }
    }

    #[test]
    fn approval_url_bakes_the_ref_and_appends_our_key_as_the_fragment() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let url = approval_url(
            &server,
            &start_response("https://spawn.example/device", Some("REFxyz")),
            BROWSER_KEY, // any wire-encoded key literal works here
        )
        .unwrap();
        assert_eq!(
            url,
            format!("https://spawn.example/device?ref=REFxyz#k={BROWSER_KEY}")
        );
    }

    #[test]
    fn approval_url_overwrites_any_server_supplied_fragment() {
        // A hostile server pre-baking `#k=<its key>` into verification_uri must
        // not survive: the fragment is this daemon's channel, set locally.
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let url = approval_url(
            &server,
            &start_response("https://spawn.example/device#k=EVILKEY", Some("REFxyz")),
            BROWSER_KEY,
        )
        .unwrap();
        assert!(!url.contains("EVILKEY"), "server fragment survived: {url}");
        assert!(url.ends_with(&format!("#k={BROWSER_KEY}")));
    }

    #[test]
    fn approval_url_refuses_a_cross_origin_approval_page() {
        // Same host, different scheme/port/host each count as a different
        // origin — a page the server chose, not the one the operator trusts.
        let server = url::Url::parse("https://spawn.example/").unwrap();
        for evil in [
            "https://evil.example/device",
            "http://spawn.example/device",
            "https://spawn.example:8443/device",
        ] {
            let error = approval_url(&server, &start_response(evil, Some("REFxyz")), BROWSER_KEY)
                .unwrap_err();
            assert!(
                format!("{error:#}").contains("refusing"),
                "unexpected error for {evil}: {error:#}"
            );
        }
        // Unparseable is refused too — an origin we cannot check is unchecked.
        assert!(approval_url(&server, &start_response("not a url", None), BROWSER_KEY).is_err());
    }

    #[test]
    fn approval_url_falls_back_to_the_user_code_without_a_ref() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let url = approval_url(
            &server,
            &start_response("https://spawn.example/device", None),
            BROWSER_KEY,
        )
        .unwrap();
        assert_eq!(
            url,
            format!("https://spawn.example/device?code=ABCD-EFGH#k={BROWSER_KEY}")
        );
    }

    #[test]
    fn poll_success_requires_exact_identity_binding() {
        assert!(verify_poll_identity(&response(), &identity()).is_ok());
        let mut changed_key = response();
        changed_key.host_public_key = Some("B".repeat(43));
        assert!(verify_poll_identity(&changed_key, &identity()).is_err());
        let mut missing_fingerprint = response();
        missing_fingerprint.host_key_fingerprint = None;
        assert!(verify_poll_identity(&missing_fingerprint, &identity()).is_err());
    }

    #[test]
    fn poll_success_requires_and_persists_the_exact_browser_tuple() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut stored = creds::StoredCreds::default();
        let persisted = std::cell::Cell::new(false);
        let host_id = commit_poll_success(
            &mut stored,
            complete_response(),
            &identity(),
            &server,
            TEST_APPROVAL_NONCE,
            |candidate, _| {
                persisted.set(true);
                assert_eq!(candidate.browser_pins().len(), 1);
                assert_eq!(candidate.browser_pins()[0].public_key(), BROWSER_KEY);
                Ok(())
            },
        )
        .unwrap();
        assert!(persisted.get());
        assert_eq!(host_id, uuid::Uuid::nil());
        assert_eq!(stored.access_token.as_deref(), Some("token"));
        assert_eq!(stored.server_url.as_deref(), Some("https://spawn.example/"));
        assert_eq!(stored.browser_pins().len(), 1);
    }

    #[test]
    fn poll_browser_tuple_is_validated_only_after_host_token_and_host_id() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut wrong_host = complete_response();
        wrong_host.host_public_key = Some("different-host".into());
        wrong_host.browser_public_key = Some("short".into());
        let error = commit_poll_success(
            &mut creds::StoredCreds::default(),
            wrong_host,
            &identity(),
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| Ok(()),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("mismatched host identity"));

        let mut missing_token = complete_response();
        missing_token.access_token = None;
        missing_token.browser_public_key = Some("short".into());
        let error = commit_poll_success(
            &mut creds::StoredCreds::default(),
            missing_token,
            &identity(),
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| Ok(()),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("omitted access_token"));

        let mut missing_host_id = complete_response();
        missing_host_id.host_id = None;
        missing_host_id.browser_public_key = Some("short".into());
        let error = commit_poll_success(
            &mut creds::StoredCreds::default(),
            missing_host_id,
            &identity(),
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| Ok(()),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("omitted host_id"));

        for invalid_token in [String::new(), "x".repeat(12 * 1024 + 1)] {
            let mut invalid = complete_response();
            invalid.access_token = Some(invalid_token);
            invalid.browser_public_key = Some("short".into());
            let error = commit_poll_success(
                &mut creds::StoredCreds::default(),
                invalid,
                &identity(),
                &server,
                TEST_APPROVAL_NONCE,
                |_, _| Ok(()),
            )
            .unwrap_err();
            assert!(format!("{error:#}").contains("access token"));
        }
    }

    #[test]
    fn every_early_poll_failure_observes_a_wiped_returned_token() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut cases = Vec::new();

        let mut wrong_host = complete_response();
        wrong_host.host_public_key = Some("different-host".into());
        cases.push(wrong_host);

        let mut mixed = complete_response();
        mixed.error = Some("denied".into());
        cases.push(mixed);

        let mut missing_host_id = complete_response();
        missing_host_id.host_id = None;
        cases.push(missing_host_id);

        let mut missing_browser_field = complete_response();
        missing_browser_field.browser_public_key = None;
        cases.push(missing_browser_field);

        let mut invalid_token = complete_response();
        invalid_token.access_token = Some("x".repeat(12 * 1024 + 1));
        cases.push(invalid_token);

        let mut invalid_pin = complete_response();
        invalid_pin.browser_public_key = Some("short".into());
        cases.push(invalid_pin);

        for body in cases {
            let observed = std::cell::Cell::new(false);
            let persisted = std::cell::Cell::new(false);
            assert!(commit_poll_success_observed(
                &mut creds::StoredCreds::default(),
                body,
                &identity(),
                &server,
                TEST_APPROVAL_NONCE,
                |_, _| {
                    persisted.set(true);
                    Ok(())
                },
                |wiped| {
                    observed.set(true);
                    assert!(wiped.is_empty());
                },
            )
            .is_err());
            assert!(observed.get());
            assert!(!persisted.get());
        }
    }

    #[test]
    fn poll_rejects_partial_malformed_conflicting_and_mixed_browser_bindings() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut invalid = Vec::new();
        let mut missing_id = complete_response();
        missing_id.browser_device_id = None;
        invalid.push(missing_id);
        let mut missing_algorithm = complete_response();
        missing_algorithm.browser_key_algorithm = None;
        invalid.push(missing_algorithm);
        let mut missing_key = complete_response();
        missing_key.browser_public_key = None;
        invalid.push(missing_key);
        let mut missing_fingerprint = complete_response();
        missing_fingerprint.browser_key_fingerprint = None;
        invalid.push(missing_fingerprint);
        let mut malformed_id = complete_response();
        malformed_id.browser_device_id = Some("11111111222243338444555555555555".into());
        invalid.push(malformed_id);
        let mut wrong_algorithm = complete_response();
        wrong_algorithm.browser_key_algorithm = Some("Ed25519".into());
        invalid.push(wrong_algorithm);
        let mut malformed_key = complete_response();
        malformed_key.browser_public_key = Some("A".repeat(43));
        invalid.push(malformed_key);
        let mut wrong_fingerprint = complete_response();
        wrong_fingerprint.browser_key_fingerprint = Some("SHA256:wrong".into());
        invalid.push(wrong_fingerprint);
        let mut mixed = complete_response();
        mixed.error = Some("denied".into());
        invalid.push(mixed);

        for body in invalid {
            let persisted = std::cell::Cell::new(false);
            assert!(commit_poll_success(
                &mut creds::StoredCreds::default(),
                body,
                &identity(),
                &server,
                TEST_APPROVAL_NONCE,
                |_, _| {
                    persisted.set(true);
                    Ok(())
                },
            )
            .is_err());
            assert!(!persisted.get());
        }
    }

    #[test]
    fn browser_only_poll_fields_enter_the_fail_closed_success_path() {
        let body = DevicePollResponse {
            access_token: None,
            host_id: None,
            host_key_algorithm: None,
            host_public_key: None,
            host_key_fingerprint: None,
            browser_device_id: Some("11111111-2222-4333-8444-555555555555".into()),
            browser_key_algorithm: None,
            browser_public_key: None,
            browser_key_fingerprint: None,
            account_id: None,
            browser_approval_signature: None,
            error: None,
        };
        assert!(poll_has_success_fields(&body));
    }

    /// Build a ceremony whose browser approval proof is genuinely signed.
    fn signed_ceremony(
        nonce: &str,
    ) -> (HostIdentity, DevicePollResponse, ed25519_dalek::SigningKey) {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;

        let host_key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        let browser_key = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
        let host_wire = URL_SAFE_NO_PAD.encode(host_key.verifying_key().to_bytes());
        let browser_wire = URL_SAFE_NO_PAD.encode(browser_key.verifying_key().to_bytes());

        let identity = HostIdentity {
            algorithm: "ed25519",
            public_key: host_wire.clone(),
            fingerprint: "SHA256:fingerprint".into(),
        };

        let transcript =
            HostPairApprovalTranscript::from_wire(TEST_ACCOUNT, nonce, &host_wire, &browser_wire)
                .expect("valid approval transcript");
        let signature = host_pair_approval::signature_to_wire(
            &host_pair_approval::sign_transcript(&browser_key, &transcript),
        );

        let mut body = response();
        body.host_public_key = Some(host_wire);
        body.browser_device_id = Some("11111111-2222-4333-8444-555555555555".into());
        body.browser_key_algorithm = Some("ed25519".into());
        body.browser_key_fingerprint = Some(creds::browser_key_fingerprint(&browser_wire).unwrap());
        body.browser_public_key = Some(browser_wire);
        body.account_id = Some(TEST_ACCOUNT.into());
        body.browser_approval_signature = Some(signature);
        (identity, body, browser_key)
    }

    #[test]
    fn login_accepts_a_genuinely_signed_browser_approval() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let (identity, body, _) = signed_ceremony(TEST_APPROVAL_NONCE);
        let mut stored = creds::StoredCreds::default();
        let persisted = std::cell::Cell::new(false);
        commit_poll_success(
            &mut stored,
            body,
            &identity,
            &server,
            TEST_APPROVAL_NONCE,
            |candidate, _| {
                persisted.set(true);
                assert_eq!(candidate.browser_pins().len(), 1);
                Ok(())
            },
        )
        .expect("a verified approval completes the login");
        assert!(persisted.get());
    }

    #[test]
    fn login_aborts_when_the_approval_proof_does_not_verify() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let (identity, mut body, _) = signed_ceremony(TEST_APPROVAL_NONCE);
        // Flip one signature character: a forged or tampered proof.
        let signature = body.browser_approval_signature.take().unwrap();
        let flipped = if signature.starts_with('A') { 'B' } else { 'A' };
        body.browser_approval_signature = Some(format!("{flipped}{}", &signature[1..]));

        let persisted = std::cell::Cell::new(false);
        let error = commit_poll_success(
            &mut creds::StoredCreds::default(),
            body,
            &identity,
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| {
                persisted.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("browser approval proof"),
            "unexpected error: {error:#}"
        );
        assert!(!persisted.get(), "an unverified pin must never be stored");
    }

    #[test]
    fn login_rejects_an_approval_proof_from_another_ceremony() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        // Signed against a different nonce than the one this daemon started.
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        let other_nonce = URL_SAFE_NO_PAD.encode([1_u8; 32]);
        let (identity, body, _) = signed_ceremony(&other_nonce);

        let persisted = std::cell::Cell::new(false);
        let error = commit_poll_success(
            &mut creds::StoredCreds::default(),
            body,
            &identity,
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| {
                persisted.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("browser approval proof"),
            "unexpected error: {error:#}"
        );
        assert!(!persisted.get());
    }

    #[test]
    fn login_still_completes_against_a_server_that_supplies_no_proof() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let (identity, mut body, _) = signed_ceremony(TEST_APPROVAL_NONCE);
        body.account_id = None;
        body.browser_approval_signature = None;

        let persisted = std::cell::Cell::new(false);
        commit_poll_success(
            &mut creds::StoredCreds::default(),
            body,
            &identity,
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| {
                persisted.set(true);
                Ok(())
            },
        )
        .expect("a pre-0022 server must still be able to pair");
        assert!(persisted.get());
    }

    #[test]
    fn browser_opening_respects_interactivity_and_no_browser() {
        assert_eq!(
            browser_behavior(true, true, false),
            BrowserBehavior {
                offer_enter: true,
                open_immediately: false,
            }
        );
        assert_eq!(
            browser_behavior(false, true, false),
            BrowserBehavior {
                offer_enter: false,
                open_immediately: true,
            }
        );
        for interactive in [true, false] {
            assert_eq!(
                browser_behavior(interactive, true, true),
                BrowserBehavior {
                    offer_enter: false,
                    open_immediately: false,
                }
            );
        }
    }

    #[test]
    fn plain_login_link_block_is_byte_stable() {
        assert_eq!(
            approval_link_block(false, "https://spawnd.dev/device?ref=x#k=y"),
            "spawn: approve this host in your browser — open this link on any device:\nspawn:   https://spawnd.dev/device?ref=x#k=y\n\n"
        );
        assert_eq!(
            approval_link_block(true, "https://spawnd.dev/device?ref=x#k=y"),
            "spawn: opened your browser to approve this host.\nspawn:   didn't open? use this link on any device:\nspawn:   https://spawnd.dev/device?ref=x#k=y\n\n"
        );
    }

    #[test]
    fn the_approval_panel_stays_square_around_a_real_length_url() {
        // A live approval URL carries an opaque ref and a key fragment and runs
        // well past any frame, so the wrap path is the normal case, not an edge.
        let url = format!(
            "http://localhost:3000/device?ref={}#k={}",
            "dGfl0YzRgEM6YrY9JVVDVPaIRWu8eEKrYhv-7LxiQJw".repeat(2),
            "iyfYTSKbL12bH3OGWAov2LH2qOvK6vokuRQfRdZMaUc"
        );
        assert!(url.len() > 150, "the fixture must actually overflow");
        for width in [crate::tui::MIN_FRAME_COLUMNS, 72, 92] {
            let panel = approval_panel(false, &url, width, true);
            let widths: Vec<usize> = panel.iter().map(|l| crate::tui::display_width(l)).collect();
            assert!(
                widths.iter().all(|w| *w == width),
                "ragged panel at width {width}: {widths:?}"
            );
        }
        // Every character of the URL must survive the wrap — a truncated
        // approval link is worse than an ugly one.
        let panel = approval_panel(false, &url, 72, true);
        let chunks = crate::tui::wrap_plain(&url, 72 - 4);
        assert_eq!(chunks.concat(), url, "wrapping dropped part of the URL");
        for chunk in &chunks {
            assert!(
                panel.iter().any(|line| strip_sgr(line).contains(chunk)),
                "the panel is missing a piece of the approval URL: {chunk}"
            );
        }
    }

    fn strip_sgr(text: &str) -> String {
        crate::tui::strip_styles(text)
    }

    #[test]
    fn plain_approval_output_offers_the_link_and_nothing_to_type() {
        // The live region is a tty-only affordance. Anything piped — CI, a
        // smoke script, `NO_COLOR` — sees the same single offer as the panel,
        // byte for byte.
        let lines = approval_plain_lines(false, "https://spawnd.dev/device?ref=x#k=y", None);
        assert_eq!(
            lines,
            vec![
                "spawn: approve this host in your browser — open this link on any device:",
                "spawn:   https://spawnd.dev/device?ref=x#k=y",
                "",
                "spawn:   the link carries this host's identity key (the part after '#');",
                "spawn:   your browser checks it automatically before asking you to approve.",
                "",
                "spawn: waiting for approval…",
            ]
        );
    }

    #[test]
    fn plain_approval_url_line_is_byte_stable() {
        let url = "https://spawnd.dev/device?ref=x#k=y";
        assert_eq!(
            approval_plain_lines(false, url, None)[1],
            format!("spawn:   {url}")
        );
    }

    /// One way to approve: the link. The pairing code and the fingerprint
    /// used to sit under it, and the three together read as three routes
    /// where there is one — the link carries the key, so nothing here is
    /// for a person to type or compare.
    #[test]
    fn the_approval_panel_offers_the_link_and_nothing_else() {
        let url = "http://localhost:3000/device?ref=dIF2cG14Xj3maek4#k=WsMbPmvzNwEnoPV1I";
        for interactive in [true, false] {
            let panel = approval_panel(false, url, 88, interactive);
            let plain = strip_sgr(&panel.join("\n")).to_lowercase();
            assert!(plain.contains("open this link on any device"), "{plain}");
            assert!(plain.contains("device?ref=dif2cg14xj3maek4"), "{plain}");
            assert!(
                !plain.contains("pairing code"),
                "a code to type is a second way in: {plain}"
            );
            assert!(
                !plain.contains("sha256"),
                "a fingerprint to compare is a third: {plain}"
            );
            assert!(!plain.contains("key"), "{plain}");
            assert!(!plain.contains("no link"), "{plain}");
        }
        let plain = approval_plain_lines(false, url, None)
            .join("\n")
            .to_lowercase();
        assert!(!plain.contains("pairing code"), "{plain}");
        assert!(!plain.contains("sha256"), "{plain}");
        assert!(!plain.contains("type"), "{plain}");
    }

    #[test]
    fn the_approval_link_is_clickable_and_says_how_to_open_it() {
        let url = "http://localhost:3000/device?ref=dIF2cG14Xj3maek4#k=WsMbPmvzNwEnoPV1I";
        let panel = approval_panel(false, url, 88, true);
        let joined = panel.join("\n");

        // OSC 8, so the terminal makes the link clickable rather than leaving
        // the operator to select 90-odd characters by hand.
        assert!(joined.contains("\u{1b}]8;;"), "no hyperlink marker");
        assert!(joined.contains(url), "the link target must be the full URL");
        // The instruction sits with the link, inside the same frame.
        assert!(joined.contains("press Enter to open it here"));

        // Without a keyboard there is nothing to press, so the line is absent.
        let headless = approval_panel(false, url, 88, false);
        assert!(!headless.join("\n").contains("press Enter"));
    }

    #[test]
    fn the_opened_browser_variant_keeps_its_own_lead_lines() {
        let lines = approval_plain_lines(true, "https://x/y", None);
        assert_eq!(lines[0], "spawn: opened your browser to approve this host.");
        assert_eq!(
            lines[1],
            "spawn:   didn't open? use this link on any device:"
        );
        assert_eq!(lines[2], "spawn:   https://x/y");
    }

    #[test]
    fn a_qr_is_carried_through_the_plain_lines_unaltered() {
        let lines = approval_plain_lines(false, "https://x/y", Some("##\n#.\n"));
        assert!(lines.contains(&"##".to_owned()) && lines.contains(&"#.".to_owned()));
        assert!(lines
            .iter()
            .any(|line| line.contains("Scan this with your phone")));
    }

    #[test]
    fn the_waiting_status_counts_down_the_real_expiry() {
        assert_eq!(
            waiting_status(0, 1800),
            "waiting for approval — 0s · link expires in 30 min"
        );
        assert_eq!(
            waiting_status(33, 1800),
            "waiting for approval — 33s · link expires in 30 min"
        );
        // Past expiry must not underflow into a huge number.
        assert_eq!(
            waiting_status(9_000, 1800),
            "waiting for approval — 9000s · link expires in 0 min"
        );
    }

    /// The check a hostile server cannot pass has to be legible, square, and
    /// say what a mismatch means — a fingerprint nobody reads is decoration.
    #[test]
    fn the_browser_fingerprint_gets_a_panel_not_a_passing_line() {
        let rows = browser_fingerprint_panel("SHA256:HtC4Xxqpdeh3Yfgd", 72);
        let plain = strip_sgr(&rows.join("\n"));
        assert!(plain.contains("SHA256:HtC4Xxqpdeh3Yfgd"));
        assert!(plain.contains("Access"));
        assert!(plain.contains("remove this host"));
        let widths: Vec<usize> = rows.iter().map(|r| crate::tui::display_width(r)).collect();
        assert!(
            widths.iter().all(|w| *w == widths[0]),
            "ragged panel: {widths:?}"
        );
        let lines = browser_fingerprint_plain_lines("SHA256:HtC4Xxqpdeh3Yfgd");
        assert!(lines.iter().any(|l| l.contains("SHA256:HtC4Xxqpdeh3Yfgd")));
    }

    /// Every fingerprint shown for comparison gets the same treatment: its own
    /// line, with air, never buried in a run of dim prose.
    #[test]
    fn a_fingerprint_stands_alone_wherever_it_is_shown() {
        let panel = browser_fingerprint_panel("SHA256:zzz", 72);
        let plain: Vec<String> = panel.iter().map(|r| strip_sgr(r)).collect();
        let row = plain
            .iter()
            .find(|r| r.contains("SHA256:zzz"))
            .expect("the fingerprint is on some row");
        // Nothing else shares the row it is on.
        let content = row.trim_matches(|c| c == '│' || c == ' ');
        assert_eq!(content, "SHA256:zzz", "fingerprint shares its row: {row:?}");
    }

    #[test]
    fn qr_encodes_the_full_fragment_bearing_approval_url() {
        let full = "https://spawnd.dev/device?ref=opaque#k=host-public-key";
        let qr = qrcode::QrCode::new(full.as_bytes()).unwrap();
        let rendered = render_qr(full).unwrap();
        assert!(qr.width() > 0);
        assert!(rendered.contains(['█', '▀', '▄']));
        assert!(!rendered.contains(full));
    }

    #[test]
    fn key_conflict_uses_the_three_option_transcript() {
        let copy = key_conflict_copy();
        assert!(copy.contains("To use it under THAT account"));
        assert!(copy.contains("To hand it to THIS account"));
        assert!(copy.contains("spawnd possess --new-account"));
        assert!(copy.contains("Nothing was changed."));
    }

    #[tokio::test]
    async fn fake_server_observes_current_start_and_possession_shapes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 4096];
            let read = first.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(!request.contains("setup_token"));
            let start = r#"{"device_code":"code","user_code":"ABCD-EFGH","approval_nonce":"nonce","verification_uri":"http://127.0.0.1/device","interval":1,"expires_in":1800}"#;
            first
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{start}",
                        start.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let (mut second, _) = listener.accept().await.unwrap();
            let mut second_request = vec![0u8; 4096];
            let _ = second.read(&mut second_request).await.unwrap();
            let possession = r#"{"verified":true,"version":1}"#;
            second
                .write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{possession}", possession.len()).as_bytes())
                .await
                .unwrap();
        });

        let origin = url::Url::parse(&format!("http://{address}/")).unwrap();
        let client = reqwest::Client::new();
        let start: DeviceStartResponse = client
            .post(origin.join("start").unwrap())
            .json(&DeviceStartRequest {
                host_name: "host",
                os: "linux",
                arch: "x86_64",
                version: "0.1.0",
                host_key_algorithm: "ed25519",
                host_public_key: "host-key",
            })
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(start.user_code, "ABCD-EFGH");
        let possession: DevicePossessionResponse = client
            .post(origin.join("possession").unwrap())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(possession.verified);
        assert_eq!(possession.version, 1);
        server.await.unwrap();
    }
}
