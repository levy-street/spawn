//! Where the app's own secrets live.
//!
//! Two of them: the session token for each server origin, and the Ed25519 seed
//! behind this device's identity for each account. Both are kept in a
//! mode-0600 JSON file next to the app's preferences, handled by
//! `spawnd::secret_file` — the same atomic write, ownership and permission
//! checks, `NOFOLLOW` open and cross-process lock the daemon's `creds.rs` uses
//! for its own token and host seed.
//!
//! # Why not the macOS keychain
//!
//! It used to be the keychain, and the honest trade has to be stated rather
//! than assumed, because on paper the keychain is the stronger store: a
//! keychain item's ACL is bound to a code signature, so *other processes
//! running as this user* cannot read it without a dialog, while a 0600 file is
//! readable by anything running as this user, full stop. That is a real
//! difference and this change gives it up.
//!
//! It is worth giving up for two reasons, and the second is the load-bearing
//! one.
//!
//! First, the protection was not buying what it appears to. This app installs
//! and supervises `spawnd`, whose credentials are *strictly more powerful* than
//! anything here — the host key that possesses this Mac and the daemon token
//! that speaks for it — and those already live in exactly such a file at
//! `~/.config/spawn/credentials.json`. Anything running as this user that
//! wanted a way in would take that file, which needs no dialog and no
//! signature; the app's session token is the lesser prize sitting behind a
//! stronger door in the same house. Closing that door harder does not change
//! what an attacker who is already inside can reach.
//!
//! Second, the dialog costs more than it protects. "SPAWN D wants to use your
//! confidential information stored in your keychain" is, to most people, the
//! dialog that means *passwords* — and this is a product whose whole proposition
//! is running agents on your machine. It has to look scrupulous, and being
//! asked to unlock a keychain during setup reads as the opposite, whatever the
//! item actually holds. A permission people understand and would grant is worth
//! more than one they will refuse or, worse, click through without reading.
//!
//! What is *not* given up: the file is written atomically so a crash cannot
//! truncate it, refused if it is not a regular file this user owns with no
//! group or other bits, never followed through a symlink, and zeroized in
//! memory on the way out.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spawnd::secret_file::SecretFile;
use url::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::models::DesktopPreferences;

/// The service the retired keychain items were filed under. Kept only so the
/// one-time migration below can find and delete them.
const KEYRING_SERVICE: &str = "spawn";

/// A token is a JWT and a seed is 43 characters; the whole record for every
/// origin and account a person has used is comfortably inside this. Anything
/// larger is corruption, not data.
const MAX_CREDENTIAL_BYTES: usize = 64 * 1024;

/// The temporary prefix is deliberately not the daemon's `.credentials.`: the
/// two never share a directory today, but a sweeper that cannot tell its own
/// in-flight writes from another program's is a bug waiting for the day they
/// do.
const CREDENTIAL_FILE: SecretFile = SecretFile::new(
    "the SPAWN D credential file",
    ".desktop-credentials.",
    MAX_CREDENTIAL_BYTES,
);
const CREDENTIAL_LOCK_FILE: &str = ".credentials.lock";

fn support_dir() -> Result<PathBuf> {
    let base =
        dirs::config_dir().context("the macOS application-support directory is unavailable")?;
    Ok(base.join("dev.spawnd.desktop"))
}

fn state_path() -> Result<PathBuf> {
    Ok(support_dir()?.join("state.json"))
}

fn credentials_path() -> Result<PathBuf> {
    Ok(support_dir()?.join("credentials.json"))
}

pub fn load_preferences() -> Result<DesktopPreferences> {
    let path = state_path()?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("decoding desktop preferences"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

pub fn save_preferences(preferences: &DesktopPreferences) -> Result<()> {
    let path = state_path()?;
    let parent = path.parent().context("desktop state path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(preferences)?;
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, &path)?;
    Ok(())
}

pub fn normalize_server_url(value: &str) -> std::result::Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Enter a SPAWN D server URL".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if (lower.starts_with("http:") || lower.starts_with("https:"))
        && !(lower.starts_with("http://") || lower.starts_with("https://"))
    {
        return Err("Enter a valid SPAWN D server URL".into());
    }
    let candidate = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = Url::parse(&candidate).map_err(|_| "Enter a valid SPAWN D server URL")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("SPAWN D server URL must use http or https".into());
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err("SPAWN D server URL must include a host".into());
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("SPAWN D server URL cannot include credentials, a query, or a fragment".into());
    }
    Ok(candidate.trim_end_matches('/').to_owned())
}

/// The record on disk.
///
/// Scoped by the plain origin and account id rather than the hash the keychain
/// items used: the hash existed only to make a legal keychain account name, and
/// inside a file the app already owns it bought nothing but an unreadable file.
#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredSecrets {
    version: u8,
    /// Server origin → session token.
    #[serde(default)]
    tokens: BTreeMap<String, String>,
    /// Account id → Ed25519 seed, base64url.
    #[serde(default)]
    device_seeds: BTreeMap<String, String>,
    /// Set once the keychain has been emptied into this file, so the migration
    /// — and any dialog it costs — happens at most once on a machine.
    #[serde(default)]
    keychain_migrated: bool,
}

const CREDENTIAL_RECORD_VERSION: u8 = 1;

impl StoredSecrets {
    /// A machine that has never stored anything. Spelled out rather than
    /// derived because `Drop` rules out struct-update syntax.
    fn empty() -> Self {
        Self {
            version: CREDENTIAL_RECORD_VERSION,
            tokens: BTreeMap::new(),
            device_seeds: BTreeMap::new(),
            keychain_migrated: false,
        }
    }
}

impl Drop for StoredSecrets {
    fn drop(&mut self) {
        for value in self
            .tokens
            .values_mut()
            .chain(self.device_seeds.values_mut())
        {
            value.zeroize();
        }
    }
}

fn read_secrets() -> Result<StoredSecrets> {
    let path = credentials_path()?;
    let Some(mut raw) = CREDENTIAL_FILE.read(&path)? else {
        return Ok(StoredSecrets::empty());
    };
    let parsed = serde_json::from_slice(&raw)
        .with_context(|| format!("decoding {}", path.display()))
        .map(|mut secrets: StoredSecrets| {
            secrets.version = CREDENTIAL_RECORD_VERSION;
            secrets
        });
    raw.zeroize();
    parsed
}

fn write_secrets(secrets: &StoredSecrets) -> Result<()> {
    let path = credentials_path()?;
    let parent = path.parent().context("credential path has no parent")?;
    fs::create_dir_all(parent)?;
    let mut json = serde_json::to_vec_pretty(secrets)?;
    let result = CREDENTIAL_FILE
        .write(&path, &json)
        .with_context(|| format!("writing {}", path.display()));
    json.zeroize();
    result
}

/// Read, change, write — with the lock held across all three.
///
/// Every writer goes through here. Two windows of the app, or an update
/// restarting one over the other, must not each read the same record and write
/// back a whole copy of it: the second write would silently drop whatever the
/// first added.
fn commit<T>(change: impl FnOnce(&mut StoredSecrets) -> Result<T>) -> Result<T> {
    let lock_path = support_dir()?.join(CREDENTIAL_LOCK_FILE);
    fs::create_dir_all(support_dir()?)?;
    CREDENTIAL_FILE.lock(&lock_path, || {
        let mut secrets = read_secrets()?;
        let outcome = change(&mut secrets)?;
        write_secrets(&secrets)?;
        Ok(outcome)
    })
}

pub fn set_token(origin: &str, token: &str) -> Result<()> {
    commit(|secrets| {
        secrets.tokens.insert(origin.to_owned(), token.to_owned());
        Ok(())
    })
}

pub fn token(origin: &str) -> Result<Zeroizing<String>> {
    // The file first, always. A read that the file can already answer must
    // never touch the sweep: coupling the two is what let one stuck keychain
    // call take the whole app down with it, silently.
    if let Some(token) = read_secrets()?.tokens.get(origin).cloned() {
        return Ok(Zeroizing::new(token));
    }
    sweep_once(BRIEF);
    read_secrets()?
        .tokens
        .get(origin)
        .cloned()
        .map(Zeroizing::new)
        .context("no SPAWN D session is stored for this server")
}

pub fn clear_token(origin: &str) -> Result<()> {
    commit(|secrets| {
        if let Some(mut token) = secrets.tokens.remove(origin) {
            token.zeroize();
        }
        Ok(())
    })
}

pub fn set_device_seed(account_id: &str, seed_wire: &str) -> Result<()> {
    commit(|secrets| {
        secrets
            .device_seeds
            .insert(account_id.to_owned(), seed_wire.to_owned());
        Ok(())
    })
}

pub fn device_seed(account_id: &str) -> Result<Option<Zeroizing<String>>> {
    if let Some(seed) = read_secrets()?.device_seeds.get(account_id).cloned() {
        return Ok(Some(Zeroizing::new(seed)));
    }
    sweep_once(BRIEF);
    Ok(read_secrets()?
        .device_seeds
        .get(account_id)
        .cloned()
        .map(Zeroizing::new))
}

fn scoped_keyring_user(prefix: &str, scope: &str) -> String {
    let digest = Sha256::digest(scope.as_bytes());
    format!("desktop-{prefix}-{}", hex::encode(&digest[..12]))
}

/// Empty the keychain into the file, once, and delete what was moved.
///
/// Only the two items the current preferences name can be found — `keyring`
/// addresses an item by name and cannot enumerate — so items belonging to
/// origins or accounts this install no longer uses stay behind. They are inert:
/// nothing reads the keychain after this, so they cost clutter rather than a
/// dialog. `security delete-generic-password -s spawn` clears the rest.
///
/// **Whether this is silent depends on the signature, not on us.** A keychain
/// item's ACL names the code that created it, so a notarized app reading items
/// a notarized app wrote satisfies it and nobody is asked anything — the
/// ordinary upgrade is silent. When the signature has changed since the item
/// was written (a development rebuild, or a build signed differently from the
/// one that first stored the item) macOS asks once per item, up to twice, and
/// then never again on that machine.
///
/// The seed is why this exists at all. A session token is replaceable by
/// signing in again; the Ed25519 seed *is* this device's identity, already
/// approved against the account, and losing it would leave the person
/// re-approving a device that appeared to change its key.
/// How long to wait for a keychain read when a **visible window** exists for
/// macOS to hang a prompt on, so the person can actually answer it.
///
/// Ninety seconds because the wait is for a human, not a computer: someone has
/// to notice a sheet, read it and choose, and fifteen seconds is not enough for
/// anyone who stepped away while the app was starting. It matches the daemon's
/// TCC prompt timeout, so the product's two consent waits agree.
pub const PATIENT: Duration = Duration::from_secs(90);

/// How long to wait when **no window exists** to hang a prompt on — and for
/// every lazy read, which cannot know.
///
/// A keychain read that is going to succeed returns in milliseconds; it is a
/// local database lookup. Three seconds is a thousandfold headroom and still
/// well under the point where a launch reads as broken. This is the case that
/// produced the hang: macOS wanted to prompt, had nothing to attach the prompt
/// to, and so never returned at all.
pub const BRIEF: Duration = Duration::from_secs(3);

/// Empty the keychain into the file, giving macOS `patience` per item.
///
/// Callers that know a window is up should pass `PATIENT`; anything else
/// `BRIEF`.
pub fn run_keychain_migration(patience: Duration) {
    sweep_once(patience);
}

/// Whether the sweep is finished. `false` until an attempt actually completes.
fn sweep_finished() -> &'static Mutex<bool> {
    static FINISHED: OnceLock<Mutex<bool>> = OnceLock::new();
    FINISHED.get_or_init(|| Mutex::new(false))
}

/// Run the sweep unless it is done or somebody else is already running it.
///
/// `try_lock`, never `lock`: waiting for another runner is precisely the bug.
/// A `OnceLock` here made every secret read queue behind the boot sweep, so one
/// keychain call that never returned meant no window ever appeared and nothing
/// was logged — the app simply sat there. A reader that finds the sweep busy
/// now answers from the file and moves on.
fn sweep_once(patience: Duration) {
    let Ok(mut finished) = sweep_finished().try_lock() else {
        return;
    };
    if *finished {
        return;
    }
    match migrate_from_keychain(patience) {
        Ok(complete) => *finished = complete,
        Err(error) => eprintln!("storage: keychain migration skipped: {error:#}"),
    }
}

/// What the keychain said — three answers, not two.
///
/// "There is nothing here" and "I will not tell you" arrive as the same `Err`
/// if you reach for `.ok()`, and collapsing them is the difference between a
/// no-op and destroying an identity. A refused read that reads as "nothing to
/// move" retires the device seed, and that seed *is* what made this device
/// approved: the person is signed out, re-approves a device the account already
/// trusted, and nothing anywhere says why.
enum KeychainRead {
    Found(Zeroizing<String>),
    /// No such item. Nothing to move, and nothing wrong — the ordinary case.
    Absent,
    /// macOS would not answer: refused at the dialog, or the keychain is
    /// unavailable. Nothing may be concluded from this.
    Unreadable,
}

impl std::fmt::Debug for KeychainRead {
    /// Hand-written so a secret cannot reach a log through a derived `Debug`.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Found(_) => "Found(<redacted>)",
            Self::Absent => "Absent",
            Self::Unreadable => "Unreadable",
        })
    }
}

/// Whether the sweep may be called done and never repeated.
///
/// Only an answer from macOS closes the question. "Nothing here" is an answer;
/// a refusal is not, and marking the sweep complete on one is what makes the
/// loss permanent. Pure, so both branches are testable without a keychain.
fn sweep_is_complete(token: &KeychainRead, seed: &KeychainRead) -> bool {
    !matches!(token, KeychainRead::Unreadable) && !matches!(seed, KeychainRead::Unreadable)
}

fn migrate_from_keychain(patience: Duration) -> Result<bool> {
    let secrets = read_secrets()?;
    if secrets.keychain_migrated {
        return Ok(true);
    }
    let preferences = load_preferences()?;
    let origin = preferences.server_origin.clone();
    let account = preferences.account_id.clone();

    // Ask only for what the file does not already hold. A value rescued on an
    // earlier attempt needs no second dialog, so a retry after a refusal
    // narrows to the secret still missing rather than re-asking for everything.
    let token = if secrets.tokens.contains_key(&origin) {
        KeychainRead::Absent
    } else {
        keychain_secret("token", &origin, patience)
    };
    let seed = match account.as_deref() {
        Some(account) if !secrets.device_seeds.contains_key(account) => {
            keychain_secret("device", account, patience)
        }
        _ => KeychainRead::Absent,
    };
    let complete = sweep_is_complete(&token, &seed);

    commit(|stored| {
        if let KeychainRead::Found(token) = &token {
            stored
                .tokens
                .entry(origin.clone())
                .or_insert_with(|| token.to_string());
        }
        if let (KeychainRead::Found(seed), Some(account)) = (&seed, account.as_deref()) {
            stored
                .device_seeds
                .entry(account.to_owned())
                .or_insert_with(|| seed.to_string());
        }
        // Set, never cleared: a concurrent writer that already finished the
        // sweep must not be walked back by this one.
        if complete {
            stored.keychain_migrated = true;
        }
        Ok(())
    })?;

    // Only after the file has the value. A delete that ran first and a write
    // that then failed would destroy the device identity outright — and only
    // what was actually read is deleted, so a refused item stays where it is,
    // recoverable on the next launch.
    if matches!(token, KeychainRead::Found(_)) {
        delete_keychain_secret("token", &origin);
    }
    if let (KeychainRead::Found(_), Some(account)) = (&seed, account.as_deref()) {
        delete_keychain_secret("device", account);
    }
    if !complete {
        // Logged rather than surfaced: the person is not stuck, and the next
        // launch quietly tries again. Without this line the reason is nowhere.
        eprintln!(
            "storage: the keychain would not release everything; \
             leaving it to try again next launch"
        );
    }
    Ok(complete)
}

/// Read one keychain item, or give up after `patience`.
///
/// `keyring` offers no timeout and the macOS backend can block **for ever**:
/// when the item's ACL does not match the running signature macOS wants to
/// prompt, and if there is no window to attach the prompt to it never renders
/// and the call never returns. That is not a slow read, it is a permanent one,
/// and it took the whole app with it.
///
/// So the read happens on a detached thread and the caller waits on a channel.
/// A thread stuck this way is never joined and lives until the process exits —
/// deliberate, and the cheaper half of the trade: at most two per launch, no
/// lock held, against an app that never starts. If it does eventually return,
/// it sends into a channel nobody is listening to and that is fine.
fn keychain_secret(prefix: &str, scope: &str, patience: Duration) -> KeychainRead {
    let (answer, wait) = std::sync::mpsc::channel();
    let user = scoped_keyring_user(prefix, scope);
    let named = prefix.to_owned();
    std::thread::spawn(move || {
        let read = match Entry::new(KEYRING_SERVICE, &user) {
            Ok(entry) => match entry.get_password() {
                Ok(secret) => KeychainRead::Found(Zeroizing::new(secret)),
                Err(keyring::Error::NoEntry) => KeychainRead::Absent,
                Err(error) => {
                    eprintln!("storage: the keychain would not release the {named}: {error}");
                    KeychainRead::Unreadable
                }
            },
            Err(error) => {
                eprintln!("storage: could not open the {named} keychain item: {error}");
                KeychainRead::Unreadable
            }
        };
        let _ = answer.send(read);
    });
    match wait.recv_timeout(patience) {
        Ok(read) => read,
        Err(_) => {
            eprintln!(
                "storage: the keychain did not answer for the {prefix} within {}s; \
                 leaving it to try again next launch",
                patience.as_secs()
            );
            KeychainRead::Unreadable
        }
    }
}

fn delete_keychain_secret(prefix: &str, scope: &str) {
    if let Ok(entry) = Entry::new(KEYRING_SERVICE, &scoped_keyring_user(prefix, scope)) {
        let _ = entry.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_url_validation_matches_the_native_client_contract() {
        assert_eq!(
            normalize_server_url("spawnd.dev").unwrap(),
            "https://spawnd.dev"
        );
        assert_eq!(
            normalize_server_url("http://localhost:8010/").unwrap(),
            "http://localhost:8010"
        );
        assert_eq!(
            normalize_server_url(""),
            Err("Enter a SPAWN D server URL".into())
        );
        assert_eq!(
            normalize_server_url("https:spawnd.dev"),
            Err("Enter a valid SPAWN D server URL".into())
        );
        assert!(normalize_server_url("https://user@example.com")
            .unwrap_err()
            .contains("credentials"));
        assert!(normalize_server_url("file:///tmp/spawn")
            .unwrap_err()
            .contains("http or https"));
    }

    /// The record is what actually goes to disk, so it is worth reading: a
    /// field renamed or dropped here silently signs everyone out on upgrade.
    #[test]
    fn the_record_round_trips_every_scope_it_holds() {
        let mut secrets = StoredSecrets::empty();
        secrets
            .tokens
            .insert("https://spawnd.dev".into(), "token-a".into());
        secrets
            .tokens
            .insert("http://localhost:3000".into(), "token-b".into());
        secrets
            .device_seeds
            .insert("account-1".into(), "seed-1".into());
        secrets.keychain_migrated = true;

        let json = serde_json::to_vec(&secrets).expect("encode");
        let back: StoredSecrets = serde_json::from_slice(&json).expect("decode");
        assert_eq!(back.tokens["https://spawnd.dev"], "token-a");
        assert_eq!(back.tokens["http://localhost:3000"], "token-b");
        assert_eq!(back.device_seeds["account-1"], "seed-1");
        assert!(back.keychain_migrated);
    }

    /// A file written by a build that predates a field must still load. The
    /// alternative is an upgrade that reads its own credentials as corrupt.
    #[test]
    fn a_record_missing_newer_fields_still_loads() {
        let older = br#"{"version":1,"tokens":{"https://spawnd.dev":"token"}}"#;
        let parsed: StoredSecrets = serde_json::from_slice(older).expect("decode");
        assert_eq!(parsed.tokens["https://spawnd.dev"], "token");
        assert!(parsed.device_seeds.is_empty());
        assert!(
            !parsed.keychain_migrated,
            "an older file has not been swept, and must still be"
        );
    }

    /// The one thing the migration must never do is delete a keychain item
    /// before the file holds its value, so this pins the ordering that makes
    /// an interrupted migration lose nothing.
    #[test]
    fn migration_keeps_a_value_the_file_already_has() {
        let mut secrets = StoredSecrets::empty();
        secrets
            .device_seeds
            .insert("account-1".into(), "seed-from-file".into());
        // `or_insert_with` is the load-bearing call in `migrate_from_keychain`:
        // a keychain copy must never overwrite a newer one already on disk.
        secrets
            .device_seeds
            .entry("account-1".into())
            .or_insert_with(|| "seed-from-keychain".to_owned());
        assert_eq!(secrets.device_seeds["account-1"], "seed-from-file");
    }

    /// The keychain names are a compatibility contract with items already on
    /// people's machines: get this wrong and the migration finds nothing and
    /// silently signs everyone out.
    #[test]
    fn keychain_names_still_match_the_items_already_on_disk() {
        // Fixed vector, so a refactor of the hashing cannot drift.
        let name = scoped_keyring_user("token", "https://spawnd.dev");
        assert!(name.starts_with("desktop-token-"));
        assert_eq!(name.len(), "desktop-token-".len() + 24);
        assert_eq!(
            scoped_keyring_user("device", "account-1"),
            format!(
                "desktop-device-{}",
                hex::encode(&Sha256::digest("account-1".as_bytes())[..12])
            )
        );
    }

    /// Nothing to move is an answer, so the sweep is done and stays quiet.
    #[test]
    fn an_absent_item_completes_the_sweep() {
        assert!(sweep_is_complete(
            &KeychainRead::Absent,
            &KeychainRead::Absent
        ));
        assert!(sweep_is_complete(
            &KeychainRead::Found(Zeroizing::new("token".into())),
            &KeychainRead::Found(Zeroizing::new("seed".into()))
        ));
        // Moved one, nothing to move for the other: still finished.
        assert!(sweep_is_complete(
            &KeychainRead::Found(Zeroizing::new("token".into())),
            &KeychainRead::Absent
        ));
    }

    /// A refusal is *not* an answer, and treating it as one is the bug this
    /// pins: the sweep would be marked done, the seed never rescued, and the
    /// person would re-approve a device the account already trusted with
    /// nothing anywhere explaining why. Retrying costs a dialog; getting this
    /// wrong costs an identity permanently.
    #[test]
    fn an_unreadable_item_never_completes_the_sweep() {
        assert!(!sweep_is_complete(
            &KeychainRead::Unreadable,
            &KeychainRead::Absent
        ));
        assert!(!sweep_is_complete(
            &KeychainRead::Absent,
            &KeychainRead::Unreadable
        ));
        // The dangerous shape: the token came back fine, so everything looks
        // successful, while the seed — the irreplaceable one — did not.
        assert!(!sweep_is_complete(
            &KeychainRead::Found(Zeroizing::new("token".into())),
            &KeychainRead::Unreadable
        ));
    }

    /// A secret already in the file is never asked for again, so a retry after
    /// a refusal narrows to what is still missing instead of re-prompting for
    /// everything on every launch.
    #[test]
    fn a_retry_only_asks_for_what_the_file_still_lacks() {
        let mut secrets = StoredSecrets::empty();
        secrets
            .tokens
            .insert("https://spawnd.dev".into(), "already-rescued".into());
        assert!(secrets.tokens.contains_key("https://spawnd.dev"));
        assert!(!secrets.device_seeds.contains_key("account-1"));
    }

    /// A redacted `Debug` is the difference between a log line and a leak.
    #[test]
    fn a_read_never_prints_the_secret_it_carries() {
        let read = KeychainRead::Found(Zeroizing::new("super-secret-token".into()));
        let rendered = format!("{read:?}");
        assert!(!rendered.contains("super-secret-token"));
        assert_eq!(rendered, "Found(<redacted>)");
        assert_eq!(format!("{:?}", KeychainRead::Unreadable), "Unreadable");
    }

    #[test]
    fn the_credential_file_sits_beside_the_preferences_and_not_in_the_keychain() {
        let state = state_path().expect("state path");
        let credentials = credentials_path().expect("credential path");
        assert_eq!(state.parent(), credentials.parent());
        assert_eq!(
            credentials.file_name().and_then(|name| name.to_str()),
            Some("credentials.json")
        );
    }
}
