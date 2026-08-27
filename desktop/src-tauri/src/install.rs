use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use futures_util::StreamExt;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::api::ApiClient;
use crate::crypto::{key_fingerprint, DeviceIdentity};
use crate::models::{
    ApprovalReview, DeviceApproveResponse, DevicePending, PossessionProgress, PossessionStatus,
};
use crate::storage;

const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_BINARY_BYTES: usize = 256 * 1024 * 1024;
const RELEASE_SIGNING_PUBLIC_KEYS: &[&str] = &["8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0"];
const VERIFICATION_REFUSAL: &str = "This host could not be verified.";
/// This Mac already runs SPAWN D for the account signed in here.
const ALREADY_POSSESSED_HERE: &str = "already_possessed_here";
/// This Mac already runs SPAWN D, for some other account.
const ALREADY_POSSESSED_OTHER: &str = "already_possessed_other";
/// The child ended without a ceremony and without saying why.
const NO_CEREMONY: &str = "no_ceremony";

#[derive(Debug, Deserialize)]
struct SignedManifest {
    targets: HashMap<String, TargetManifest>,
}

#[derive(Debug, Deserialize)]
struct TargetManifest {
    spawnd_sha256: String,
    spawn_worker_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ApprovalIdentifier {
    ApprovalRef(String),
    UserCode(String),
}

impl ApprovalIdentifier {
    fn request_body(&self) -> Value {
        match self {
            Self::ApprovalRef(value) => json!({ "approval_ref": value }),
            Self::UserCode(value) => json!({ "user_code": value }),
        }
    }

    fn insert_into(&self, body: &mut Value) {
        let (field, value) = match self {
            Self::ApprovalRef(value) => ("approval_ref", value),
            Self::UserCode(value) => ("user_code", value),
        };
        body.as_object_mut()
            .expect("approval request body is an object")
            .insert(field.into(), Value::String(value.clone()));
    }
}

#[derive(Clone, Default)]
struct PossessRun {
    approval_identifier: Option<ApprovalIdentifier>,
    local_key: Option<String>,
    approved: bool,
    online: bool,
    error: Option<String>,
    host_name: Option<String>,
    host_id: Option<String>,
    child_finished: bool,
    child_error: Option<String>,
    output: Vec<String>,
    introduction_published: bool,
}

#[derive(Default)]
pub struct PossessionManager {
    runs: std::sync::Arc<Mutex<HashMap<String, PossessRun>>>,
}

impl PossessionManager {
    pub async fn begin(&self, app: &AppHandle) -> Result<String> {
        let preferences = storage::load_preferences()?;
        if !preferences.device_approved {
            bail!("Approve this device before possessing this Mac")
        }
        let api = ApiClient::new(&preferences.server_origin)?;
        let pair = download_verified_pair(&api).await.map_err(|error| {
            let detail = error.to_string();
            if detail.contains("doesn't serve a build for this Mac") {
                anyhow::anyhow!(detail)
            } else {
                anyhow::anyhow!("The daemon didn't verify. Nothing was installed.")
            }
        })?;
        let bin_dir = install_pair(pair)?;
        let run_id = new_run_id()?;
        self.runs
            .lock()
            .await
            .insert(run_id.clone(), PossessRun::default());
        self.spawn_possess(
            app.clone(),
            run_id.clone(),
            bin_dir.join("spawnd"),
            preferences.server_origin,
        )
        .await
        .map_err(|_| anyhow::anyhow!("The daemon installed but its service didn't start."))?;
        emit_step(app, 0, "Daemon downloaded and verified");
        Ok(run_id)
    }

    async fn spawn_possess(
        &self,
        app: AppHandle,
        run_id: String,
        spawnd: PathBuf,
        origin: String,
    ) -> Result<()> {
        let mut child = Command::new(spawnd)
            .arg("--server")
            .arg(origin)
            .arg("possess")
            .arg("--no-browser")
            .arg("--no-qr")
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("starting spawnd possess")?;
        let stdout = child.stdout.take().context("capturing spawnd output")?;
        let stderr = child.stderr.take().context("capturing spawnd errors")?;
        let stdout_runs = self.runs.clone();
        let stdout_run_id = run_id.clone();
        let stdout_app = app.clone();
        tauri::async_runtime::spawn(async move {
            read_child_lines(stdout, &stdout_runs, &stdout_run_id, &stdout_app).await;
        });
        let stderr_runs = self.runs.clone();
        let stderr_run_id = run_id.clone();
        let stderr_app = app.clone();
        tauri::async_runtime::spawn(async move {
            read_child_lines(stderr, &stderr_runs, &stderr_run_id, &stderr_app).await;
        });
        let runs = self.runs.clone();
        tauri::async_runtime::spawn(async move {
            let result = child.wait().await;
            let mut locked = runs.lock().await;
            if let Some(run) = locked.get_mut(&run_id) {
                run.child_finished = true;
                run.child_error = match result {
                    Ok(status) if status.success() => None,
                    Ok(status) => Some(format!("spawnd possess exited with {status}")),
                    Err(error) => Some(format!("could not wait for spawnd possess: {error}")),
                };
            }
            let _ = app.emit("possess-child-finished", ());
        });
        Ok(())
    }

    pub async fn poll(&self, app: &AppHandle, run_id: &str) -> Result<PossessionProgress> {
        let preferences = storage::load_preferences()?;
        let api = ApiClient::new(&preferences.server_origin)?;
        let mut snapshot = self.snapshot(run_id).await?;
        let mut review = None;

        // The child is gone and never asked for anything to be approved. That
        // is not "still registering", and a run left in it waits for ever: the
        // one spinner on the gate spun on a machine where nothing at all was
        // happening any more. Say which of the two things happened and stop.
        if snapshot.child_finished
            && !snapshot.approved
            && snapshot.approval_identifier.is_none()
            && snapshot.error.is_none()
            && snapshot.child_error.is_none()
        {
            let detail =
                finished_without_ceremony(&snapshot.output, preferences.account_id.as_deref());
            self.fail_run(run_id, detail).await;
            snapshot = self.snapshot(run_id).await?;
            return Ok(possession_progress(run_id, snapshot, None));
        }

        if matches!(progress_status(&snapshot), PossessionStatus::Registered) {
            match self.review(&api, &snapshot).await {
                Ok(pending_review) => {
                    if let Some(pending_review) = pending_review {
                        if let Some(run) = self.runs.lock().await.get_mut(run_id) {
                            run.host_name = Some(pending_review.host_name.clone());
                        }
                        review = Some(pending_review);
                    }
                }
                Err(error) => {
                    let detail = error.to_string();
                    if detail == VERIFICATION_REFUSAL || known_possession_failure(&detail) {
                        self.fail_run(run_id, detail).await;
                        snapshot = self.snapshot(run_id).await?;
                        return Ok(possession_progress(run_id, snapshot, None));
                    }
                    return Err(error);
                }
            }
        }

        snapshot = self.snapshot(run_id).await?;
        if snapshot.approved {
            let hosts: Value = api.authenticated_get("/api/hosts").await?;
            let observed = match observe_pinned_host(
                &hosts,
                snapshot.host_id.as_deref(),
                snapshot
                    .local_key
                    .as_deref()
                    .context(VERIFICATION_REFUSAL)?,
            ) {
                Ok(observed) => observed,
                Err(error) => {
                    self.fail_run(run_id, error.to_string()).await;
                    snapshot = self.snapshot(run_id).await?;
                    return Ok(possession_progress(run_id, snapshot, None));
                }
            };
            if let Some(host) = observed {
                if let Some(run) = self.runs.lock().await.get_mut(run_id) {
                    run.host_id = Some(host.id.clone());
                    run.host_name = Some(host.name.clone());
                    run.online = host.online;
                }
                self.publish_introduction(
                    &api,
                    run_id,
                    &host.id,
                    &host.name,
                    snapshot
                        .local_key
                        .as_deref()
                        .context(VERIFICATION_REFUSAL)?,
                )
                .await;
                if host.online {
                    emit_step(app, 3, "Online and ready");
                    let mut updated = preferences;
                    updated.first_run_complete = true;
                    updated.host_name = Some(host.name);
                    storage::save_preferences(&updated)?;
                }
            }
        }

        snapshot = self.snapshot(run_id).await?;
        Ok(possession_progress(run_id, snapshot, review))
    }

    async fn review(&self, api: &ApiClient, run: &PossessRun) -> Result<Option<ApprovalReview>> {
        let (Some(identifier), Some(local_key)) =
            (run.approval_identifier.as_ref(), run.local_key.as_deref())
        else {
            return Ok(None);
        };
        let pending: DevicePending = api
            .authenticated_json(
                Method::POST,
                "/api/auth/device/pending",
                &identifier.request_body(),
            )
            .await?;
        let derived = key_fingerprint(&pending.host_public_key)?;
        let exact_key_match = local_key == pending.host_public_key;
        if derived != pending.host_key_fingerprint || !exact_key_match {
            bail!(VERIFICATION_REFUSAL)
        }
        Ok(Some(ApprovalReview {
            host_name: pending.host_name,
            exact_key_match,
        }))
    }

    pub async fn approve(&self, app: &AppHandle, run_id: &str) -> Result<String> {
        let preferences = storage::load_preferences()?;
        let account_id = preferences.account_id.context("Sign in before approval")?;
        let device_id = preferences
            .device_id
            .context("Device registration is unavailable")?;
        let api = ApiClient::new(&preferences.server_origin)?;
        let snapshot = self.snapshot(run_id).await?;
        if let Some(error) = snapshot.error.as_deref() {
            bail!("{error}")
        }
        let identifier = snapshot
            .approval_identifier
            .as_ref()
            .context("The daemon is not ready for approval")?;
        let local_key = snapshot
            .local_key
            .as_deref()
            .context(VERIFICATION_REFUSAL)?;
        let pending_result: Result<DevicePending> = api
            .authenticated_json(
                Method::POST,
                "/api/auth/device/pending",
                &identifier.request_body(),
            )
            .await;
        let pending = match pending_result {
            Ok(pending) => pending,
            Err(error) => {
                if known_possession_failure(&error.to_string()) {
                    self.fail_run(run_id, error.to_string()).await;
                }
                return Err(error);
            }
        };
        let derived_fingerprint = key_fingerprint(&pending.host_public_key)?;
        if derived_fingerprint != pending.host_key_fingerprint
            || local_key != pending.host_public_key
        {
            self.fail_run(run_id, VERIFICATION_REFUSAL.into()).await;
            bail!(VERIFICATION_REFUSAL)
        }
        let identity = DeviceIdentity::load_or_create(&account_id)?;
        let browser_public_key = identity.public_key_wire();
        let browser_fingerprint = key_fingerprint(&browser_public_key)?;
        let signature = identity.host_approval_proof(
            &account_id,
            &pending.approval_nonce,
            &pending.host_public_key,
        )?;
        let mut approve_body = json!({
            "approval_nonce": pending.approval_nonce,
            "host_key_algorithm": pending.host_key_algorithm,
            "host_public_key": pending.host_public_key,
            "host_key_fingerprint": pending.host_key_fingerprint,
            "browser_device_id": device_id,
            "browser_key_algorithm": "ed25519",
            "browser_public_key": browser_public_key,
            "browser_key_fingerprint": browser_fingerprint,
            "signature": signature
        });
        identifier.insert_into(&mut approve_body);
        let response_result: Result<DeviceApproveResponse> = api
            .authenticated_json(Method::POST, "/api/auth/device/approve", &approve_body)
            .await;
        let response = match response_result {
            Ok(response) => response,
            Err(error) => {
                if known_possession_failure(&error.to_string()) {
                    self.fail_run(run_id, error.to_string()).await;
                }
                return Err(error);
            }
        };
        if response.host_name != pending.host_name
            || response.approval_nonce != pending.approval_nonce
            || response.host_key_algorithm != pending.host_key_algorithm
            || response.host_public_key != pending.host_public_key
            || response.browser_device_id != device_id
            || response.browser_key_algorithm != "ed25519"
            || response.browser_public_key != browser_public_key
        {
            let error = "The approval response changed the reviewed host or device identity";
            self.fail_run(run_id, error.into()).await;
            bail!(error)
        }
        if let Some(run) = self.runs.lock().await.get_mut(run_id) {
            run.approved = true;
            run.host_name = Some(response.host_name.clone());
            run.host_id.clone_from(&response.host_id);
        }
        emit_step(app, 2, "Approved — key verified on this machine");
        if let Some(host_id) = response.host_id.as_deref() {
            self.publish_introduction(
                &api,
                run_id,
                host_id,
                &response.host_name,
                &pending.host_public_key,
            )
            .await;
        }
        Ok(response.host_name)
    }

    async fn publish_introduction(
        &self,
        api: &ApiClient,
        run_id: &str,
        host_id: &str,
        host_name: &str,
        host_public_key: &str,
    ) {
        let already_published = self
            .runs
            .lock()
            .await
            .get(run_id)
            .is_some_and(|run| run.introduction_published);
        if already_published {
            return;
        }
        let result = async {
            let preferences = storage::load_preferences()?;
            let account_id = preferences.account_id.context("missing account id")?;
            let device_id = preferences.device_id.context("missing device id")?;
            let identity = DeviceIdentity::load_or_create(&account_id)?;
            let signature = identity.host_introduction_proof(&account_id, host_public_key)?;
            let _: serde_json::Value = api
                .authenticated_json(
                    Method::POST,
                    "/api/trust/host-introductions",
                    &json!({
                        "publisher_device_id": device_id,
                        "host_id": host_id,
                        "host_name": host_name,
                        "host_public_key": host_public_key,
                        "signature": signature
                    }),
                )
                .await?;
            Result::<()>::Ok(())
        }
        .await;
        if result.is_ok() {
            if let Some(run) = self.runs.lock().await.get_mut(run_id) {
                run.introduction_published = true;
            }
        }
        // Best-effort here; polling the approved run retries publication while
        // this desktop run remains active.
    }

    pub async fn log_tail(&self, run_id: &str) -> String {
        self.runs
            .lock()
            .await
            .get(run_id)
            .map(|run| run.output.join("\n"))
            .unwrap_or_default()
    }

    async fn snapshot(&self, run_id: &str) -> Result<PossessRun> {
        self.runs
            .lock()
            .await
            .get(run_id)
            .cloned()
            .context("this possession run is no longer available")
    }

    async fn fail_run(&self, run_id: &str, error: String) {
        if let Some(run) = self.runs.lock().await.get_mut(run_id) {
            run.error = Some(error);
        }
    }
}

fn new_run_id() -> Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).context("generating a possession run id")?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(Uuid::from_bytes(bytes).to_string())
}

/// Why `spawnd possess` came back with nothing to approve.
///
/// A machine that already carries an instance is *resumed*, not possessed
/// again: with no terminal to ask (the app gives the child no stdin), keeping
/// what is there is the only safe answer, so the daemon makes sure its service
/// is running, prints which account it belongs to, and exits. Nothing is wrong
/// — there is simply no ceremony here to wait for, and which account it named
/// decides what to offer next.
fn finished_without_ceremony(output: &[String], account_id: Option<&str>) -> String {
    let Some(account) = resumed_account(output) else {
        return NO_CEREMONY.into();
    };
    match account_id {
        Some(ours) if sanitize_account(ours) == account => ALREADY_POSSESSED_HERE.into(),
        _ => ALREADY_POSSESSED_OTHER.into(),
    }
}

/// The account named by the daemon's own resume line, which is the instance
/// directory it kept — `spawn: already possessed (<account>); …`.
fn resumed_account(output: &[String]) -> Option<String> {
    output.iter().rev().find_map(|line| {
        let rest = line.split_once("already possessed (")?.1;
        let account = rest.split_once(')')?.0.trim();
        (!account.is_empty()).then(|| account.to_string())
    })
}

/// The daemon's own instance-directory naming (`possess::sanitize_account`),
/// restated here because the comparison happens on this side of the process
/// boundary and the daemon keeps its copy private.
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
        "account".into()
    } else {
        cleaned
    }
}

fn known_possession_failure(detail: &str) -> bool {
    matches!(
        detail,
        "expired" | "denied" | "key_conflict" | "pin_conflict" | "pin_limit"
    )
}

fn progress_status(run: &PossessRun) -> PossessionStatus {
    if run.online {
        PossessionStatus::Online
    } else if run.error.is_some() || run.child_error.is_some() {
        PossessionStatus::Failed
    } else if run.approved {
        PossessionStatus::Approved
    } else if run.approval_identifier.is_some() && run.local_key.is_some() {
        PossessionStatus::Registered
    } else {
        PossessionStatus::Starting
    }
}

fn possession_progress(
    run_id: &str,
    run: PossessRun,
    review: Option<ApprovalReview>,
) -> PossessionProgress {
    let status = progress_status(&run);
    let error = run.error.clone().or_else(|| run.child_error.clone());
    PossessionProgress {
        run_id: run_id.into(),
        status,
        error,
        host_name: run.host_name,
        host_id: run.host_id,
        review,
        child_finished: run.child_finished,
        child_error: run.child_error,
    }
}

struct ObservedHost {
    id: String,
    name: String,
    online: bool,
}

fn observe_pinned_host(
    hosts: &Value,
    expected_id: Option<&str>,
    expected_key: &str,
) -> Result<Option<ObservedHost>> {
    let Some(entries) = hosts
        .as_array()
        .or_else(|| hosts.get("hosts").and_then(Value::as_array))
    else {
        return Ok(None);
    };

    for entry in entries {
        let Some(id) = string_field(entry, &["id", "host_id"]) else {
            continue;
        };
        let public_key = string_field(entry, &["public_key", "host_public_key"]);
        let id_matches = expected_id.is_some_and(|expected| expected == id);
        let key_matches = public_key.is_some_and(|key| key == expected_key);
        if id_matches && public_key.is_some() && !key_matches {
            bail!(VERIFICATION_REFUSAL)
        }
        if !(id_matches || (expected_id.is_none() && key_matches)) || !key_matches {
            continue;
        }
        let name = string_field(entry, &["name", "host_name"])
            .unwrap_or("This Mac")
            .to_owned();
        let online = entry
            .get("online")
            .and_then(Value::as_bool)
            .or_else(|| entry.get("connected").and_then(Value::as_bool))
            .unwrap_or_else(|| entry.get("status").and_then(Value::as_str) == Some("online"));
        return Ok(Some(ObservedHost {
            id: id.to_owned(),
            name,
            online,
        }));
    }
    Ok(None)
}

fn string_field<'a>(value: &'a Value, fields: &[&str]) -> Option<&'a str> {
    fields
        .iter()
        .find_map(|field| value.get(*field).and_then(Value::as_str))
}

fn emit_step(app: &AppHandle, index: usize, label: &str) {
    let _ = app.emit("possess-step", json!({ "index": index, "label": label }));
}

async fn read_child_lines<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    runs: &std::sync::Arc<Mutex<HashMap<String, PossessRun>>>,
    run_id: &str,
    app: &AppHandle,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let parsed = parse_possess_line(&line);
        let mut locked = runs.lock().await;
        let mut registered_now = false;
        if let Some(run) = locked.get_mut(run_id) {
            if let Some(url) = parsed.approval_url {
                let was_registered = run.approval_identifier.is_some() && run.local_key.is_some();
                apply_approval_url(run, &url);
                registered_now =
                    !was_registered && run.approval_identifier.is_some() && run.local_key.is_some();
            }
            run.output.push(line.clone());
            if run.output.len() > 200 {
                run.output.remove(0);
            }
        }
        drop(locked);
        if registered_now {
            emit_step(app, 1, "Host registered — approval ready");
        }
        let _ = app.emit("possess-output", line);
    }
}

fn apply_approval_url(run: &mut PossessRun, url: &url::Url) {
    run.approval_identifier = url
        .query_pairs()
        .find_map(|(key, value)| (key == "ref" && !value.is_empty()).then(|| value.into_owned()))
        .map(ApprovalIdentifier::ApprovalRef)
        .or_else(|| {
            url.query_pairs()
                .find_map(|(key, value)| {
                    (key == "code" && !value.is_empty()).then(|| value.into_owned())
                })
                .map(ApprovalIdentifier::UserCode)
        });
    run.local_key = url
        .fragment()
        .and_then(|fragment| fragment.strip_prefix("k="))
        .filter(|value| {
            value.len() == 43 && spawnd::signed_signal::public_key_from_wire(value).is_ok()
        })
        .map(str::to_owned);
    if run.approval_identifier.is_none() || run.local_key.is_none() {
        run.error = Some(VERIFICATION_REFUSAL.into());
    }
}

struct ParsedPossessLine {
    approval_url: Option<url::Url>,
}

fn parse_possess_line(line: &str) -> ParsedPossessLine {
    let approval_url = line
        .strip_prefix("spawn:   ")
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .and_then(|value| url::Url::parse(value).ok());
    ParsedPossessLine { approval_url }
}

struct DownloadedPair {
    spawnd: Vec<u8>,
    worker: Vec<u8>,
}

async fn download_verified_pair(api: &ApiClient) -> Result<DownloadedPair> {
    let target = current_target()?;
    if let Some(release) = api.optional_authenticated_get("/api/release").await? {
        if release
            .pointer(&format!("/daemon/targets/{target}"))
            .is_none()
        {
            bail!("{} doesn't serve a build for this Mac", api.origin())
        }
    }
    let manifest_url = api.url("/api/install/manifest.json")?;
    let signature_url = api.url("/api/install/manifest.json.sig")?;
    let manifest_bytes =
        download_bounded(api.raw_client(), manifest_url, MAX_MANIFEST_BYTES).await?;
    let signature_bytes = download_bounded(api.raw_client(), signature_url, 1024).await?;
    verify_manifest_signature(&manifest_bytes, &signature_bytes)?;
    let manifest: SignedManifest =
        serde_json::from_slice(&manifest_bytes).context("decoding the signed daemon manifest")?;
    let hashes = manifest
        .targets
        .get(target)
        .with_context(|| format!("{} doesn't serve a build for this Mac", api.origin()))?;
    validate_sha256(&hashes.spawnd_sha256)?;
    validate_sha256(&hashes.spawn_worker_sha256)?;
    let spawnd = download_bounded(
        api.raw_client(),
        api.url(&format!("/api/install/spawnd/{target}"))?,
        MAX_BINARY_BYTES,
    )
    .await?;
    let worker = download_bounded(
        api.raw_client(),
        api.url(&format!("/api/install/spawn-worker/{target}"))?,
        MAX_BINARY_BYTES,
    )
    .await?;
    verify_sha256(&spawnd, &hashes.spawnd_sha256, "spawnd")?;
    verify_sha256(&worker, &hashes.spawn_worker_sha256, "spawn-worker")?;
    Ok(DownloadedPair { spawnd, worker })
}

async fn download_bounded(
    client: &reqwest::Client,
    url: url::Url,
    limit: usize,
) -> Result<Vec<u8>> {
    let response = client.get(url).send().await?.error_for_status()?;
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        bail!("download is larger than the allowed limit")
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            bail!("download is larger than the allowed limit")
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn verify_manifest_signature(manifest: &[u8], signature_file: &[u8]) -> Result<()> {
    let signature_text = std::str::from_utf8(signature_file)?.trim();
    let signature_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(signature_text)
        .context("decoding the daemon manifest signature")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("daemon manifest signature has the wrong length"))?;
    if URL_SAFE_NO_PAD.encode(signature_bytes) != signature_text {
        bail!("daemon manifest signature is not canonical")
    }
    let signature = Signature::from_bytes(&signature_bytes);
    let verified = RELEASE_SIGNING_PUBLIC_KEYS.iter().any(|wire| {
        let Ok(bytes) = URL_SAFE_NO_PAD.decode(wire) else {
            return false;
        };
        let Ok(bytes): Result<[u8; 32], _> = bytes.try_into() else {
            return false;
        };
        VerifyingKey::from_bytes(&bytes)
            .is_ok_and(|key| key.verify_strict(manifest, &signature).is_ok())
    });
    if !verified {
        bail!("The daemon didn't verify. Nothing was installed.")
    }
    Ok(())
}

fn current_target() -> Result<&'static str> {
    #[cfg(target_arch = "aarch64")]
    {
        Ok("darwin-aarch64")
    }
    #[cfg(target_arch = "x86_64")]
    {
        Ok("darwin-x86_64")
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    {
        bail!("this Mac architecture is not supported")
    }
}

fn validate_sha256(value: &str) -> Result<()> {
    if value.len() != 64
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
    {
        bail!("signed manifest contains an invalid sha256")
    }
    Ok(())
}

fn verify_sha256(bytes: &[u8], expected: &str, _name: &str) -> Result<()> {
    let actual = hex::encode(Sha256::digest(bytes));
    if actual != expected {
        bail!("The daemon didn't verify. Nothing was installed.")
    }
    Ok(())
}

fn install_pair(pair: DownloadedPair) -> Result<PathBuf> {
    let home = dirs::home_dir().context("the home directory is unavailable")?;
    let bin_dir = home.join(".local/bin");
    fs::create_dir_all(&bin_dir)?;
    let spawnd = bin_dir.join("spawnd");
    let worker = bin_dir.join("spawn-worker");
    let staged_spawnd = bin_dir.join(format!(".spawnd.desktop.{}", std::process::id()));
    let staged_worker = bin_dir.join(format!(".spawn-worker.desktop.{}", std::process::id()));
    write_executable(&staged_spawnd, &pair.spawnd)?;
    if let Err(error) = write_executable(&staged_worker, &pair.worker) {
        let _ = fs::remove_file(&staged_spawnd);
        return Err(error);
    }
    let backup_spawnd = bin_dir.join(".spawnd.desktop-prev");
    let backup_worker = bin_dir.join(".spawn-worker.desktop-prev");
    let had_spawnd = move_if_exists(&spawnd, &backup_spawnd)?;
    let had_worker = move_if_exists(&worker, &backup_worker)?;
    let install = (|| -> Result<()> {
        fs::rename(&staged_spawnd, &spawnd)?;
        fs::rename(&staged_worker, &worker)?;
        Ok(())
    })();
    if let Err(error) = install {
        let _ = fs::remove_file(&spawnd);
        let _ = fs::remove_file(&worker);
        if had_spawnd {
            let _ = fs::rename(&backup_spawnd, &spawnd);
        }
        if had_worker {
            let _ = fs::rename(&backup_worker, &worker);
        }
        let _ = fs::remove_file(&staged_spawnd);
        let _ = fs::remove_file(&staged_worker);
        return Err(error).context("installing the verified daemon pair");
    }
    let _ = fs::remove_file(backup_spawnd);
    let _ = fs::remove_file(backup_worker);
    Ok(bin_dir)
}

fn write_executable(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

fn move_if_exists(source: &Path, target: &Path) -> Result<bool> {
    match fs::rename(source, target) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub fn installer_command(origin: &str) -> String {
    format!("curl -fsSL {origin}/install.sh | sh")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn a_resumed_run_is_told_apart_by_the_account_it_named() {
        let ours = vec![
            "spawn: starting the background daemon".to_string(),
            "spawn: already possessed (9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f); daemon running in the background.".to_string(),
        ];
        assert_eq!(
            finished_without_ceremony(&ours, Some("9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f")),
            ALREADY_POSSESSED_HERE
        );
        assert_eq!(
            finished_without_ceremony(&ours, Some("11111111-2222-3333-4444-555555555555")),
            ALREADY_POSSESSED_OTHER
        );
        // Signed out of the app, or a line that never named an account: there
        // is nothing to claim about whose machine this is.
        assert_eq!(
            finished_without_ceremony(&ours, None),
            ALREADY_POSSESSED_OTHER
        );
        assert_eq!(
            finished_without_ceremony(&["spawn: something else entirely".to_string()], Some("a")),
            NO_CEREMONY
        );
    }

    #[test]
    fn account_sanitizing_matches_the_daemons_instance_directories() {
        assert_eq!(
            sanitize_account("9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"),
            "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
        );
        assert_eq!(sanitize_account("../../etc/passwd"), "etc_passwd");
        assert_eq!(sanitize_account("///"), "account");
    }

    #[test]
    fn parses_only_the_stable_plain_url_line() {
        let parsed = parse_possess_line(
            "spawn:   https://spawnd.dev/device?ref=opaque#k=abcdefghijklmnopqrstuvwxyzABCDEFG0123456789_",
        );
        assert!(parsed.approval_url.is_some());
        assert!(
            parse_possess_line("spawn: https://spawnd.dev/device?ref=opaque#k=key")
                .approval_url
                .is_none()
        );
        assert!(parse_possess_line("debug https://example.test/#k=bad")
            .approval_url
            .is_none());
    }

    #[test]
    fn approval_url_requires_a_valid_key_fragment() {
        let key = URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&[5; 32]).verifying_key());
        let mut exact = PossessRun::default();
        apply_approval_url(
            &mut exact,
            &url::Url::parse(&format!("https://spawnd.dev/device?ref=local-ref#k={key}")).unwrap(),
        );
        assert_eq!(exact.local_key.as_deref(), Some(key.as_str()));
        assert_eq!(
            exact.approval_identifier,
            Some(ApprovalIdentifier::ApprovalRef("local-ref".into()))
        );
        assert!(exact.error.is_none());

        let mut malformed = PossessRun::default();
        apply_approval_url(
            &mut malformed,
            &url::Url::parse("https://spawnd.dev/device?ref=local-ref#k=damaged").unwrap(),
        );
        assert!(malformed.local_key.is_none());
        assert_eq!(malformed.error.as_deref(), Some(VERIFICATION_REFUSAL));

        let mut missing = PossessRun::default();
        apply_approval_url(
            &mut missing,
            &url::Url::parse("https://spawnd.dev/device?ref=local-ref").unwrap(),
        );
        assert!(missing.local_key.is_none());
        assert_eq!(missing.error.as_deref(), Some(VERIFICATION_REFUSAL));
    }

    #[test]
    fn pre_0029_code_url_sends_user_code() {
        let key = URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&[9; 32]).verifying_key());
        let mut run = PossessRun::default();
        apply_approval_url(
            &mut run,
            &url::Url::parse(&format!("https://spawnd.dev/device?code=ABCD-EFGH#k={key}")).unwrap(),
        );
        assert_eq!(
            run.approval_identifier,
            Some(ApprovalIdentifier::UserCode("ABCD-EFGH".into()))
        );
        assert_eq!(
            run.approval_identifier.unwrap().request_body(),
            json!({ "user_code": "ABCD-EFGH" })
        );
    }

    #[test]
    fn hosts_must_match_the_pinned_key_before_online() {
        let key = URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&[11; 32]).verifying_key());
        let hosts = json!([{
            "id": "host-1",
            "name": "altar",
            "host_public_key": key,
            "online": true
        }]);
        let observed = observe_pinned_host(&hosts, Some("host-1"), &key)
            .unwrap()
            .unwrap();
        assert_eq!(observed.id, "host-1");
        assert_eq!(observed.name, "altar");
        assert!(observed.online);

        assert!(observe_pinned_host(&hosts, Some("host-1"), &"A".repeat(43)).is_err());
    }

    #[test]
    fn manifest_verification_covers_the_exact_downloaded_bytes() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let manifest = br#"{"targets":{}}"#;
        let signature = URL_SAFE_NO_PAD.encode(key.sign(manifest).to_bytes());
        let public = URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes());
        let signature_bytes: [u8; 64] = URL_SAFE_NO_PAD
            .decode(signature)
            .unwrap()
            .try_into()
            .unwrap();
        let parsed_signature = Signature::from_bytes(&signature_bytes);
        let key_bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(public).unwrap().try_into().unwrap();
        let verifier = VerifyingKey::from_bytes(&key_bytes).unwrap();
        assert!(verifier.verify_strict(manifest, &parsed_signature).is_ok());
        assert!(verifier
            .verify_strict(b"{\"targets\":{}}\n", &parsed_signature)
            .is_err());
    }

    #[test]
    fn sha256_contract_is_lowercase_and_exact() {
        let bytes = b"SPAWN D";
        let digest = hex::encode(Sha256::digest(bytes));
        verify_sha256(bytes, &digest, "fixture").unwrap();
        assert!(validate_sha256(&digest.to_uppercase()).is_err());
        assert!(verify_sha256(bytes, &"0".repeat(64), "fixture").is_err());
    }
}
