//! `spawnd possess` / `spawnd exorcise` — one-command onboarding and teardown.
//!
//! `possess` is a single browser approval, at most. With no `--config-dir` it
//! derives a per-account instance dir `<base>/<account_id>` from the login:
//!   - exactly one existing registration → resume it silently, no auth;
//!   - otherwise → one auth flow (staged), then either promote the staged
//!     registration to `<base>/<account_id>` (new) or, if that account is
//!     already set up, drop the just-created duplicate host via
//!     `DELETE /api/hosts/self` and adopt the existing one.
//!
//! An explicit `--config-dir` bypasses derivation and targets that dir exactly.
//!
//! Both commands force the file credential store so an instance dir can be
//! relocated and enumerated without a keyring dependency (headless hosts have
//! none anyway; macOS already defaults it off).

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::StatusCode;
use url::Url;

use crate::cli::{ExorciseArgs, LoginArgs, PossessArgs};
use crate::{config, creds, login, service};

/// `possess` runs the login ceremony's steps and then its own. The shared
/// prefix must stay aligned with `login::LOGIN_STEPS` — a test pins it — so an
/// index means the same thing whichever command opened the live region.
const POSSESS_STEPS: [&str; 4] = [
    "Register this machine",
    "Approve in your browser",
    "Store credentials",
    "Start background daemon",
];

/// The hosted service, as the sign-in sheet in both apps names it.
const HOSTED_SERVER: &str = "https://spawnd.dev";

/// Ask where this machine should report, the way the app's sign-in sheet does.
///
/// The offer depends on whether anyone has already named a server. An explicit
/// `--server` — which `install.sh` always bakes with the origin the one-liner
/// was fetched from — *is* the choice: someone ran a command from that server
/// on purpose, and it is the strongest signal there is. So it leads and Enter
/// accepts it, with the hosted service beside it for anyone who meant to end
/// up there. Defaulting to spawnd.dev regardless meant a `curl … localhost:3000
/// | sh` registered against the hosted service on one keypress, which is the
/// opposite of what running that command said.
///
/// With nothing named, there is no such signal, and the hosted service leads —
/// self-hosting is then the deliberate choice, and the only path that has to
/// ask for a URL. Non-interactive installs never see any of this.
fn choose_server(server_cli: Option<String>, setup_token: Option<&str>) -> Result<Url> {
    let resolved = config::server_url(server_cli.clone())?;
    let offer = server_offer(
        server_cli.as_deref(),
        &resolved,
        setup_token,
        std::io::stdin().is_terminal(),
    );
    let hosted = hosted_server();
    match offer {
        ServerOffer::Settled(server) => Ok(server),
        ServerOffer::Named(named) => {
            // Two real answers, no URL to type: this machine reports where the
            // command came from, or to the hosted service. Any third server is
            // reached by naming it — `spawnd --server <url> possess` — which
            // arrives back here as the leading option.
            let label = origin_label(&named);
            let picked = crate::tui::prompt_choice(
                "WHERE THIS MACHINE REPORTS",
                &[
                    (label.as_str(), "where this command came from"),
                    ("spawnd.dev", "the hosted service"),
                ],
                0,
            );
            Ok(if picked == 0 { named } else { hosted })
        }
        ServerOffer::Unnamed => {
            let picked = crate::tui::prompt_choice(
                "WHERE THIS MACHINE REPORTS",
                &[
                    ("spawnd.dev", "the hosted service"),
                    ("Host yourself", "a server you run"),
                ],
                0,
            );
            if picked == 0 {
                return Ok(hosted);
            }
            // Nothing named a server, so there is no origin to prefill — offer
            // the local dev address and re-ask rather than failing on a typo.
            loop {
                let answer = crate::tui::prompt_line("server URL", "http://localhost:3000");
                match Url::parse(answer.trim()) {
                    Ok(url) if url.has_host() => return Ok(url),
                    _ => crate::tui::log_line(&format!("{answer:?} is not a URL — try again")),
                }
            }
        }
    }
}

/// What to put in front of the operator — decided without touching the
/// terminal, so every branch is reachable from a test.
#[derive(Debug, PartialEq, Eq)]
enum ServerOffer {
    /// Already decided; ask nothing.
    Settled(Url),
    /// An origin was named for us. It leads; the hosted service is the other answer.
    Named(Url),
    /// Nothing named one. The hosted service leads, and self-hosting types a URL.
    Unnamed,
}

fn server_offer(
    server_cli: Option<&str>,
    resolved: &Url,
    setup_token: Option<&str>,
    interactive: bool,
) -> ServerOffer {
    // No terminal to ask at, or a token that already answers: take the value.
    if !interactive || setup_token.is_some() {
        return ServerOffer::Settled(resolved.clone());
    }
    if server_cli.is_some() && resolved.origin() != hosted_server().origin() {
        return ServerOffer::Named(resolved.clone());
    }
    ServerOffer::Unnamed
}

fn hosted_server() -> Url {
    Url::parse(HOSTED_SERVER).expect("the hosted URL is a constant")
}

/// A server as a person would name it: host, and the port when it is not the
/// scheme's default. `https://spawnd.dev/` → `spawnd.dev`;
/// `http://localhost:3000/` → `localhost:3000`.
fn origin_label(url: &Url) -> String {
    let host = url.host_str().unwrap_or("this server");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// What to do about a machine that is already possessed.
#[derive(Debug, PartialEq, Eq)]
enum ResumeAction {
    /// Leave the accounts alone; just make sure the daemon is running.
    Keep,
    /// Run the approval ceremony again, for a new browser or device.
    Reauthorize,
    /// Check for and install a newer daemon.
    Update,
    /// Sign in again, alongside what is already here.
    NewAccount,
}

/// Ask what this run is for, instead of resuming and printing commands.
///
/// Everything on this menu used to be a line of prose ending in a command to
/// copy — "to connect another account run …", "need an approval link? run …".
/// That is a worse answer than doing it: the reader is already in front of the
/// program that can, and the command it named did not even match how most of
/// them arrived (an install one-liner takes `sh -s -- --new-account`).
///
/// Unattended installs never see this. With nobody to answer, re-running the
/// same command should be the no-op it always was.
fn resume_action(existing: &[PathBuf]) -> ResumeAction {
    if !std::io::stdin().is_terminal() {
        return ResumeAction::Keep;
    }
    let single = existing.len() == 1;
    let keep = if single {
        format!("Keep {}", instance_account(&existing[0]))
    } else {
        format!("Keep all {} accounts", existing.len())
    };
    // Re-approving targets one instance, so it is only offered when there is no
    // ambiguity about which. With several, `spawnd login --config-dir` is the
    // honest answer and the hint below still names it.
    let mut options: Vec<(&str, &str)> = vec![(keep.as_str(), "already possessed here")];
    options.extend(resume_options(single));
    resume_choice(
        crate::tui::prompt_choice("THIS MACHINE IS ALREADY POSSESSED", &options, 0),
        single,
    )
}

/// Everything after the "keep it" row, which needs the account name and so is
/// built by the caller. Split out with the mapping below so the menu can be
/// tested without a terminal to press keys at.
fn resume_options(single: bool) -> Vec<(&'static str, &'static str)> {
    let mut options = Vec::new();
    // Re-approving targets one instance, so it is only offered when there is no
    // ambiguity about which.
    if single {
        options.push(("Approve a new browser or device", "run the sign-in again"));
    }
    options.push(("Add another account", "sign in again, alongside this one"));
    options.push(("Check for a newer SPAWN D", "update the daemon in place"));
    options
}

fn resume_choice(picked: usize, single: bool) -> ResumeAction {
    match (picked, single) {
        (0, _) => ResumeAction::Keep,
        (1, true) => ResumeAction::Reauthorize,
        (1, false) | (2, true) => ResumeAction::NewAccount,
        _ => ResumeAction::Update,
    }
}

/// Leave the accounts as they are and make sure their daemons are running.
async fn keep_possessed(existing: &[PathBuf], server_cli: Option<String>) -> Result<()> {
    if existing.len() == 1 {
        let dir = &existing[0];
        std::env::set_var("SPAWN_CONFIG_DIR", dir);
        let stored = creds::load().ok();
        let server = config::server_url_for_instance(
            server_cli,
            stored.as_ref().and_then(|creds| creds.server_url.as_deref()),
        )?;
        print_starting_step();
        service::install(dir, server.as_str())
            .map_err(|error| login::background_service_error(&error))?;
        println!("{}", resume_line(&instance_account(dir)));
        print_auth_note(dir);
        return Ok(());
    }
    let accounts = existing
        .iter()
        .map(|dir| instance_account(dir))
        .collect::<Vec<_>>()
        .join(", ");
    println!("spawn: already possessed for {accounts}.");
    Ok(())
}

fn possess_ui() -> crate::tui::Ui {
    crate::tui::Ui::start(&login::ceremony_title(), &POSSESS_STEPS, login::WAITING_HINT)
}

pub async fn possess(server_cli: Option<String>, args: PossessArgs) -> Result<()> {
    force_file_store();
    crate::tui::print_logo();

    // Explicit --config-dir → that dir is the instance, no per-account derivation.
    if explicit_config_dir() {
        return possess_dir(server_cli, args, &config::config_dir()?).await;
    }

    let base = default_base()?;
    // Silent resume: exactly one existing per-account registration. Unreadable
    // credentials only cost the stored-server fallback, never the resume.
    let existing = account_dirs_with_creds(&base)?;
    let stage_login =
        staged_login_required(existing.len(), args.new_account, args.setup_token.as_deref());
    if !existing.is_empty() && !stage_login {
        match resume_action(&existing) {
            ResumeAction::Keep => return keep_possessed(&existing, server_cli).await,
            ResumeAction::Reauthorize => {
                let dir = existing[0].clone();
                std::env::set_var("SPAWN_CONFIG_DIR", &dir);
                let stored = creds::load().ok();
                let server = config::server_url_for_instance(
                    server_cli,
                    stored.as_ref().and_then(|creds| creds.server_url.as_deref()),
                )?;
                login::run(
                    Some(server.to_string()),
                    LoginArgs {
                        host_name: None,
                        no_run: true,
                        setup_token: None,
                        qr: args.qr,
                        no_qr: args.no_qr,
                    },
                )
                .await?;
                return Ok(());
            }
            ResumeAction::Update => return crate::update::run_cli(server_cli).await,
            // Falls through to the ceremony below.
            ResumeAction::NewAccount => {}
        }
    }

    let server = choose_server(server_cli.clone(), args.setup_token.as_deref())?;

    // One auth flow, staged, then promoted to <base>/<account_id>.
    let staging = base.join(".possess-staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::env::set_var("SPAWN_CONFIG_DIR", &staging);

    let ui = possess_ui();
    // Named before the login consumes it: the closing panel wants to say which
    // machine this was, and the ceremony resolves the same value.
    let machine = args
        .host_name
        .clone()
        .unwrap_or_else(login::detect_hostname);
    let outcome = login::run_with_ui(
        // The answer to "where does this machine report" is the answer for the
        // whole command. Passing `server_cli` here instead registered against
        // the installer's origin while the background service was installed for
        // the *chosen* one, and a daemon whose unit disagrees with its
        // credentials never starts — see `service::registered_server`.
        Some(server.to_string()),
        LoginArgs {
            host_name: args.host_name,
            no_run: true,
            setup_token: args.setup_token,
            qr: args.qr,
            no_qr: args.no_qr,
        },
        &ui,
    )
    .await
    .context("registering this host")?;
    let account = sanitize_account(
        outcome
            .account_id
            .as_deref()
            .context("the server did not return an account id (it may be out of date)")?,
    );
    let final_dir = base.join(&account);

    if final_dir.join("credentials.json").exists() {
        // Account already registered here → drop the duplicate we just made.
        if let Ok(token) = staging_token() {
            if let Err(error) = deregister_self(&server, &token).await {
                tracing::warn!(%error, "removing the duplicate host registration");
            }
        }
        let _ = std::fs::remove_dir_all(&staging);
    } else {
        std::fs::create_dir_all(&base).ok();
        std::fs::rename(&staging, &final_dir).with_context(|| {
            format!(
                "promoting the staged registration to {}",
                final_dir.display()
            )
        })?;
    }

    std::env::set_var("SPAWN_CONFIG_DIR", &final_dir);
    ui.begin(3, "[ RUNNING ]");
    service::install(&final_dir, server.as_str()).map_err(|error| {
        ui.fail(3, "not started");
        login::background_service_error(&error)
    })?;
    ui.complete(3, "running");
    ui.finish();
    print_possessed(&machine, &account);
    Ok(())
}

/// The last thing the ceremony says, and the only screen that answers "what
/// now?".
///
/// Everything up to here was a live region the reader watched. When it stops
/// moving they are left holding a terminal with no idea whether it still
/// matters — so say the two things they need: this window is finished with,
/// and here is how to talk to the daemon that is still running.
fn print_possessed(machine: &str, account: &str) {
    let width = crate::tui::terminal_width();
    if !crate::tui::styled_stdout() {
        for line in possessed_plain_lines(machine, account) {
            println!("{line}");
        }
        return;
    }
    for line in possessed_panel(machine, account, width) {
        println!("{line}");
    }
    println!();
}

fn possessed_panel(machine: &str, account: &str, width: usize) -> Vec<String> {
    use crate::tui::{dim, render_choice_row, render_panel, wrap_words};
    let inner = width.saturating_sub(4);
    let prose = |text: &str| -> Vec<String> {
        wrap_words(text, inner)
            .iter()
            .map(|line| dim(line, true))
            .collect()
    };
    let mut rows = vec![String::new()];
    rows.extend(prose(&format!(
        "{machine} is possessed. you can close this terminal — SPAWN D keeps running in the background and comes back with the machine."
    )));
    rows.push(String::new());
    rows.extend(prose("when you need it:"));
    for (index, (command, blurb)) in POSSESSED_COMMANDS.iter().enumerate() {
        rows.push(render_choice_row(
            false,
            index + 1,
            command,
            blurb,
            inner,
            true,
        ));
    }
    rows.push(String::new());
    rows.extend(prose(&format!("signed in as {account}.")));
    render_panel("POSSESSED", &rows, width, true)
}

/// The commands worth knowing on day one, in the order someone reaches for
/// them. Anything rarer is `spawnd --help`, which the last row points at.
const POSSESSED_COMMANDS: [(&str, &str); 4] = [
    ("spawnd status", "is it running, and connected?"),
    ("spawnd reconnect", "restart it after a network change"),
    ("spawnd login", "approve a new browser or device"),
    ("spawnd --help", "everything else"),
];

/// Piped, `NO_COLOR` and CI keep the prefixed-line form.
fn possessed_plain_lines(machine: &str, account: &str) -> Vec<String> {
    let mut lines = vec![
        format!("spawn: {machine} is possessed ({account})."),
        "spawn: you can close this terminal — SPAWN D runs in the background.".to_owned(),
        String::new(),
    ];
    lines.extend(
        POSSESSED_COMMANDS
            .iter()
            .map(|(command, blurb)| format!("spawn:   {command} — {blurb}")),
    );
    lines
}

async fn possess_dir(server_cli: Option<String>, args: PossessArgs, dir: &Path) -> Result<()> {
    // Unreadable credentials mean "not possessed" here, exactly as before:
    // the login flow rebuilds them.
    let stored = creds::load().ok();
    let resumed = stored.as_ref().is_some_and(|creds| creds.is_logged_in());
    let server = config::server_url_for_instance(
        server_cli.clone(),
        stored
            .as_ref()
            .and_then(|creds| creds.server_url.as_deref()),
    )?;
    // A resume has no ceremony to show, so it keeps the plain step line.
    let ui = (!resumed).then(possess_ui);
    let args_host_name = args.host_name.clone();
    match &ui {
        Some(ui) => {
            login::run_with_ui(
                server_cli,
                LoginArgs {
                    host_name: args.host_name,
                    no_run: true,
                    setup_token: args.setup_token,
                    qr: args.qr,
                    no_qr: args.no_qr,
                },
                ui,
            )
            .await
            .context("registering this host")?;
            ui.begin(3, "[ RUNNING ]");
        }
        None => {
            println!("spawn: already possessed; ensuring the background daemon is running.");
            print_starting_step();
        }
    }
    service::install(dir, server.as_str()).map_err(|error| {
        if let Some(ui) = &ui {
            ui.fail(3, "not started");
        }
        login::background_service_error(&error)
    })?;
    if let Some(ui) = ui {
        ui.complete(3, "running");
        ui.finish();
    }
    if resumed {
        crate::tui::log_line(&format!(
            "possessed. daemon running in the background ({}).",
            service::instance_name(dir)
        ));
        println!("{}", relogin_hint(&server, dir));
        print_auth_note(dir);
    } else {
        // A ceremony just ran here too, so it ends the same way: this terminal
        // is done, and here is how to reach the daemon that is not.
        print_possessed(
            &args_host_name.unwrap_or_else(login::detect_hostname),
            &service::instance_name(dir),
        );
    }
    Ok(())
}

fn print_auth_note(dir: &Path) {
    if crate::state::read(dir)
        .ok()
        .flatten()
        .and_then(|state| state.last_error)
        .is_some_and(|error| error.kind == "auth")
    {
        println!("spawn: note — the server is rejecting this machine's sign-in. Run: spawnd login");
    }
}

fn print_starting_step() {
    if crate::tui::styled_stdout() {
        println!(
            "{}",
            crate::tui::step_line(2, 2, "Starting the background daemon")
        );
    }
}

pub async fn exorcise(server_cli: Option<String>, args: ExorciseArgs) -> Result<()> {
    force_file_store();
    // An explicit server must parse before anything is torn down; without one,
    // each instance deregisters from the server it registered with.
    let explicit = match server_cli {
        Some(raw) => Some(config::server_url(Some(raw))?),
        None => None,
    };

    if !args.yes {
        let scope = if args.all {
            "every SPAWN D instance, its service, credentials, identity, and approvals"
        } else {
            "this SPAWN D instance, its service, credentials, identity, and approvals"
        };
        if !crate::tui::confirm(&format!("Exorcise {scope}?"))? {
            println!("spawn: exorcise cancelled.");
            return Ok(());
        }
    }

    if args.all {
        let base = default_base()?;
        let mut removed = 0;
        for dir in account_dirs_with_creds(&base)? {
            exorcise_one(explicit.as_ref(), &dir).await;
            removed += 1;
        }
        println!("spawn: exorcised {removed} instance(s).");
        return Ok(());
    }

    let dir = if explicit_config_dir() {
        config::config_dir()?
    } else {
        let base = default_base()?;
        let mut existing = account_dirs_with_creds(&base)?;
        match existing.len() {
            0 => config::config_dir()?, // legacy single instance in the base
            1 => existing.pop().unwrap(),
            _ => bail!("multiple instances on this host; pass --config-dir <dir> or --all"),
        }
    };
    exorcise_one(explicit.as_ref(), &dir).await;
    println!("spawn: exorcised.");
    Ok(())
}

async fn exorcise_one(explicit: Option<&Url>, dir: &Path) {
    std::env::set_var("SPAWN_CONFIG_DIR", dir);
    if let Ok(creds) = creds::load() {
        if let Some(token) = creds.access_token.as_deref() {
            match config::server_url_for_instance(
                explicit.map(Url::to_string),
                creds.server_url.as_deref(),
            ) {
                Ok(server) => {
                    if let Err(error) = deregister_self(&server, token).await {
                        tracing::warn!(%error, dir = %dir.display(), "deregistering host");
                    }
                }
                // A damaged stored URL only skips the best-effort deregister;
                // local teardown still proceeds.
                Err(error) => {
                    tracing::warn!(%error, dir = %dir.display(), "resolving the server to deregister from");
                }
            }
        }
    }
    if let Err(error) = service::uninstall(dir) {
        tracing::warn!(%error, "removing the background service");
    }
    let _ = creds::logout().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// A daemon revokes its own host registration. 401/404 are treated as success
/// (the registration is already gone).
async fn deregister_self(server: &Url, token: &str) -> Result<()> {
    let url = config::api_url(server, "/api/hosts/self")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let status = client
        .delete(url.as_str())
        .bearer_auth(token)
        .send()
        .await
        .context("DELETE /api/hosts/self")?
        .status();
    if status.is_success() || status == StatusCode::NOT_FOUND || status == StatusCode::UNAUTHORIZED
    {
        Ok(())
    } else {
        bail!("host deregister failed: HTTP {status}")
    }
}

fn force_file_store() {
    if std::env::var_os("SPAWN_DISABLE_KEYRING").is_none() {
        std::env::set_var("SPAWN_DISABLE_KEYRING", "1");
    }
}

fn explicit_config_dir() -> bool {
    std::env::var_os("SPAWN_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .is_some()
}

fn default_base() -> Result<PathBuf> {
    Ok(dirs::config_dir()
        .context("cannot resolve the user config directory")?
        .join("spawn"))
}

/// Immediate subdirectories of `base` that hold a `credentials.json` — i.e. the
/// per-account instances. Hidden dirs (the staging dir) are skipped.
pub(crate) fn account_dirs_with_creds(base: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(base) else {
        return Ok(out);
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.join("credentials.json").is_file() {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

pub(crate) fn default_instance_base() -> Result<PathBuf> {
    default_base()
}

fn staging_token() -> Result<String> {
    // SPAWN_CONFIG_DIR points at the staging dir here. Clone rather than move
    // the field out of StoredCreds (it implements Drop for zeroization).
    let creds = creds::load()?;
    creds
        .access_token
        .clone()
        .context("staged login has no access token")
}

/// A resumed possession mints no approval link — only a fresh login ceremony
/// does — so a browser sent here by the web app's "possess a host directly"
/// escape would otherwise dead-end on "already possessed". Name the command
/// that prints one, with the server and instance dir baked in so it works as
/// typed: a bare `spawnd login` would target the default server and mint a
/// fresh identity in the base dir.
fn relogin_hint(server: &Url, dir: &Path) -> String {
    format!(
        "spawn: need an approval link for a new browser or device? run:\n\
         spawn:   spawnd login --no-run --server \"{server}\" --config-dir \"{}\"",
        dir.display()
    )
}

fn instance_account(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn resume_line(account: &str) -> String {
    format!("spawn: already possessed ({account}); daemon running in the background.")
}

/// Whether this run has to hold its own auth ceremony rather than resuming an
/// instance already on the machine.
///
/// A setup token forces one. It is minted by one signed-in browser for one
/// account, and presenting it says "this machine, that account" — a request a
/// machine that happens to hold some *other* account's instance cannot answer
/// by resuming it. Ignoring the token left the browser's setup screen waiting
/// for a ceremony that was never going to start, while the terminal cheerfully
/// reported the unrelated account it had resumed instead.
///
/// If the ceremony turns out to name an account already registered here, the
/// caller adopts that instance — the token is still redeemed, so the screen
/// that issued it resolves either way.
fn staged_login_required(
    existing_instances: usize,
    new_account: bool,
    setup_token: Option<&str>,
) -> bool {
    new_account || setup_token.is_some() || existing_instances == 0
}

/// Keep an account id safe as a directory component. Server account ids are
/// UUID-like, but never trust that for a path.
fn sanitize_account(account: &str) -> String {
    let cleaned: String = account
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('_').to_string();
    if cleaned.is_empty() {
        "account".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_account_keeps_uuids_and_neutralizes_paths() {
        assert_eq!(
            sanitize_account("9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"),
            "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
        );
        assert_eq!(sanitize_account("../../etc/passwd"), "etc_passwd");
        assert_eq!(sanitize_account("///"), "account");
    }

    #[test]
    fn relogin_hint_bakes_server_and_quotes_the_instance_dir() {
        let hint = relogin_hint(
            &Url::parse("https://spawn.example").unwrap(),
            Path::new("/Users/x/Library/Application Support/spawn/acct-1"),
        );
        assert!(hint.contains("spawnd login --no-run"));
        assert!(hint.contains("--server \"https://spawn.example/\""));
        assert!(hint.contains("--config-dir \"/Users/x/Library/Application Support/spawn/acct-1\""));
    }

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("a test URL")
    }

    /// A setup token belongs to the server whose signed-in browser minted it.
    /// Prompting would offer to send it somewhere it cannot be redeemed.
    #[test]
    fn a_setup_token_decides_the_server_without_asking() {
        let local = url("http://localhost:3000");
        assert_eq!(
            server_offer(
                Some("http://localhost:3000"),
                &local,
                Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                true,
            ),
            ServerOffer::Settled(local)
        );
    }

    /// The regression this exists for: `curl … localhost:3000 | sh` used to
    /// offer spawnd.dev as the default, so one Enter registered the machine
    /// against the hosted service — the opposite of what that command said.
    #[test]
    fn an_installer_origin_leads_the_choice_instead_of_the_hosted_service() {
        let local = url("http://localhost:3000");
        assert_eq!(
            server_offer(Some("http://localhost:3000"), &local, None, true),
            ServerOffer::Named(local)
        );
    }

    /// Installing from spawnd.dev names spawnd.dev, which is not a second
    /// answer beside itself — that is the plain hosted-or-self-host offer.
    #[test]
    fn the_hosted_origin_is_not_offered_twice() {
        assert_eq!(
            server_offer(
                Some("https://spawnd.dev"),
                &url("https://spawnd.dev"),
                None,
                true
            ),
            ServerOffer::Unnamed
        );
        // Nobody named one: the dev fallback is not a choice anyone made.
        assert_eq!(
            server_offer(None, &url("http://localhost:8000"), None, true),
            ServerOffer::Unnamed
        );
    }

    /// No terminal — `curl … | sh` with no /dev/tty, CI, a remote install —
    /// takes the resolved value rather than blocking on a prompt.
    #[test]
    fn a_headless_install_is_never_asked() {
        let local = url("http://localhost:3000");
        assert_eq!(
            server_offer(Some("http://localhost:3000"), &local, None, false),
            ServerOffer::Settled(local)
        );
    }

    #[test]
    fn an_origin_reads_as_a_person_would_write_it() {
        assert_eq!(origin_label(&url("https://spawnd.dev/")), "spawnd.dev");
        assert_eq!(origin_label(&url("http://localhost:3000/")), "localhost:3000");
        // Default ports stay implicit; a non-default one is part of the name.
        assert_eq!(origin_label(&url("http://example.test/")), "example.test");
        assert_eq!(origin_label(&url("https://example.test:8443/")), "example.test:8443");
    }

    /// The ceremony's last screen has one job: release the reader. Saying the
    /// terminal can be closed, and how to reach the daemon afterwards, is the
    /// difference between "done" and "is this still doing something?".
    #[test]
    fn the_closing_panel_releases_the_terminal_and_names_the_commands() {
        let rows = possessed_panel("Charlies-MacBook-Pro.local", "bad19924", 76);
        let plain: Vec<String> = rows
            .iter()
            .map(|row| crate::tui::strip_styles(row))
            .collect();
        let text = plain.join("\n");
        assert!(text.contains("close this terminal"));
        assert!(text.contains("Charlies-MacBook-Pro.local"));
        assert!(text.contains("bad19924"));
        for (command, _) in POSSESSED_COMMANDS {
            assert!(text.contains(command), "missing {command}");
        }
        let widths: Vec<usize> = rows.iter().map(|r| crate::tui::display_width(r)).collect();
        assert!(
            widths.iter().all(|w| *w == widths[0]),
            "ragged panel: {widths:?}"
        );
    }

    /// Piped and CI output stays the prefixed-line form, and still says the
    /// two things that matter.
    #[test]
    fn the_plain_close_out_says_the_same_thing_without_a_frame() {
        let lines = possessed_plain_lines("mac.local", "bad19924");
        let text = lines.join("\n");
        assert!(text.contains("spawn: mac.local is possessed (bad19924)."));
        assert!(text.contains("close this terminal"));
        assert!(text.contains("spawnd status"));
        assert!(lines.iter().all(|l| l.is_empty() || l.starts_with("spawn:")));
    }

    #[test]
    fn possess_reuses_the_login_step_prefix_so_indices_mean_one_thing() {
        assert_eq!(&POSSESS_STEPS[..3], &login::LOGIN_STEPS[..]);
        assert_eq!(POSSESS_STEPS[3], "Start background daemon");
    }

    /// Every row on the already-possessed menu maps to something the program
    /// does, and the rows shift when re-approval is not offered — so the
    /// mapping is pinned rather than left to index arithmetic.
    #[test]
    fn the_resume_menu_maps_every_row_to_an_action() {
        assert_eq!(resume_options(true).len(), 3);
        assert_eq!(resume_choice(0, true), ResumeAction::Keep);
        assert_eq!(resume_choice(1, true), ResumeAction::Reauthorize);
        assert_eq!(resume_choice(2, true), ResumeAction::NewAccount);
        assert_eq!(resume_choice(3, true), ResumeAction::Update);

        // With several accounts there is no single instance to re-approve, so
        // that row is absent and everything below it moves up one.
        assert_eq!(resume_options(false).len(), 2);
        assert_eq!(resume_choice(0, false), ResumeAction::Keep);
        assert_eq!(resume_choice(1, false), ResumeAction::NewAccount);
        assert_eq!(resume_choice(2, false), ResumeAction::Update);
    }

    /// No terminal, no question: a re-run of the same install command with
    /// nobody watching stays the no-op it always was.
    #[test]
    fn an_unattended_run_is_never_asked() {
        assert_eq!(resume_action(&[PathBuf::from("/tmp/a")]), ResumeAction::Keep);
    }

    #[test]
    fn plain_resume_line_is_byte_stable() {
        assert_eq!(
            resume_line("9f1c2d3e"),
            "spawn: already possessed (9f1c2d3e); daemon running in the background."
        );
    }

    #[test]
    fn new_account_forces_staging_and_plain_possess_never_adds_one_implicitly() {
        assert!(staged_login_required(0, false, None));
        assert!(!staged_login_required(1, false, None));
        assert!(!staged_login_required(3, false, None));
        assert!(staged_login_required(1, true, None));
        assert!(staged_login_required(3, true, None));
    }

    /// The regression: signing up a second account in the browser, pasting its
    /// `--setup` command on a machine that already held a different account,
    /// silently resumed the old one. The terminal said "already possessed for
    /// <the other account>" and the browser waited for ever.
    #[test]
    fn a_setup_token_always_holds_its_own_ceremony() {
        let token = Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert!(staged_login_required(1, false, token));
        assert!(staged_login_required(3, false, token));
        assert!(staged_login_required(0, false, token));
    }

    #[test]
    fn account_dirs_lists_only_registered_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let acct = base.join("acct-1");
        std::fs::create_dir_all(&acct).unwrap();
        std::fs::write(acct.join("credentials.json"), b"{}").unwrap();
        std::fs::create_dir_all(base.join("empty")).unwrap(); // no creds → skipped
        std::fs::create_dir_all(base.join(".possess-staging")).unwrap(); // hidden → skipped
        std::fs::write(
            base.join(".possess-staging").join("credentials.json"),
            b"{}",
        )
        .unwrap();

        let found = account_dirs_with_creds(base).unwrap();
        assert_eq!(found, vec![acct]);
    }
}
