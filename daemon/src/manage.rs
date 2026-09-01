//! Host management shared by the interactive TUI and scriptable CLI commands.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::cli::{
    ApprovalsArgs, ApprovalsCommand, InstancesArgs, InstancesCommand, PinsArgs, PinsCommand,
    SessionsArgs, SessionsCommand,
};

const API_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HostAccount {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HostSelf {
    pub host_id: String,
    pub name: String,
    pub account: HostAccount,
}

impl HostSelf {
    pub fn account_label(&self) -> &str {
        if let Some(display_name) = self
            .account
            .display_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
        {
            display_name.trim()
        } else if !self.account.email.trim().is_empty() {
            self.account.email.trim()
        } else {
            &self.account.id
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BrowserPin {
    pub pin_id: String,
    pub device_id: String,
    pub name: Option<String>,
    pub platform: Option<String>,
    pub kind: Option<String>,
    pub created_at: Option<String>,
    pub last_seen: Option<String>,
}

impl BrowserPin {
    pub fn label(&self) -> String {
        self.name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("browser {}", abbreviate(&self.device_id)))
    }

    pub fn detail(&self) -> String {
        self.platform
            .as_deref()
            .filter(|platform| !platform.trim().is_empty())
            .or(self.kind.as_deref().filter(|kind| !kind.trim().is_empty()))
            .unwrap_or("platform unknown")
            .to_owned()
    }
}

#[derive(Debug, Deserialize)]
struct BrowserPinsResponse {
    pins: Vec<BrowserPin>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PendingApproval {
    pub request_id: String,
    pub device_name: Option<String>,
    pub platform: Option<String>,
    pub requested_at: Option<String>,
    pub expires_at: Option<String>,
    #[serde(default)]
    pub admission: serde_json::Value,
}

impl PendingApproval {
    fn label(&self) -> String {
        self.device_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("device {}", abbreviate(&self.request_id)))
    }

    fn detail(&self) -> String {
        let platform = self
            .platform
            .as_deref()
            .filter(|platform| !platform.trim().is_empty())
            .unwrap_or("platform unknown")
            .to_owned();
        if self.admission.is_null() {
            platform
        } else if let Some(admission) = self.admission.as_str() {
            format!("{platform} · {admission}")
        } else {
            format!("{platform} · admission {}", self.admission)
        }
    }
}

#[derive(Debug, Deserialize)]
struct ApprovalsResponse {
    approvals: Vec<PendingApproval>,
}

/// Authenticated access to the fixed daemon-principal host-management API.
pub struct HostClient {
    server: Url,
    token: Zeroizing<String>,
    http: reqwest::Client,
}

impl HostClient {
    pub fn load(server_cli: Option<String>) -> Result<Self> {
        let stored = crate::creds::load().context("loading stored credentials")?;
        let server =
            crate::config::server_url_for_instance(server_cli, stored.server_url.as_deref())?;
        let token = stored
            .access_token
            .as_deref()
            .filter(|token| !token.is_empty())
            .context("this machine is not signed in")?;
        let http = reqwest::Client::builder().timeout(API_TIMEOUT).build()?;
        Ok(Self {
            server,
            token: Zeroizing::new(token.to_owned()),
            http,
        })
    }

    pub async fn host(&self) -> Result<Option<HostSelf>> {
        self.get_optional("/api/hosts/self").await
    }

    pub async fn pins(&self) -> Result<Option<Vec<BrowserPin>>> {
        Ok(self
            .get_optional::<BrowserPinsResponse>("/api/hosts/self/pins")
            .await?
            .map(|response| response.pins))
    }

    pub async fn approvals(&self) -> Result<Option<Vec<PendingApproval>>> {
        Ok(self
            .get_optional::<ApprovalsResponse>("/api/hosts/self/approvals")
            .await?
            .map(|response| response.approvals))
    }

    pub async fn remove_pin(&self, pin_id: &str) -> Result<bool> {
        let encoded: String = url::form_urlencoded::byte_serialize(pin_id.as_bytes()).collect();
        self.delete_optional(&format!("/api/hosts/self/pins/{encoded}"))
            .await
    }

    pub async fn clear_pins(&self) -> Result<bool> {
        self.delete_optional("/api/hosts/self/pins").await
    }

    pub async fn approve(&self, request_id: &str) -> Result<bool> {
        #[derive(Serialize)]
        struct Request<'a> {
            request_id: &'a str,
        }
        let url = crate::config::api_url(&self.server, "/api/hosts/self/pins")?;
        let response = self
            .http
            .post(url)
            .bearer_auth(self.token.as_str())
            .json(&Request { request_id })
            .send()
            .await
            .context("approving the pending device")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(false);
        }
        ensure_success(response.status(), "approving the pending device")?;
        Ok(true)
    }

    async fn get_optional<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<Option<T>> {
        let url = crate::config::api_url(&self.server, path)?;
        let response = self
            .http
            .get(url)
            .bearer_auth(self.token.as_str())
            .send()
            .await
            .with_context(|| format!("requesting {path}"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        ensure_success(response.status(), path)?;
        response
            .json()
            .await
            .with_context(|| format!("decoding {path}"))
            .map(Some)
    }

    async fn delete_optional(&self, path: &str) -> Result<bool> {
        let url = crate::config::api_url(&self.server, path)?;
        let response = self
            .http
            .delete(url)
            .bearer_auth(self.token.as_str())
            .send()
            .await
            .with_context(|| format!("requesting DELETE {path}"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(false);
        }
        ensure_success(response.status(), path)?;
        Ok(true)
    }
}

/// Refresh the non-secret label opportunistically after the daemon registers.
/// This must never hold up registration or turn an older server into a daemon
/// failure; its only consumer is local human-facing account selection.
pub(crate) async fn refresh_account_label() {
    let config_dir = match crate::config::config_dir() {
        Ok(config_dir) => config_dir,
        Err(error) => {
            tracing::debug!(%error, "account label cache has no config directory");
            return;
        }
    };
    let client = match tokio::task::spawn_blocking(|| HostClient::load(None)).await {
        Ok(Ok(client)) => client,
        Ok(Err(error)) => {
            tracing::debug!(%error, "account label cache has no authenticated client");
            return;
        }
        Err(error) => {
            tracing::debug!(%error, "account label cache task did not finish");
            return;
        }
    };
    match client.host().await {
        Ok(Some(host)) => {
            if let Err(error) =
                crate::state::remember_account_label(&config_dir, host.account_label())
            {
                tracing::warn!(%error, "caching the account label");
            }
        }
        Ok(None) => {}
        Err(error) => tracing::debug!(%error, "account label refresh unavailable"),
    }
}

fn ensure_success(status: StatusCode, operation: &str) -> Result<()> {
    if status.is_success() {
        return Ok(());
    }
    if status == StatusCode::UNAUTHORIZED {
        return Err(crate::login::user_error(
            "The server no longer accepts this machine's sign-in. Approve this machine again before managing it.",
        ));
    }
    bail!("{operation}: HTTP {status}")
}

fn unsupported(feature: &str) -> anyhow::Error {
    crate::login::user_error(format!(
        "Your SPAWN D server doesn't support {feature} yet. Update the server, then try again."
    ))
}

pub async fn run_pins(server_cli: Option<String>, args: PinsArgs) -> Result<()> {
    let client = HostClient::load(server_cli)?;
    match args.command {
        None => print_pins(&client).await,
        Some(PinsCommand::Remove { pin_id }) => {
            if !client.remove_pin(&pin_id).await? {
                return Err(unsupported("browser connection removal"));
            }
            sync_local_pins(&client).await;
            println!("spawn: removed browser connection {pin_id}.");
            Ok(())
        }
        Some(PinsCommand::Clear { yes }) => {
            if !yes
                && !crate::tui::confirm(
                    "Clear every browser connection from this SPAWN D machine?",
                )?
            {
                println!("spawn: browser connections unchanged.");
                return Ok(());
            }
            if !client.clear_pins().await? {
                return Err(unsupported("clearing browser connections"));
            }
            let _ = crate::creds::prune_browser_pins_to_live_set(&[]);
            println!("spawn: cleared all browser connections.");
            Ok(())
        }
    }
}

async fn print_pins(client: &HostClient) -> Result<()> {
    match client.pins().await? {
        Some(pins) if pins.is_empty() => println!("No browser connections."),
        Some(pins) => {
            println!("Browser connections:");
            for pin in pins {
                println!("  {}  {} ({})", pin.pin_id, pin.label(), pin.detail());
            }
        }
        None => {
            println!("Your SPAWN D server doesn't support named browser connections yet.");
            let stored = crate::creds::load()?;
            if stored.browser_pins().is_empty() {
                println!("No locally recorded browser connections.");
            } else {
                println!("Locally recorded browser connections:");
                for pin in stored.browser_pins() {
                    println!("  {}  {}", pin.device_id(), pin.fingerprint());
                }
            }
        }
    }
    Ok(())
}

pub async fn run_approvals(server_cli: Option<String>, args: ApprovalsArgs) -> Result<()> {
    let client = HostClient::load(server_cli)?;
    match args.command {
        None => match client.approvals().await? {
            Some(approvals) if approvals.is_empty() => println!("No pending device approvals."),
            Some(approvals) => {
                println!("Pending device approvals:");
                for approval in approvals {
                    println!(
                        "  {}  {} ({})",
                        approval.request_id,
                        approval.label(),
                        approval.detail()
                    );
                }
            }
            None => println!(
                "Your SPAWN D server doesn't support pending device approvals yet. Update the server to manage them here."
            ),
        },
        Some(ApprovalsCommand::Approve { request_id }) => {
            if !client.approve(&request_id).await? {
                return Err(unsupported("device approval from the daemon"));
            }
            println!("spawn: approved pending device {request_id}.");
        }
    }
    Ok(())
}

pub async fn run_sessions(args: SessionsArgs) -> Result<()> {
    let mut ids = crate::worker_backend::discover_ids();
    ids.sort_unstable();
    match args.command {
        None if ids.is_empty() => println!("No running session workers."),
        None => {
            println!("Running session workers:");
            for id in ids {
                println!("  {id}");
            }
        }
        Some(SessionsCommand::Kill { session_id }) => {
            let id = Uuid::parse_str(&session_id).context("session ID must be a UUID")?;
            if terminate_session(id).await? {
                println!("spawn: stopped session {id}.");
            } else {
                println!("spawn: session {id} is not running.");
            }
        }
    }
    Ok(())
}

pub async fn run_instances(
    server_cli: Option<String>,
    args: InstancesArgs,
    explicit_config: bool,
) -> Result<()> {
    let dirs = selected_dirs(explicit_config)?;
    match args.command {
        None => {
            println!("SPAWN D account instances on this machine: {}", dirs.len());
            for dir in dirs {
                println!(
                    "  {}  {}",
                    instance_label(&dir),
                    instance_server(&dir).unwrap_or_else(|| "server unknown".into())
                );
            }
            Ok(())
        }
        Some(InstancesCommand::Exorcise { instance, yes }) => {
            let dir = resolve_instance(&dirs, &instance)?;
            crate::possess::exorcise_specific(server_cli, &dir, yes).await
        }
    }
}

pub async fn run_menu(server_cli: Option<String>, explicit_config: bool) -> Result<()> {
    if !std::io::stdin().is_terminal() {
        return Err(crate::login::user_error(
            "Manage this machine needs an interactive terminal. The pins, approvals, sessions, and instances subcommands provide the same operations for scripts.",
        ));
    }
    loop {
        let dirs = selected_dirs(explicit_config)?;
        if dirs.is_empty() {
            println!("spawn: no SPAWN D account instances are set up on this machine.");
            return Ok(());
        }
        let Some(dir) = choose_instance(&dirs) else {
            return Ok(());
        };
        let _guard = ConfigDirGuard::set(&dir);
        let account = instance_label(&dir);
        let options = [
            ("Browser connections", "list, remove one, or clear all"),
            (
                "Pending device approvals",
                "review and approve a waiting device",
            ),
            ("Running sessions", "list or stop one session worker"),
            (
                "Remove this account instance",
                "deregister it and remove local state",
            ),
            ("Back", "choose another account or finish"),
        ];
        match crate::tui::prompt_choice(&format!("MANAGE {account}"), &options, 4) {
            0 => browser_menu(server_cli.clone()).await?,
            1 => approvals_menu(server_cli.clone()).await?,
            2 => sessions_menu().await?,
            3 => {
                if confirm_choice(
                    "REMOVE THIS ACCOUNT INSTANCE?",
                    &format!("Remove {account}"),
                    "deregisters this machine and removes its local state",
                ) {
                    drop(_guard);
                    crate::possess::exorcise_specific(server_cli.clone(), &dir, true).await?;
                    return Ok(());
                }
            }
            _ => {
                if dirs.len() == 1 {
                    return Ok(());
                }
            }
        }
    }
}

async fn browser_menu(server_cli: Option<String>) -> Result<()> {
    let client = HostClient::load(server_cli)?;
    let Some(pins) = client.pins().await? else {
        crate::tui::log_line(
            "Your SPAWN D server doesn't support browser connection management yet.",
        );
        return Ok(());
    };
    if pins.is_empty() {
        crate::tui::log_line("No browser connections are approved for this machine.");
        return Ok(());
    }
    let labels = pins.iter().map(BrowserPin::label).collect::<Vec<_>>();
    let details = pins.iter().map(BrowserPin::detail).collect::<Vec<_>>();
    let mut options = labels
        .iter()
        .zip(&details)
        .map(|(label, detail)| (label.as_str(), detail.as_str()))
        .collect::<Vec<_>>();
    options.push(("Clear all browser connections", "requires confirmation"));
    options.push(("Back", "leave connections unchanged"));
    let picked = crate::tui::prompt_choice("BROWSER CONNECTIONS", &options, options.len() - 1);
    if picked < pins.len() {
        let pin = &pins[picked];
        if confirm_choice(
            "REMOVE BROWSER CONNECTION?",
            &format!("Remove {}", pin.label()),
            &pin.detail(),
        ) {
            if client.remove_pin(&pin.pin_id).await? {
                sync_local_pins(&client).await;
                crate::tui::log_line(&format!("Removed {}.", pin.label()));
            } else {
                crate::tui::log_line(
                    "Your SPAWN D server doesn't support browser connection removal yet.",
                );
            }
        }
    } else if picked == pins.len()
        && confirm_choice(
            "CLEAR ALL BROWSER CONNECTIONS?",
            "Clear every connection",
            "all browsers must be approved again",
        )
    {
        if client.clear_pins().await? {
            let _ = crate::creds::prune_browser_pins_to_live_set(&[]);
            crate::tui::log_line("Cleared every browser connection for this machine.");
        } else {
            crate::tui::log_line(
                "Your SPAWN D server doesn't support clearing browser connections yet.",
            );
        }
    }
    Ok(())
}

async fn approvals_menu(server_cli: Option<String>) -> Result<()> {
    let client = HostClient::load(server_cli)?;
    let Some(approvals) = client.approvals().await? else {
        crate::tui::log_line("Your SPAWN D server doesn't support pending device approvals yet.");
        return Ok(());
    };
    if approvals.is_empty() {
        crate::tui::log_line("No devices are waiting for you to approve.");
        return Ok(());
    }
    let labels = approvals
        .iter()
        .map(PendingApproval::label)
        .collect::<Vec<_>>();
    let details = approvals
        .iter()
        .map(PendingApproval::detail)
        .collect::<Vec<_>>();
    let mut options = labels
        .iter()
        .zip(&details)
        .map(|(label, detail)| (label.as_str(), detail.as_str()))
        .collect::<Vec<_>>();
    options.push(("Back", "approve nothing"));
    let picked = crate::tui::prompt_choice(
        "DEVICES WAITING FOR YOUR APPROVAL",
        &options,
        options.len() - 1,
    );
    if let Some(approval) = approvals.get(picked) {
        if client.approve(&approval.request_id).await? {
            crate::tui::log_line(&format!("Approved {}.", approval.label()));
        } else {
            crate::tui::log_line("Your SPAWN D server doesn't support approving devices here yet.");
        }
    }
    Ok(())
}

async fn sessions_menu() -> Result<()> {
    let mut ids = crate::worker_backend::discover_ids();
    ids.sort_unstable();
    if ids.is_empty() {
        crate::tui::log_line("No session workers are running for this account.");
        return Ok(());
    }
    let labels = ids
        .iter()
        .map(|id| format!("Session {id}"))
        .collect::<Vec<_>>();
    let mut options = labels
        .iter()
        .map(|label| (label.as_str(), "running worker"))
        .collect::<Vec<_>>();
    options.push(("Back", "leave sessions running"));
    let picked = crate::tui::prompt_choice("RUNNING SESSIONS", &options, options.len() - 1);
    if let Some(id) = ids.get(picked).copied() {
        if confirm_choice(
            "STOP THIS SESSION?",
            &format!("Stop {id}"),
            "the session process will be terminated",
        ) {
            if terminate_session(id).await? {
                crate::tui::log_line(&format!("Stopped session {id}."));
            } else {
                crate::tui::log_line(&format!("Session {id} had already stopped."));
            }
        }
    }
    Ok(())
}

fn confirm_choice(title: &str, action: &str, detail: &str) -> bool {
    crate::tui::prompt_choice(
        title,
        &[("Keep everything", "make no changes"), (action, detail)],
        0,
    ) == 1
}

async fn terminate_session(id: Uuid) -> Result<bool> {
    let Some(launched) = crate::worker_backend::adopt(id).await? else {
        return Ok(false);
    };
    let lifecycle = launched.handle.lifecycle();
    let _ = lifecycle
        .shutdown(spawnd::sessiond::wire::LifecycleSignal::Term)
        .await;
    for _ in 0..15 {
        if !crate::worker_backend::socket_exists(id) {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = lifecycle
        .shutdown(spawnd::sessiond::wire::LifecycleSignal::Kill)
        .await;
    Ok(true)
}

async fn sync_local_pins(client: &HostClient) {
    if let Ok(Some(pins)) = client.pins().await {
        let live = pins
            .into_iter()
            .map(|pin| pin.device_id)
            .collect::<Vec<_>>();
        if let Err(error) = crate::creds::prune_browser_pins_to_live_set(&live) {
            tracing::warn!(%error, "updating the local browser connection list");
        }
    }
}

pub(crate) fn selected_dirs(explicit_config: bool) -> Result<Vec<PathBuf>> {
    if explicit_config {
        return Ok(vec![crate::config::config_dir()?]);
    }
    let base = crate::possess::default_instance_base()?;
    let dirs = crate::possess::account_dirs_with_creds(&base)?;
    if dirs.is_empty() {
        let legacy = crate::config::config_dir()?;
        Ok(legacy
            .join("credentials.json")
            .is_file()
            .then_some(legacy)
            .into_iter()
            .collect())
    } else {
        Ok(dirs)
    }
}

fn choose_instance(dirs: &[PathBuf]) -> Option<PathBuf> {
    if dirs.len() == 1 {
        return Some(dirs[0].clone());
    }
    let labels = dirs
        .iter()
        .map(|dir| instance_label(dir))
        .collect::<Vec<_>>();
    let details = dirs
        .iter()
        .map(|dir| instance_server(dir).unwrap_or_else(|| "server unknown".into()))
        .collect::<Vec<_>>();
    let mut options = labels
        .iter()
        .zip(&details)
        .map(|(label, detail)| (label.as_str(), detail.as_str()))
        .collect::<Vec<_>>();
    options.push(("Done", "leave machine management"));
    let picked =
        crate::tui::prompt_choice("CHOOSE AN ACCOUNT INSTANCE", &options, options.len() - 1);
    dirs.get(picked).cloned()
}

fn resolve_instance(dirs: &[PathBuf], requested: &str) -> Result<PathBuf> {
    if let Some(exact) = dirs.iter().find(|dir| instance_name(dir) == requested) {
        return Ok(exact.clone());
    }
    let matches = dirs
        .iter()
        .filter(|dir| {
            instance_label(dir) == requested
                || crate::state::shorten_account_id(&instance_name(dir)) == requested
        })
        .cloned()
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(anyhow::anyhow!(
            "no SPAWN D account instance named {requested:?}"
        )),
        _ => Err(anyhow::anyhow!(
            "more than one SPAWN D account instance is named {requested:?}"
        )),
    }
}

pub(crate) fn instance_name(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "default".into())
}

fn instance_label(dir: &Path) -> String {
    crate::state::human_account_label(dir)
}

pub(crate) fn instance_server(dir: &Path) -> Option<String> {
    let bytes = std::fs::read(dir.join("credentials.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("server_url")
        .and_then(serde_json::Value::as_str)
        .filter(|server| !server.is_empty())
        .map(str::to_owned)
}

fn abbreviate(value: &str) -> String {
    if value.chars().count() <= 12 {
        value.to_owned()
    } else {
        format!("{}…", value.chars().take(12).collect::<String>())
    }
}

pub(crate) struct ConfigDirGuard(Option<std::ffi::OsString>);

impl ConfigDirGuard {
    pub(crate) fn set(dir: &Path) -> Self {
        let previous = std::env::var_os("SPAWN_CONFIG_DIR");
        std::env::set_var("SPAWN_CONFIG_DIR", dir);
        Self(previous)
    }
}

impl Drop for ConfigDirGuard {
    fn drop(&mut self) {
        match self.0.take() {
            Some(previous) => std::env::set_var("SPAWN_CONFIG_DIR", previous),
            None => std::env::remove_var("SPAWN_CONFIG_DIR"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_labels_prefer_names_and_platforms() {
        let pin = BrowserPin {
            pin_id: "pin-1".into(),
            device_id: "device-1".into(),
            name: Some("Charlie's MacBook".into()),
            platform: Some("macOS".into()),
            kind: Some("browser".into()),
            created_at: None,
            last_seen: None,
        };
        assert_eq!(pin.label(), "Charlie's MacBook");
        assert_eq!(pin.detail(), "macOS");

        let host = HostSelf {
            host_id: "host-1".into(),
            name: "studio".into(),
            account: HostAccount {
                id: "account-1".into(),
                email: "charlie@example.com".into(),
                display_name: Some("Charlie".into()),
            },
        };
        assert_eq!(host.account_label(), "Charlie");
    }

    #[test]
    fn old_server_fallback_labels_are_still_meaningful() {
        let pin = BrowserPin {
            pin_id: "pin-1".into(),
            device_id: "1234567890abcdef".into(),
            name: None,
            platform: None,
            kind: None,
            created_at: None,
            last_seen: None,
        };
        assert_eq!(pin.label(), "browser 1234567890ab…");
        assert_eq!(pin.detail(), "platform unknown");
    }

    #[test]
    fn account_instances_resolve_by_exact_or_short_human_identifier() {
        let dir = PathBuf::from("/tmp/spawn/6eea3a19-ffdd-43c0-82ab-67ce091c13c7");
        let dirs = vec![dir.clone()];
        assert_eq!(
            resolve_instance(&dirs, "6eea3a19-ffdd-43c0-82ab-67ce091c13c7").unwrap(),
            dir
        );
        assert_eq!(resolve_instance(&dirs, "6eea3a19…13c7").unwrap(), dir);
    }
}
