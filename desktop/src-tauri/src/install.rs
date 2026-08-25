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
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::api::ApiClient;
use crate::crypto::{key_fingerprint, DeviceIdentity};
use crate::models::{
    ApprovalReview, DeviceApproveResponse, DevicePending, PossessionProgress, SetupClaim,
    SetupClaimMint,
};
use crate::storage;

const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_BINARY_BYTES: usize = 256 * 1024 * 1024;
const RELEASE_SIGNING_PUBLIC_KEYS: &[&str] = &["8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0"];

#[derive(Debug, Deserialize)]
struct SignedManifest {
    targets: HashMap<String, TargetManifest>,
}

#[derive(Debug, Deserialize)]
struct TargetManifest {
    spawnd_sha256: String,
    spawn_worker_sha256: String,
}

#[derive(Clone, Default)]
struct PossessRun {
    approval_url_seen: bool,
    local_key: Option<String>,
    local_approval_ref: Option<String>,
    key_fragment_invalid: bool,
    local_fingerprint: Option<String>,
    host_public_key: Option<String>,
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
        let claim: SetupClaimMint = api
            .authenticated_json(Method::POST, "/api/setup/claims", &json!({}))
            .await
            .context("minting the attended setup claim")?;
        emit_step(app, 0, "Downloading the daemon");
        let pair = download_verified_pair(&api).await.map_err(|error| {
            let detail = error.to_string();
            if detail.contains("doesn't serve a build for this Mac") {
                anyhow::anyhow!(detail)
            } else {
                anyhow::anyhow!("The daemon didn't verify. Nothing was installed.")
            }
        })?;
        emit_step(app, 1, "Verifying — hashes match the server's manifest");
        let bin_dir = install_pair(pair)?;
        emit_step(app, 2, "Starting the service");
        self.runs
            .lock()
            .await
            .insert(claim.token.clone(), PossessRun::default());
        self.spawn_possess(
            app.clone(),
            claim.token.clone(),
            bin_dir.join("spawnd"),
            preferences.server_origin,
        )
        .await
        .map_err(|_| anyhow::anyhow!("The daemon installed but its service didn't start."))?;
        emit_step(app, 3, "Registering this Mac");
        Ok(claim.token)
    }

    async fn spawn_possess(
        &self,
        app: AppHandle,
        claim_token: String,
        spawnd: PathBuf,
        origin: String,
    ) -> Result<()> {
        let mut child = Command::new(spawnd)
            .arg("--server")
            .arg(origin)
            .arg("possess")
            .arg("--setup-token")
            .arg(&claim_token)
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
        let stdout_token = claim_token.clone();
        let stdout_app = app.clone();
        tauri::async_runtime::spawn(async move {
            read_child_lines(stdout, &stdout_runs, &stdout_token, &stdout_app).await;
        });
        let stderr_runs = self.runs.clone();
        let stderr_token = claim_token.clone();
        let stderr_app = app.clone();
        tauri::async_runtime::spawn(async move {
            read_child_lines(stderr, &stderr_runs, &stderr_token, &stderr_app).await;
        });
        let runs = self.runs.clone();
        tauri::async_runtime::spawn(async move {
            let result = child.wait().await;
            let mut locked = runs.lock().await;
            if let Some(run) = locked.get_mut(&claim_token) {
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

    pub async fn poll(&self, app: &AppHandle, claim_token: &str) -> Result<PossessionProgress> {
        let preferences = storage::load_preferences()?;
        let api = ApiClient::new(&preferences.server_origin)?;
        let claim: SetupClaim = api
            .authenticated_get(&format!("/api/setup/claims/{claim_token}"))
            .await?;
        let snapshot = self
            .runs
            .lock()
            .await
            .get(claim_token)
            .cloned()
            .context("this possession run is no longer available")?;
        let review = if claim.status == "ready" {
            match claim.approval_ref.as_deref() {
                Some(reference) => self.review(&api, reference, &snapshot).await?,
                None => None,
            }
        } else {
            None
        };
        if claim.status == "approved" {
            emit_step(app, 4, "Approved — key verified on this machine");
            let mut updated = preferences;
            updated.first_run_complete = true;
            updated.host_name.clone_from(&claim.host_name);
            storage::save_preferences(&updated)?;
            if let (Some(host_id), Some(host_key), Some(host_name)) = (
                claim.host_id.as_deref(),
                snapshot.host_public_key.as_deref(),
                claim.host_name.as_deref(),
            ) {
                self.publish_introduction(&api, claim_token, host_id, host_name, host_key)
                    .await;
            }
        }
        Ok(PossessionProgress {
            claim_token: claim_token.into(),
            claim,
            review,
            child_finished: snapshot.child_finished,
            child_error: snapshot.child_error,
        })
    }

    async fn review(
        &self,
        api: &ApiClient,
        approval_ref: &str,
        run: &PossessRun,
    ) -> Result<Option<ApprovalReview>> {
        if !run.approval_url_seen {
            return Ok(None);
        }
        if run.key_fragment_invalid || run.local_approval_ref.as_deref() != Some(approval_ref) {
            bail!("This host could not be verified.")
        }
        let pending: DevicePending = api
            .authenticated_json(
                Method::POST,
                "/api/auth/device/pending",
                &json!({ "approval_ref": approval_ref }),
            )
            .await?;
        let derived = key_fingerprint(&pending.host_public_key)?;
        if derived != pending.host_key_fingerprint {
            bail!("This host could not be verified.")
        }
        let exact_key_match = run
            .local_key
            .as_deref()
            .is_some_and(|local| local == pending.host_public_key);
        if run.local_key.is_some() && !exact_key_match {
            bail!("This host could not be verified.")
        }
        Ok(Some(ApprovalReview {
            approval_ref: approval_ref.into(),
            host_name: pending.host_name,
            host_public_key: pending.host_public_key,
            fingerprint: pending.host_key_fingerprint,
            local_fingerprint: run.local_fingerprint.clone(),
            exact_key_match,
            needs_fingerprint_compare: run.local_key.is_none(),
        }))
    }

    pub async fn approve(
        &self,
        app: &AppHandle,
        claim_token: &str,
        fingerprint_confirmed: bool,
    ) -> Result<String> {
        let preferences = storage::load_preferences()?;
        let account_id = preferences.account_id.context("Sign in before approval")?;
        let device_id = preferences
            .device_id
            .context("Device registration is unavailable")?;
        let api = ApiClient::new(&preferences.server_origin)?;
        let claim: SetupClaim = api
            .authenticated_get(&format!("/api/setup/claims/{claim_token}"))
            .await?;
        let approval_ref = claim
            .approval_ref
            .context("The daemon is not ready for approval")?;
        let pending: DevicePending = api
            .authenticated_json(
                Method::POST,
                "/api/auth/device/pending",
                &json!({ "approval_ref": approval_ref }),
            )
            .await?;
        let snapshot = self
            .runs
            .lock()
            .await
            .get(claim_token)
            .cloned()
            .context("this possession run is no longer available")?;
        if snapshot.key_fragment_invalid
            || snapshot.local_approval_ref.as_deref() != Some(approval_ref.as_str())
        {
            bail!("This host could not be verified.")
        }
        let derived_fingerprint = key_fingerprint(&pending.host_public_key)?;
        if derived_fingerprint != pending.host_key_fingerprint {
            bail!("This host could not be verified.")
        }
        match snapshot.local_key.as_deref() {
            Some(local_key) if local_key == pending.host_public_key => {}
            Some(_) => bail!("This host could not be verified."),
            None if fingerprint_confirmed
                && snapshot.local_fingerprint.as_deref()
                    == Some(pending.host_key_fingerprint.as_str()) => {}
            None => bail!("Compare the full fingerprint before approving this host"),
        }
        let identity = DeviceIdentity::load_or_create(&account_id)?;
        let browser_public_key = identity.public_key_wire();
        let browser_fingerprint = key_fingerprint(&browser_public_key)?;
        let signature = identity.host_approval_proof(
            &account_id,
            &pending.approval_nonce,
            &pending.host_public_key,
        )?;
        let response: DeviceApproveResponse = api
            .authenticated_json(
                Method::POST,
                "/api/auth/device/approve",
                &json!({
                    "approval_ref": approval_ref,
                    "approval_nonce": pending.approval_nonce,
                    "host_key_algorithm": pending.host_key_algorithm,
                    "host_public_key": pending.host_public_key,
                    "host_key_fingerprint": pending.host_key_fingerprint,
                    "browser_device_id": device_id,
                    "browser_key_algorithm": "ed25519",
                    "browser_public_key": browser_public_key,
                    "browser_key_fingerprint": browser_fingerprint,
                    "signature": signature
                }),
            )
            .await?;
        if response.host_name != pending.host_name
            || response.approval_nonce != pending.approval_nonce
            || response.host_key_algorithm != pending.host_key_algorithm
            || response.host_public_key != pending.host_public_key
            || response.browser_device_id != device_id
            || response.browser_key_algorithm != "ed25519"
            || response.browser_public_key != browser_public_key
        {
            bail!("The approval response changed the reviewed host or device identity")
        }
        if let Some(run) = self.runs.lock().await.get_mut(claim_token) {
            run.host_public_key = Some(pending.host_public_key.clone());
        }
        emit_step(app, 4, "Approved — key verified on this machine");
        if let Some(host_id) = response.host_id.as_deref() {
            self.publish_introduction(
                &api,
                claim_token,
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
        claim_token: &str,
        host_id: &str,
        host_name: &str,
        host_public_key: &str,
    ) {
        let already_published = self
            .runs
            .lock()
            .await
            .get(claim_token)
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
            if let Some(run) = self.runs.lock().await.get_mut(claim_token) {
                run.introduction_published = true;
            }
        }
        // Best-effort here; polling an approved claim retries publication while
        // this desktop run remains active.
    }

    pub async fn log_tail(&self, claim_token: &str) -> String {
        self.runs
            .lock()
            .await
            .get(claim_token)
            .map(|run| run.output.join("\n"))
            .unwrap_or_default()
    }
}

fn emit_step(app: &AppHandle, index: usize, label: &str) {
    let _ = app.emit("possess-step", json!({ "index": index, "label": label }));
}

async fn read_child_lines<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    runs: &std::sync::Arc<Mutex<HashMap<String, PossessRun>>>,
    claim_token: &str,
    app: &AppHandle,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let parsed = parse_possess_line(&line);
        let mut locked = runs.lock().await;
        if let Some(run) = locked.get_mut(claim_token) {
            if let Some(url) = parsed.approval_url {
                apply_approval_url(run, &url);
            }
            if let Some(fingerprint) = parsed.fingerprint {
                run.local_fingerprint = Some(fingerprint);
            }
            run.output.push(line.clone());
            if run.output.len() > 200 {
                run.output.remove(0);
            }
        }
        drop(locked);
        let _ = app.emit("possess-output", line);
    }
}

fn apply_approval_url(run: &mut PossessRun, url: &url::Url) {
    run.approval_url_seen = true;
    run.local_approval_ref = url
        .query_pairs()
        .find_map(|(key, value)| (key == "ref").then(|| value.into_owned()));
    match url.fragment() {
        None => {
            run.local_key = None;
            run.key_fragment_invalid = false;
        }
        Some(fragment) => {
            let candidate = fragment.strip_prefix("k=");
            run.local_key = candidate
                .filter(|value| {
                    value.len() == 43 && spawnd::signed_signal::public_key_from_wire(value).is_ok()
                })
                .map(str::to_owned);
            run.key_fragment_invalid = run.local_key.is_none();
        }
    }
}

struct ParsedPossessLine {
    approval_url: Option<url::Url>,
    fingerprint: Option<String>,
}

fn parse_possess_line(line: &str) -> ParsedPossessLine {
    let trimmed = line.trim();
    let approval_url = trimmed
        .strip_prefix("spawn:")
        .map(str::trim)
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .and_then(|value| url::Url::parse(value).ok());
    let fingerprint = trimmed
        .strip_prefix("spawn:")
        .map(str::trim)
        .filter(|value| value.starts_with("SHA256:") && value.len() == 23)
        .map(str::to_owned);
    ParsedPossessLine {
        approval_url,
        fingerprint,
    }
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
    fn parses_only_the_stable_plain_url_and_fingerprint_lines() {
        let parsed = parse_possess_line(
            "spawn:   https://spawnd.dev/device?ref=opaque#k=abcdefghijklmnopqrstuvwxyzABCDEFG0123456789_",
        );
        assert!(parsed.approval_url.is_some());
        assert_eq!(
            parse_possess_line("spawn:     SHA256:Yr0kQmVd12345678")
                .fingerprint
                .as_deref(),
            Some("SHA256:Yr0kQmVd12345678")
        );
        assert!(parse_possess_line("debug https://example.test/#k=bad")
            .approval_url
            .is_none());
    }

    #[test]
    fn approval_url_distinguishes_missing_and_malformed_key_fragments() {
        let key = URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&[5; 32]).verifying_key());
        let mut exact = PossessRun::default();
        apply_approval_url(
            &mut exact,
            &url::Url::parse(&format!("https://spawnd.dev/device?ref=local-ref#k={key}")).unwrap(),
        );
        assert_eq!(exact.local_key.as_deref(), Some(key.as_str()));
        assert_eq!(exact.local_approval_ref.as_deref(), Some("local-ref"));
        assert!(!exact.key_fragment_invalid);

        let mut malformed = PossessRun::default();
        apply_approval_url(
            &mut malformed,
            &url::Url::parse("https://spawnd.dev/device?ref=local-ref#k=damaged").unwrap(),
        );
        assert!(malformed.local_key.is_none());
        assert!(malformed.key_fragment_invalid);

        let mut fallback = PossessRun::default();
        apply_approval_url(
            &mut fallback,
            &url::Url::parse("https://spawnd.dev/device?ref=local-ref").unwrap(),
        );
        assert!(fallback.local_key.is_none());
        assert!(!fallback.key_fragment_invalid);
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
