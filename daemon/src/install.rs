//! The installed layout: an immutable release store, and which release each
//! instance runs.
//!
//! Two daemons under one OS user used to share one pair of files,
//! `~/.local/bin/spawnd` and `~/.local/bin/spawn-worker`, and every unit
//! named that pair. Installing a second account replaced both files under
//! the first daemon, which kept running its old image while every new worker
//! it launched came from the new files — `worker_mismatch`, no new sessions,
//! and nothing on the machine could say why (2026-09-09, dream). The
//! self-updater had the same shape: its backups and its probation marker sat
//! beside the shared pair, so one instance's update could block another's,
//! and another instance's restart counted as a failed attempt against it.
//!
//! The fix is ownership. A release — one `spawnd` and the `spawn-worker`
//! built with it — is published once into `releases/<version>-<hash>/`, by
//! writing a staging directory and renaming it into place, and is never
//! modified afterwards. Each instance owns a pointer to the release it runs:
//! on Unix a `current` symlink under `instances/<tag>/`, which the unit's
//! `ExecStart` goes through, so the worker beside the running executable is
//! the worker of the same release by construction; on Windows, where a link
//! needs a privilege a user may not have, a hard-linked pair under
//! `instances\<tag>\` that only that instance's update ever swaps. Installing
//! publishes; `possess` and `update` select; nothing ever writes a file
//! another instance is running. `bin/spawnd` on PATH is a symlink into the
//! store, so a person's shell finds a daemon, and no daemon depends on it.
//!
//! ```text
//! <root>/                        ~/.local (Unix), %LOCALAPPDATA%\spawn (Windows)
//!   bin/spawnd -> ../lib/spawn/releases/<id>/spawnd     the command on PATH
//!   lib/spawn/                   (Windows: <root> itself)
//!     releases/<id>/             immutable: spawnd, spawn-worker, release.json
//!     instances/<tag>/current -> ../../releases/<id>    Unix pointer
//!     instances/<tag>/spawnd.updating                   an update on trial
//! <config_dir>/install.json      names <root> for an instance
//! ```
//!
//! A daemon launched from the old shared path adopts its own pair into the
//! store on its first start and, on Unix, re-executes from there before it
//! connects, so a host converges with no operator step and no session lost.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The record beside a published pair.
pub const RELEASE_META: &str = "release.json";
/// The record in an instance's config directory naming its install root.
pub const INSTALL_RECORD: &str = "install.json";
/// Unix: the per-instance pointer under `instances/<tag>/`.
pub const CURRENT_LINK: &str = "current";
/// Windows: the per-instance record under `instances\<tag>\`.
#[cfg(windows)]
pub const CURRENT_RECORD: &str = "current.json";
/// The per-instance update probation marker under `instances/<tag>/`. The
/// same name the in-place updater used beside its binary, because the
/// Windows Run watchdog looks for it beside the pair it launches.
pub const PROBATION_MARKER: &str = "spawnd.updating";
const STAGING_PREFIX: &str = ".staging-";
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
/// A release younger than this is never collected: another installer may
/// have published it and not yet selected it.
const FRESH_RELEASE_GRACE: Duration = Duration::from_secs(15 * 60);
/// A staging directory older than this belongs to an installer that died.
const STALE_STAGING_AGE: Duration = Duration::from_secs(60 * 60);
/// Longest release directory name we will create.
const MAX_RELEASE_ID_LEN: usize = 96;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/// Where SPAWN D keeps what it installs for one OS user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The layout an installer uses when nothing names one:
    /// `$SPAWN_INSTALL_ROOT`, else `~/.local` on Unix and
    /// `%LOCALAPPDATA%\spawn` on Windows — the roots the installers have
    /// always written `bin/` under.
    pub fn default_user() -> Result<Self> {
        if let Some(root) = std::env::var_os("SPAWN_INSTALL_ROOT").filter(|value| !value.is_empty())
        {
            return Ok(Self::at(root));
        }
        #[cfg(windows)]
        {
            dirs::data_local_dir()
                .map(|dir| Self::at(dir.join("spawn")))
                .context("cannot resolve the local application data directory")
        }
        #[cfg(not(windows))]
        {
            dirs::home_dir()
                .map(|home| Self::at(home.join(".local")))
                .context("cannot resolve the home directory")
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn bin_dir(&self) -> PathBuf {
        self.root.join("bin")
    }

    /// Where releases and instance pointers live. `<root>/lib/spawn` on Unix,
    /// the root itself on Windows, where `%LOCALAPPDATA%\spawn` is already
    /// ours alone.
    fn store_dir(&self) -> PathBuf {
        #[cfg(windows)]
        {
            self.root.clone()
        }
        #[cfg(not(windows))]
        {
            self.root.join("lib").join("spawn")
        }
    }

    pub fn releases_dir(&self) -> PathBuf {
        self.store_dir().join("releases")
    }

    pub fn instances_dir(&self) -> PathBuf {
        self.store_dir().join("instances")
    }

    pub fn release_dir(&self, id: &str) -> PathBuf {
        self.releases_dir().join(id)
    }

    /// The instance directory for a config root: the same 8-hex tag the
    /// service unit and the worker runtime directory carry.
    pub fn instance_dir(&self, config_dir: &Path) -> PathBuf {
        self.instances_dir()
            .join(crate::service::instance_name(config_dir))
    }

    pub fn cli_path(&self, stem: &str) -> PathBuf {
        self.bin_dir().join(crate::platform::executable_name(stem))
    }

    /// Whether `store` is this platform's store directory of some root, and
    /// which root.
    fn root_of_store(store: &Path) -> Option<PathBuf> {
        #[cfg(windows)]
        {
            Some(store.to_path_buf())
        }
        #[cfg(not(windows))]
        {
            if store.file_name() != Some(OsStr::new("spawn")) {
                return None;
            }
            let lib = store.parent()?;
            if lib.file_name() != Some(OsStr::new("lib")) {
                return None;
            }
            lib.parent().map(Path::to_path_buf)
        }
    }
}

// ---------------------------------------------------------------------------
// Provenance: where the running executable came from
// ---------------------------------------------------------------------------

/// How the running executable came to be where it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Provenance {
    /// Inside the release store, or (Windows) an instance's linked pair.
    Store { layout: Layout, release_id: String },
    /// The shared `bin/` pair every instance used to launch from, or a pair
    /// placed by hand under `instances/<tag>/` — the layout is known, the
    /// pair is not a published release yet.
    Legacy { layout: Layout },
    /// Anywhere else: a checkout's `target/`, a download folder.
    Unmanaged,
}

impl Provenance {
    pub fn is_legacy(&self) -> bool {
        matches!(self, Self::Legacy { .. })
    }

    pub fn release_id(&self) -> Option<&str> {
        match self {
            Self::Store { release_id, .. } => Some(release_id),
            _ => None,
        }
    }
}

/// The running executable, canonicalized once. Canonical, because on macOS
/// `current_exe` may be the `current` symlink path, and a pointer that moves
/// while the process runs must not move the worker it resolves beside itself.
pub fn running_exe() -> Option<&'static Path> {
    static EXE: OnceLock<Option<PathBuf>> = OnceLock::new();
    EXE.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        Some(fs::canonicalize(&exe).unwrap_or(exe))
    })
    .as_deref()
}

/// The directory the running executable's worker is resolved from.
pub fn running_exe_dir() -> Option<PathBuf> {
    running_exe().and_then(Path::parent).map(Path::to_path_buf)
}

/// The executable a live process runs, and whether the file it was started
/// from has since been replaced on disk — which is exactly the state a daemon
/// is in when an installer swapped the pair under it. Linux reads it from the
/// process itself; elsewhere only the daemon's own heartbeat can say.
pub fn live_exe(pid: u32) -> Option<(PathBuf, bool)> {
    #[cfg(target_os = "linux")]
    {
        let link = fs::read_link(format!("/proc/{pid}/exe")).ok()?;
        let text = link.to_string_lossy();
        match text.strip_suffix(" (deleted)") {
            Some(path) => Some((PathBuf::from(path), true)),
            None => Some((link, false)),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

pub fn provenance() -> &'static Provenance {
    static PROVENANCE: OnceLock<Provenance> = OnceLock::new();
    PROVENANCE.get_or_init(|| running_exe().map_or(Provenance::Unmanaged, provenance_of))
}

/// Classify an executable path. Pure, so every layout has a test.
pub fn provenance_of(exe: &Path) -> Provenance {
    let Some(dir) = exe.parent() else {
        return Provenance::Unmanaged;
    };
    let Some(parent) = dir.parent() else {
        return Provenance::Unmanaged;
    };
    // <store>/releases/<id>/spawnd
    if parent.file_name() == Some(OsStr::new("releases")) {
        if let Some((root, id)) = parent
            .parent()
            .and_then(Layout::root_of_store)
            .zip(dir.file_name().and_then(OsStr::to_str))
        {
            return Provenance::Store {
                layout: Layout::at(root),
                release_id: id.to_owned(),
            };
        }
    }
    // <store>/instances/<tag>/spawnd.exe (Windows linked pair), or a pair
    // placed by hand below <store>/instances/<tag>/ (Unix, dream's recovery).
    let mut ancestor = dir;
    while let Some(up) = ancestor.parent() {
        if up.file_name() == Some(OsStr::new("instances")) {
            if let Some(root) = up.parent().and_then(Layout::root_of_store) {
                let layout = Layout::at(root);
                #[cfg(windows)]
                if ancestor == dir {
                    if let Some(id) = read_current_record(dir) {
                        return Provenance::Store {
                            layout,
                            release_id: id,
                        };
                    }
                }
                return Provenance::Legacy { layout };
            }
        }
        ancestor = up;
    }
    // <root>/bin/spawnd
    if dir.file_name() == Some(OsStr::new("bin")) {
        return Provenance::Legacy {
            layout: Layout::at(parent),
        };
    }
    Provenance::Unmanaged
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReleaseMeta {
    pub id: String,
    pub version: String,
    /// The daemon tree stamped into the pair; empty for a build made outside
    /// a git checkout.
    pub tree: String,
    /// `release` or a variant name, read from the version's build metadata.
    pub variant: String,
    pub spawnd_sha256: String,
    pub spawn_worker_sha256: String,
    pub installed_at_unix_ms: u64,
    /// `install`, `update`, or `adopt` (a running pair brought into the store).
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub dir: PathBuf,
    pub meta: ReleaseMeta,
}

impl Release {
    pub fn id(&self) -> &str {
        &self.meta.id
    }

    pub fn spawnd(&self) -> PathBuf {
        self.dir.join(crate::platform::executable_name("spawnd"))
    }

    pub fn spawn_worker(&self) -> PathBuf {
        self.dir
            .join(crate::platform::executable_name("spawn-worker"))
    }
}

/// The identity a pair reports through `--version`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairIdentity {
    pub version: String,
    pub tree: String,
}

impl PairIdentity {
    pub fn variant(&self) -> &'static str {
        variant_of_version(&self.version)
    }
}

/// The variant a version string names: `0.1.0+g<commit>.diagnostics` is the
/// diagnostics build, anything else is the release build. This is exactly
/// how the manifest and `build.rs` spell it.
pub fn variant_of_version(version: &str) -> &'static str {
    let Some((_, metadata)) = version.split_once('+') else {
        return "release";
    };
    if metadata.split('.').any(|segment| segment == "diagnostics") {
        "diagnostics"
    } else {
        "release"
    }
}

/// A version with its variant segment removed: the release and diagnostics
/// builds of one commit share this, and therefore share a daemon tree.
pub fn base_version(version: &str) -> String {
    let Some((core, metadata)) = version.split_once('+') else {
        return version.to_owned();
    };
    let kept: Vec<&str> = metadata
        .split('.')
        .filter(|segment| *segment != "diagnostics")
        .collect();
    if kept.is_empty() {
        core.to_owned()
    } else {
        format!("{core}+{}", kept.join("."))
    }
}

/// Whether a legacy executable is the shared `<root>/bin/spawnd` every
/// instance used to launch from, as opposed to a pair placed by hand.
pub fn is_shared_legacy_pair(exe: &Path) -> bool {
    match provenance_of(exe) {
        Provenance::Legacy { layout } => exe.parent() == Some(layout.bin_dir().as_path()),
        _ => false,
    }
}

/// The directory name of a release: its version plus four bytes of a digest
/// over both file hashes, so two builds that report the same version — a
/// rebuilt release, a dirty checkout — can never share a directory.
pub fn release_id(version: &str, spawnd_sha256: &str, spawn_worker_sha256: &str) -> String {
    let digest = Sha256::digest(format!(
        "{}\n{}\n",
        spawnd_sha256.to_ascii_lowercase(),
        spawn_worker_sha256.to_ascii_lowercase()
    ));
    let version: String = version
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '+' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(MAX_RELEASE_ID_LEN - 9)
        .collect();
    format!(
        "{version}-{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

pub fn sha256_file(path: &Path) -> io::Result<String> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex(&digest.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// Run `<binary> --version` with a deadline; a binary that hangs is not one
/// we install.
fn run_version(binary: &Path) -> Result<String> {
    let mut child =
        spawn_version(binary).with_context(|| format!("running {} --version", binary.display()))?;
    let mut stdout = child.stdout.take().context("capturing --version output")?;
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut output = Vec::new();
        let _ = stdout.read_to_end(&mut output);
        output
    });
    let deadline = Instant::now() + VERSION_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{} --version did not finish", binary.display());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let output = reader
        .join()
        .map_err(|_| anyhow::anyhow!("collecting --version output"))?;
    if !status.success() {
        bail!("{} --version exited with {status}", binary.display());
    }
    Ok(String::from_utf8_lossy(&output).trim().to_owned())
}

/// `exec` of a file another process still has open for writing fails with
/// ETXTBSY. A freshly downloaded or copied pair is exactly that for a moment
/// when anything else on the machine forks concurrently — the child holds
/// every open descriptor until its own exec — so a brief retry is the
/// difference between an installer that works and one that fails on a busy
/// host.
fn spawn_version(binary: &Path) -> io::Result<std::process::Child> {
    let mut attempts = 0;
    loop {
        match std::process::Command::new(binary)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Err(error) if error.kind() == io::ErrorKind::ExecutableFileBusy && attempts < 40 => {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(25));
            }
            other => return other,
        }
    }
}

/// Parse `spawnd <version>` / `spawn-worker <version> tree=<tree>`.
fn parse_version_line(line: &str, stem: &str) -> Result<(String, Option<String>)> {
    let mut words = line.split_whitespace();
    let name = words.next().unwrap_or_default();
    if name != stem {
        bail!("{stem} --version printed {line:?}");
    }
    let version = words
        .next()
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{stem} --version printed no version"))?;
    let tree = words
        .find_map(|word| word.strip_prefix("tree="))
        .map(str::to_owned);
    Ok((version.to_owned(), tree))
}

/// Ask both binaries who they are, and refuse a pair that disagrees. The
/// store only ever holds matching pairs; this is the gate that makes the
/// worker identity check downstream a tripwire rather than the first line.
pub fn probe_pair(spawnd: &Path, spawn_worker: &Path) -> Result<PairIdentity> {
    let (daemon_version, _) = parse_version_line(&run_version(spawnd)?, "spawnd")?;
    let (worker_version, tree) = parse_version_line(&run_version(spawn_worker)?, "spawn-worker")?;
    if daemon_version != worker_version {
        bail!("spawn-worker {worker_version} does not match spawnd {daemon_version}");
    }
    Ok(PairIdentity {
        version: daemon_version,
        tree: tree.unwrap_or_default(),
    })
}

pub fn read_release(dir: &Path) -> Result<Release> {
    let path = dir.join(RELEASE_META);
    let bytes = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    if bytes.len() > 16 * 1024 {
        bail!("{} is oversized", path.display());
    }
    let meta: ReleaseMeta =
        serde_json::from_slice(&bytes).with_context(|| format!("decoding {}", path.display()))?;
    if dir.file_name().and_then(OsStr::to_str) != Some(meta.id.as_str()) {
        bail!(
            "{} names release {} but sits in {}",
            path.display(),
            meta.id,
            dir.display()
        );
    }
    let release = Release {
        dir: dir.to_path_buf(),
        meta,
    };
    if !release.spawnd().is_file() || !release.spawn_worker().is_file() {
        bail!("release {} is incomplete", release.id());
    }
    Ok(release)
}

pub fn release_by_id(layout: &Layout, id: &str) -> Result<Option<Release>> {
    if id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.') {
        bail!("invalid release id {id:?}");
    }
    let dir = layout.release_dir(id);
    if !dir.join(RELEASE_META).exists() {
        return Ok(None);
    }
    read_release(&dir).map(Some)
}

/// Every complete release in the store, oldest first.
pub fn list_releases(layout: &Layout) -> Vec<Release> {
    let Ok(entries) = fs::read_dir(layout.releases_dir()) else {
        return Vec::new();
    };
    let mut releases: Vec<Release> = entries
        .flatten()
        .filter(|entry| {
            !entry
                .file_name()
                .to_string_lossy()
                .starts_with(STAGING_PREFIX)
        })
        .filter_map(|entry| read_release(&entry.path()).ok())
        .collect();
    releases.sort_by_key(|release| release.meta.installed_at_unix_ms);
    releases
}

/// Whether the files on disk still hash to what the record says.
pub fn verify_release(release: &Release) -> Result<()> {
    let spawnd = sha256_file(&release.spawnd())?;
    let worker = sha256_file(&release.spawn_worker())?;
    if !spawnd.eq_ignore_ascii_case(&release.meta.spawnd_sha256)
        || !worker.eq_ignore_ascii_case(&release.meta.spawn_worker_sha256)
    {
        bail!("release {} does not match its record", release.id());
    }
    Ok(())
}

/// A pair to publish. The files are copied, never moved: the caller keeps
/// whatever it downloaded or built until the release is in place.
pub struct PublishSource<'a> {
    pub spawnd: &'a Path,
    pub spawn_worker: &'a Path,
    pub source: &'a str,
}

fn copy_executable(from: &Path, to: &Path) -> io::Result<()> {
    fs::copy(from, to)?;
    crate::platform::set_executable(to)?;
    fs::File::open(to)?.sync_all()
}

fn write_json_new(path: &Path, value: &impl Serialize) -> io::Result<()> {
    use std::io::Write;
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_file_name(format!(
        "{}.tmp.{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        write_json_new(&temporary, value)?;
        crate::platform::durable_replace(&temporary, path)?;
        crate::platform::sync_parent_dir(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn staging_dir(layout: &Layout) -> PathBuf {
    layout.releases_dir().join(format!(
        "{STAGING_PREFIX}{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ))
}

/// Publish a pair as an immutable release and return it. Publishing the same
/// bytes twice returns the release already there; a different pair under a
/// name already taken is refused, never overwritten.
pub fn publish(layout: &Layout, source: PublishSource<'_>) -> Result<Release> {
    let identity = probe_pair(source.spawnd, source.spawn_worker)?;
    let spawnd_sha256 = sha256_file(source.spawnd)
        .with_context(|| format!("hashing {}", source.spawnd.display()))?;
    let spawn_worker_sha256 = sha256_file(source.spawn_worker)
        .with_context(|| format!("hashing {}", source.spawn_worker.display()))?;
    let meta = ReleaseMeta {
        id: release_id(&identity.version, &spawnd_sha256, &spawn_worker_sha256),
        version: identity.version.clone(),
        tree: identity.tree.clone(),
        variant: identity.variant().to_owned(),
        spawnd_sha256,
        spawn_worker_sha256,
        installed_at_unix_ms: now_unix_ms(),
        source: source.source.to_owned(),
    };
    publish_with_meta(layout, source, meta)
}

/// Publish with a record the caller has already established — the updater
/// knows the signed hashes and the version before it downloads a byte.
pub fn publish_with_meta(
    layout: &Layout,
    source: PublishSource<'_>,
    meta: ReleaseMeta,
) -> Result<Release> {
    let releases = layout.releases_dir();
    fs::create_dir_all(&releases).with_context(|| format!("creating {}", releases.display()))?;
    let final_dir = layout.release_dir(&meta.id);
    if let Some(existing) = release_by_id(layout, &meta.id)? {
        return reuse_existing(existing, &meta);
    }

    let staging = staging_dir(layout);
    fs::create_dir(&staging).with_context(|| format!("creating {}", staging.display()))?;
    let staged = (|| -> Result<()> {
        copy_executable(
            source.spawnd,
            &staging.join(crate::platform::executable_name("spawnd")),
        )
        .context("staging spawnd")?;
        copy_executable(
            source.spawn_worker,
            &staging.join(crate::platform::executable_name("spawn-worker")),
        )
        .context("staging spawn-worker")?;
        write_json_new(&staging.join(RELEASE_META), &meta).context("writing release.json")?;
        // The staged files must reach stable storage before the directory
        // rename publishes them, or a power loss leaves a named release
        // whose files are empty.
        fs::File::open(&staging)?.sync_all().ok();
        Ok(())
    })();
    if let Err(error) = staged {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    match crate::platform::rename_noreplace(&staging, &final_dir) {
        Ok(()) => {
            let _ = crate::platform::sync_parent_dir(&final_dir);
            read_release(&final_dir)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_dir_all(&staging);
            let existing = read_release(&final_dir)
                .with_context(|| format!("release {} appeared but is unreadable", meta.id))?;
            reuse_existing(existing, &meta)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(error).with_context(|| format!("publishing {}", final_dir.display()))
        }
    }
}

fn reuse_existing(existing: Release, wanted: &ReleaseMeta) -> Result<Release> {
    if !existing
        .meta
        .spawnd_sha256
        .eq_ignore_ascii_case(&wanted.spawnd_sha256)
        || !existing
            .meta
            .spawn_worker_sha256
            .eq_ignore_ascii_case(&wanted.spawn_worker_sha256)
    {
        bail!(
            "release {} is already installed with different contents",
            wanted.id
        );
    }
    verify_release(&existing)?;
    Ok(existing)
}

// ---------------------------------------------------------------------------
// The record in the config dir
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct InstallRecord {
    version: u8,
    root: PathBuf,
}

fn write_install_record(config_dir: &Path, layout: &Layout) -> Result<()> {
    write_json_atomic(
        &config_dir.join(INSTALL_RECORD),
        &InstallRecord {
            version: 1,
            root: layout.root().to_path_buf(),
        },
    )
    .with_context(|| format!("recording the install root in {}", config_dir.display()))
}

/// The layout an instance's config directory names, if it has been selected
/// into one.
pub fn recorded_layout(config_dir: &Path) -> Option<Layout> {
    let bytes = fs::read(config_dir.join(INSTALL_RECORD)).ok()?;
    if bytes.len() > 16 * 1024 {
        return None;
    }
    let record: InstallRecord = serde_json::from_slice(&bytes).ok()?;
    (record.version == 1 && record.root.is_absolute()).then(|| Layout::at(record.root))
}

/// The layout that holds an instance's pointer. A daemon running from the
/// store is in the layout that holds it; anything else follows what the
/// instance recorded, then where a legacy launch path says the root is, then
/// the user default.
pub fn layout_for_instance(config_dir: &Path) -> Result<Layout> {
    if let Provenance::Store { layout, .. } = provenance() {
        return Ok(layout.clone());
    }
    if let Some(layout) = recorded_layout(config_dir) {
        return Ok(layout);
    }
    match provenance() {
        Provenance::Legacy { layout } => Ok(layout.clone()),
        _ => Layout::default_user(),
    }
}

// ---------------------------------------------------------------------------
// Per-instance selection
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[derive(Debug, Serialize, Deserialize)]
struct CurrentRecord {
    release: String,
}

#[cfg(windows)]
fn read_current_record(instance_dir: &Path) -> Option<String> {
    let bytes = fs::read(instance_dir.join(CURRENT_RECORD)).ok()?;
    if bytes.len() > 16 * 1024 {
        return None;
    }
    serde_json::from_slice::<CurrentRecord>(&bytes)
        .ok()
        .map(|record| record.release)
}

/// The path the service definition launches: constant across updates.
pub fn launch_path(layout: &Layout, config_dir: &Path) -> PathBuf {
    let instance = layout.instance_dir(config_dir);
    #[cfg(windows)]
    {
        instance.join(crate::platform::executable_name("spawnd"))
    }
    #[cfg(not(windows))]
    {
        instance
            .join(CURRENT_LINK)
            .join(crate::platform::executable_name("spawnd"))
    }
}

/// The relative symlink target from `instances/<tag>/` to a release.
#[cfg(not(windows))]
fn relative_release_target(release: &Release) -> PathBuf {
    Path::new("..")
        .join("..")
        .join("releases")
        .join(release.id())
}

/// Point `config_dir`'s instance at `release`. Atomic: a reader sees the old
/// pointer or the new one, never a torn pair.
#[cfg(not(windows))]
pub fn select(layout: &Layout, config_dir: &Path, release: &Release) -> Result<()> {
    let instance = layout.instance_dir(config_dir);
    fs::create_dir_all(&instance).with_context(|| format!("creating {}", instance.display()))?;
    let current = instance.join(CURRENT_LINK);
    let temporary = instance.join(format!("{CURRENT_LINK}.tmp.{}", std::process::id()));
    let _ = fs::remove_file(&temporary);
    std::os::unix::fs::symlink(relative_release_target(release), &temporary)
        .with_context(|| format!("linking {}", temporary.display()))?;
    if let Err(error) = fs::rename(&temporary, &current) {
        let _ = fs::remove_file(&temporary);
        return Err(error).with_context(|| format!("selecting {}", release.id()));
    }
    let _ = crate::platform::sync_parent_dir(&current);
    write_install_record(config_dir, layout)
}

#[cfg(windows)]
pub fn select(layout: &Layout, config_dir: &Path, release: &Release) -> Result<()> {
    let instance = layout.instance_dir(config_dir);
    fs::create_dir_all(&instance).with_context(|| format!("creating {}", instance.display()))?;
    let live_daemon = instance.join(crate::platform::executable_name("spawnd"));
    let live_worker = instance.join(crate::platform::executable_name("spawn-worker"));
    let tag = format!("tmp.{}", std::process::id());
    let temporary_daemon = crate::platform::executable_variant(&live_daemon, &tag)?;
    let temporary_worker = crate::platform::executable_variant(&live_worker, &tag)?;
    let _ = fs::remove_file(&temporary_daemon);
    let _ = fs::remove_file(&temporary_worker);
    link_or_copy(&release.spawnd(), &temporary_daemon)?;
    link_or_copy(&release.spawn_worker(), &temporary_worker)?;
    let swapped = if live_daemon.exists() || live_worker.exists() {
        swap_pair(
            &live_daemon,
            &temporary_daemon,
            &live_worker,
            &temporary_worker,
        )
    } else {
        crate::platform::rename_noreplace(&temporary_daemon, &live_daemon).and_then(|()| {
            crate::platform::rename_noreplace(&temporary_worker, &live_worker).inspect_err(|_| {
                let _ = fs::remove_file(&live_daemon);
            })
        })
    };
    if let Err(error) = swapped {
        let _ = fs::remove_file(&temporary_daemon);
        let _ = fs::remove_file(&temporary_worker);
        return Err(error).with_context(|| format!("selecting {}", release.id()));
    }
    write_json_atomic(
        &instance.join(CURRENT_RECORD),
        &CurrentRecord {
            release: release.id().to_owned(),
        },
    )
    .context("recording the selected release")?;
    write_install_record(config_dir, layout)
}

/// Windows: the previous pair stays beside the live one as `.prev` until the
/// new daemon registers; this puts it back and records the release it was.
#[cfg(windows)]
pub fn select_previous_pair(layout: &Layout, config_dir: &Path, previous: &Release) -> Result<()> {
    let instance = layout.instance_dir(config_dir);
    let live_daemon = instance.join(crate::platform::executable_name("spawnd"));
    let live_worker = instance.join(crate::platform::executable_name("spawn-worker"));
    revert_pair(&live_daemon, &live_worker).context("restoring the previous pair")?;
    write_json_atomic(
        &instance.join(CURRENT_RECORD),
        &CurrentRecord {
            release: previous.id().to_owned(),
        },
    )
    .context("recording the restored release")
}

/// Windows: whether the instance still holds a complete `.prev` pair.
#[cfg(windows)]
pub fn previous_pair_complete(layout: &Layout, config_dir: &Path) -> bool {
    let instance = layout.instance_dir(config_dir);
    previous_path(&instance.join(crate::platform::executable_name("spawnd"))).is_file()
        && previous_path(&instance.join(crate::platform::executable_name("spawn-worker"))).is_file()
}

/// Windows: drop the `.prev` and `.failed.*` files a completed update leaves.
#[cfg(windows)]
pub fn cleanup_pair_backups(layout: &Layout, config_dir: &Path) {
    let instance = layout.instance_dir(config_dir);
    for stem in ["spawnd", "spawn-worker"] {
        let live = instance.join(crate::platform::executable_name(stem));
        let _ = fs::remove_file(previous_path(&live));
        let prefix = format!("{stem}.failed.");
        if let Ok(entries) = fs::read_dir(&instance) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with(&prefix) && name.ends_with(std::env::consts::EXE_SUFFIX) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

#[cfg(windows)]
fn link_or_copy(from: &Path, to: &Path) -> Result<()> {
    if fs::hard_link(from, to).is_ok() {
        return Ok(());
    }
    copy_executable(from, to).with_context(|| format!("copying {}", from.display()))
}

/// The release an instance is pointed at, if any.
pub fn selected(layout: &Layout, config_dir: &Path) -> Result<Option<Release>> {
    let instance = layout.instance_dir(config_dir);
    selected_in(layout, &instance)
}

fn selected_in(layout: &Layout, instance: &Path) -> Result<Option<Release>> {
    #[cfg(windows)]
    {
        let Some(id) = read_current_record(instance) else {
            return Ok(None);
        };
        release_by_id(layout, &id)
    }
    #[cfg(not(windows))]
    {
        let link = instance.join(CURRENT_LINK);
        let target = match fs::read_link(&link) {
            Ok(target) => target,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("reading {}", link.display())),
        };
        let resolved = if target.is_absolute() {
            target
        } else {
            instance.join(target)
        };
        let canonical = match fs::canonicalize(&resolved) {
            Ok(canonical) => canonical,
            // A pointer at a release that is gone: not selected, and doctor
            // says so through the launch check.
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| format!("resolving {}", link.display()))
            }
        };
        let _ = layout;
        read_release(&canonical).map(Some)
    }
}

/// Forget an instance's selection and probation state: exorcise and reset.
pub fn clear_selection(layout: &Layout, config_dir: &Path) -> Result<()> {
    let instance = layout.instance_dir(config_dir);
    match fs::remove_dir_all(&instance) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("removing {}", instance.display())),
    }
}

pub fn probation_marker_path(layout: &Layout, config_dir: &Path) -> PathBuf {
    layout.instance_dir(config_dir).join(PROBATION_MARKER)
}

/// Bring a pair into the store under `config_dir`'s instance, or return the
/// selection already there. This is how a legacy launch converges and how a
/// fresh `possess` gets its first release.
///
/// Which pair: the one the instance's live daemon runs, when there is one
/// and the machine can name it — so resuming a diagnostics instance from a
/// release-build command keeps it on diagnostics — else this process's own.
pub fn ensure_selected(config_dir: &Path) -> Result<(Layout, Release)> {
    let layout = layout_for_instance(config_dir)?;
    if let Some(release) = selected(&layout, config_dir)? {
        return Ok((layout, release));
    }
    let release = match live_daemon_exe(config_dir) {
        Some(exe) if running_exe() != Some(exe.as_path()) => adopt_pair_at(&layout, &exe)
            .or_else(|error| {
                tracing::warn!(%error, "could not adopt the running daemon's pair; adopting this command's");
                adopt_running_pair(&layout)
            })?,
        _ => adopt_running_pair(&layout)?,
    };
    select(&layout, config_dir, &release)?;
    Ok((layout, release))
}

/// The executable the instance's live daemon runs, when a heartbeat is live
/// and the kernel or the heartbeat names it.
fn live_daemon_exe(config_dir: &Path) -> Option<PathBuf> {
    let state = crate::state::read(config_dir).ok().flatten()?;
    if !crate::state::daemon_state_is_live(&state) {
        return None;
    }
    match live_exe(state.pid) {
        Some((_, true)) => None,
        Some((exe, false)) => Some(exe),
        None => state.exe.as_deref().map(PathBuf::from),
    }
}

/// Publish the pair at `exe` (and the worker beside it), or return the
/// release it already is when it lives in this layout's store.
fn adopt_pair_at(layout: &Layout, exe: &Path) -> Result<Release> {
    if let Provenance::Store {
        layout: own,
        release_id,
    } = provenance_of(exe)
    {
        if &own == layout {
            if let Some(release) = release_by_id(layout, &release_id)? {
                return Ok(release);
            }
        }
    }
    let worker = exe
        .parent()
        .map(|dir| dir.join(crate::platform::executable_name("spawn-worker")))
        .filter(|worker| worker.is_file())
        .with_context(|| format!("no spawn-worker beside {}", exe.display()))?;
    publish(
        layout,
        PublishSource {
            spawnd: exe,
            spawn_worker: &worker,
            source: "adopt",
        },
    )
}

/// The running pair as a release: the store copy when this is one, else the
/// pair beside the executable, published.
pub fn adopt_running_pair(layout: &Layout) -> Result<Release> {
    if let Provenance::Store {
        layout: own,
        release_id,
    } = provenance()
    {
        if own == layout {
            if let Some(release) = release_by_id(layout, release_id)? {
                return Ok(release);
            }
        }
    }
    let exe = running_exe().context("resolving the running spawnd")?;
    let worker = exe
        .parent()
        .map(|dir| dir.join(crate::platform::executable_name("spawn-worker")))
        .filter(|worker| worker.is_file())
        .context("no spawn-worker beside the running spawnd")?;
    publish(
        layout,
        PublishSource {
            spawnd: exe,
            spawn_worker: &worker,
            source: "adopt",
        },
    )
}

// ---------------------------------------------------------------------------
// Startup: a legacy launch converges on the store
// ---------------------------------------------------------------------------

/// What `run` does before anything else about where it was launched from.
#[derive(Debug, PartialEq, Eq)]
pub enum LaunchRedirect {
    /// Running from the store, or from nowhere the store manages.
    None,
    /// Unix: the instance's release is at this path; re-execute from it.
    Exec(PathBuf),
    /// The instance is recorded and its pointer set; this process keeps its
    /// legacy pair until it restarts (Windows, or an exec that cannot happen).
    #[cfg_attr(unix, allow(dead_code))]
    Adopted,
}

/// A daemon launched from the shared `bin/` pair, or from a pair placed by
/// hand, adopts it into the store and — on Unix — re-executes from there, so
/// the rest of its life resolves its worker beside an immutable release.
/// While a legacy probation marker sits beside the executable the previous
/// updater's promise is kept first, and adoption waits for the next start.
pub fn prepare_launch(config_dir: &Path) -> Result<LaunchRedirect> {
    let Provenance::Legacy { .. } = provenance() else {
        return Ok(LaunchRedirect::None);
    };
    if legacy_marker_present() {
        return Ok(LaunchRedirect::None);
    }
    let (layout, release) = ensure_selected(config_dir)?;
    tracing::info!(
        release = release.id(),
        launch = %launch_path(&layout, config_dir).display(),
        "this instance now runs from the release store"
    );
    if let Err(error) = crate::service::rewrite_launch_path(config_dir, &layout) {
        tracing::warn!(%error, "could not point the background service at the release store; it follows at the next possess");
    }
    #[cfg(unix)]
    {
        Ok(LaunchRedirect::Exec(release.spawnd()))
    }
    #[cfg(not(unix))]
    {
        Ok(LaunchRedirect::Adopted)
    }
}

/// Whether the updater that ran before this build left its marker beside
/// the executable.
pub fn legacy_marker_present() -> bool {
    running_exe()
        .map(|exe| exe.with_file_name("spawnd.updating"))
        .is_some_and(|marker| marker.exists())
}

// ---------------------------------------------------------------------------
// The command on PATH
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliEntry {
    pub path: PathBuf,
    pub replaced: bool,
    pub reason: Option<String>,
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

/// Point `bin/spawnd` and `bin/spawn-worker` at a release. A regular-file
/// pair — the layout every instance used to launch from — is left alone
/// while `legacy_in_use` says some instance still starts from it, because
/// replacing its worker under a running daemon is the incident this module
/// exists to end.
pub fn set_cli_entry(layout: &Layout, release: &Release, legacy_in_use: bool) -> Result<CliEntry> {
    let bin = layout.bin_dir();
    fs::create_dir_all(&bin).with_context(|| format!("creating {}", bin.display()))?;
    let daemon_path = layout.cli_path("spawnd");
    let worker_path = layout.cli_path("spawn-worker");
    if legacy_in_use && (is_regular_file(&daemon_path) || is_regular_file(&worker_path)) {
        return Ok(CliEntry {
            path: daemon_path,
            replaced: false,
            reason: Some(
                "a daemon on this machine still starts from it; it follows once that instance restarts"
                    .into(),
            ),
        });
    }
    for (live, source) in [
        (&daemon_path, release.spawnd()),
        (&worker_path, release.spawn_worker()),
    ] {
        install_cli_link(layout, live, &source)?;
    }
    Ok(CliEntry {
        path: daemon_path,
        replaced: true,
        reason: None,
    })
}

#[cfg(not(windows))]
fn install_cli_link(layout: &Layout, live: &Path, source: &Path) -> Result<()> {
    let target = match source.strip_prefix(layout.root()) {
        Ok(relative) => Path::new("..").join(relative),
        Err(_) => source.to_path_buf(),
    };
    let temporary = live.with_file_name(format!(
        "{}.tmp.{}",
        live.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let _ = fs::remove_file(&temporary);
    std::os::unix::fs::symlink(&target, &temporary)
        .with_context(|| format!("linking {}", temporary.display()))?;
    if let Err(error) = fs::rename(&temporary, live) {
        let _ = fs::remove_file(&temporary);
        return Err(error).with_context(|| format!("installing {}", live.display()));
    }
    let _ = crate::platform::sync_parent_dir(live);
    Ok(())
}

#[cfg(windows)]
fn install_cli_link(_layout: &Layout, live: &Path, source: &Path) -> Result<()> {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let temporary = crate::platform::executable_variant(live, &format!("tmp.{nonce}"))?;
    let aside = crate::platform::executable_variant(live, &format!("old.{nonce}"))?;
    link_or_copy(source, &temporary)?;
    if live.exists() {
        // A running command can be renamed, not replaced.
        crate::platform::rename_noreplace(live, &aside)
            .with_context(|| format!("moving {} aside", live.display()))?;
    }
    if let Err(error) = crate::platform::rename_noreplace(&temporary, live) {
        let _ = fs::remove_file(&temporary);
        let _ = crate::platform::rename_noreplace(&aside, live);
        return Err(error).with_context(|| format!("installing {}", live.display()));
    }
    // Still mapped by a running command: left for the next sweep.
    let _ = fs::remove_file(&aside);
    sweep_cli_leftovers(live);
    Ok(())
}

#[cfg(windows)]
fn sweep_cli_leftovers(live: &Path) {
    let Some(parent) = live.parent() else { return };
    let Some(stem) = live.file_stem().and_then(OsStr::to_str) else {
        return;
    };
    let prefix = format!("{stem}.old.");
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&prefix) && name.ends_with(std::env::consts::EXE_SUFFIX) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// The release the command on PATH resolves to, when it is a store link.
pub fn cli_release(layout: &Layout) -> Option<Release> {
    let path = layout.cli_path("spawnd");
    #[cfg(windows)]
    {
        // A hard link carries no name back; the record says nothing either.
        // The command's own version is what `status` reports for it.
        let _ = path;
        None
    }
    #[cfg(not(windows))]
    {
        let target = fs::read_link(&path).ok()?;
        let resolved = if target.is_absolute() {
            target
        } else {
            path.parent()?.join(target)
        };
        let canonical = fs::canonicalize(resolved).ok()?;
        read_release(canonical.parent()?).ok()
    }
}

// ---------------------------------------------------------------------------
// Garbage collection
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq, Eq)]
pub struct GcReport {
    pub removed: Vec<String>,
    pub kept: Vec<String>,
}

/// Instance directories in the store, each with what it selects.
fn instance_pointers(layout: &Layout) -> Vec<(PathBuf, Option<String>)> {
    let Ok(entries) = fs::read_dir(layout.instances_dir()) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| {
            let dir = entry.path();
            let selected = selected_in(layout, &dir)
                .ok()
                .flatten()
                .map(|release| release.meta.id);
            (dir, selected)
        })
        .collect()
}

#[derive(Deserialize)]
struct MarkerReleases {
    #[serde(default)]
    previous_release: Option<String>,
    #[serde(default)]
    attempted_release: Option<String>,
}

/// Remove releases nothing refers to. Referenced means: selected by any
/// instance, named by any probation marker, the command on PATH, the release
/// this process runs, recorded by a live daemon's heartbeat, or published in
/// the last fifteen minutes. Anything else is a release every instance has
/// moved off. Stale staging directories go too.
pub fn collect_garbage(layout: &Layout, config_dirs: &[PathBuf]) -> GcReport {
    let mut protected: std::collections::BTreeSet<String> = Default::default();
    for (dir, selected) in instance_pointers(layout) {
        protected.extend(selected);
        if let Ok(bytes) = fs::read(dir.join(PROBATION_MARKER)) {
            if let Ok(marker) = serde_json::from_slice::<MarkerReleases>(&bytes) {
                protected.extend(marker.previous_release);
                protected.extend(marker.attempted_release);
            }
        }
    }
    if let Some(cli) = cli_release(layout) {
        protected.insert(cli.meta.id);
    }
    if let Some(id) = provenance().release_id() {
        protected.insert(id.to_owned());
    }
    for config_dir in config_dirs {
        if let Ok(Some(state)) = crate::state::read(config_dir) {
            if crate::state::daemon_state_is_live(&state) {
                protected.extend(state.release);
            }
        }
    }
    let now = now_unix_ms();
    let mut report = GcReport::default();
    for release in list_releases(layout) {
        let fresh = now.saturating_sub(release.meta.installed_at_unix_ms)
            < FRESH_RELEASE_GRACE.as_millis() as u64;
        if protected.contains(release.id()) || fresh {
            report.kept.push(release.meta.id);
            continue;
        }
        match fs::remove_dir_all(&release.dir) {
            Ok(()) => report.removed.push(release.meta.id),
            Err(_) => report.kept.push(release.meta.id),
        }
    }
    if let Ok(entries) = fs::read_dir(layout.releases_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with(STAGING_PREFIX) {
                continue;
            }
            let stale = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age > STALE_STAGING_AGE);
            if stale {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    report
}

/// The config directories a CLI can see: the default base and every account
/// instance under it. Used to find live heartbeats and legacy launches.
pub fn known_config_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(base) = crate::possess::default_instance_base() {
        if let Ok(accounts) = crate::possess::account_dirs_with_creds(&base) {
            dirs.extend(accounts);
        }
        dirs.push(base);
    }
    if let Ok(explicit) = crate::config::config_dir() {
        if !dirs.contains(&explicit) {
            dirs.push(explicit);
        }
    }
    dirs
}

// ---------------------------------------------------------------------------
// Windows pair swaps (shared with the legacy in-place probation)
// ---------------------------------------------------------------------------

pub fn previous_path(live: &Path) -> PathBuf {
    crate::platform::executable_variant(live, "prev")
        .expect("installed binary path must have a file name and target suffix")
}

/// Replace `live` with `temporary`, keeping the old file as `.prev`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn swap_one(live: &Path, temporary: &Path) -> io::Result<()> {
    let previous = previous_path(live);
    if previous.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "previous binary still exists",
        ));
    }
    crate::platform::rename_noreplace(live, &previous)?;
    if let Err(error) = crate::platform::rename_noreplace(temporary, live) {
        let _ = crate::platform::rename_noreplace(&previous, live);
        return Err(error);
    }
    Ok(())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn rollback_swapped(live: &Path, temporary: &Path) {
    let previous = previous_path(live);
    if crate::platform::rename_noreplace(live, temporary).is_ok() {
        let _ = crate::platform::rename_noreplace(&previous, live);
    }
}

/// Swap both halves of a pair, undoing the first when the second fails.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn swap_pair(
    daemon: &Path,
    daemon_temporary: &Path,
    worker: &Path,
    worker_temporary: &Path,
) -> io::Result<()> {
    swap_one(daemon, daemon_temporary)?;
    if let Err(error) = swap_one(worker, worker_temporary) {
        rollback_swapped(daemon, daemon_temporary);
        return Err(error);
    }
    // Both renames are atomic but not yet durable. Commit the directory
    // entries so a power loss here cannot leave the pair torn.
    let _ = crate::platform::sync_parent_dir(daemon);
    if worker.parent() != daemon.parent() {
        let _ = crate::platform::sync_parent_dir(worker);
    }
    Ok(())
}

/// Restore the complete previous pair. Both backups are checked before the
/// first rename, and every partial step is rolled back on failure.
pub fn revert_pair(daemon: &Path, worker: &Path) -> io::Result<()> {
    let daemon_previous = previous_path(daemon);
    let worker_previous = previous_path(worker);
    if !daemon_previous.is_file() || !worker_previous.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "complete previous daemon pair is unavailable",
        ));
    }
    let daemon_failed =
        crate::platform::executable_variant(daemon, &format!("failed.{}", std::process::id()))?;
    let worker_failed =
        crate::platform::executable_variant(worker, &format!("failed.{}", std::process::id()))?;
    if daemon_failed.exists() || worker_failed.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "health-revert temporary already exists",
        ));
    }

    crate::platform::rename_noreplace(daemon, &daemon_failed)?;
    if let Err(error) = crate::platform::rename_noreplace(&daemon_previous, daemon) {
        let _ = crate::platform::rename_noreplace(&daemon_failed, daemon);
        return Err(error);
    }
    if let Err(error) = crate::platform::rename_noreplace(worker, &worker_failed) {
        let _ = crate::platform::rename_noreplace(daemon, &daemon_previous);
        let _ = crate::platform::rename_noreplace(&daemon_failed, daemon);
        return Err(error);
    }
    if let Err(error) = crate::platform::rename_noreplace(&worker_previous, worker) {
        let _ = crate::platform::rename_noreplace(&worker_failed, worker);
        let _ = crate::platform::rename_noreplace(daemon, &daemon_previous);
        let _ = crate::platform::rename_noreplace(&daemon_failed, daemon);
        return Err(error);
    }

    #[cfg(not(windows))]
    {
        let _ = fs::remove_file(daemon_failed);
        let _ = fs::remove_file(worker_failed);
    }
    #[cfg(windows)]
    {
        // The failed daemon image is still mapped by this process. The
        // replacement removes both failed images after it registers.
        let _ = (daemon_failed, worker_failed);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// `spawnd __publish-release`: what the installers hand off to
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct PublishOutput {
    release: String,
    version: String,
    variant: String,
    dir: String,
    cli: String,
    cli_replaced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cli_note: Option<String>,
}

/// Publish the pair beside this executable into the store and make it the
/// command on PATH. The installers download into a scratch directory and run
/// this from there, so the shell never decides where anything lands.
pub fn publish_self(args: &crate::cli::PublishReleaseArgs) -> Result<()> {
    let exe = running_exe().context("resolving this spawnd")?;
    let worker = exe
        .parent()
        .map(|dir| dir.join(crate::platform::executable_name("spawn-worker")))
        .filter(|worker| worker.is_file())
        .context("spawn-worker must sit beside this spawnd")?;
    let layout = match &args.install_root {
        Some(root) => Layout::at(root),
        None => Layout::default_user()?,
    };
    let release = publish(
        &layout,
        PublishSource {
            spawnd: exe,
            spawn_worker: &worker,
            source: "install",
        },
    )?;
    let legacy_in_use = crate::service::legacy_pair_in_use(&layout);
    let cli = set_cli_entry(&layout, &release, legacy_in_use)?;
    let _ = collect_garbage(&layout, &known_config_dirs());
    let output = PublishOutput {
        release: release.id().to_owned(),
        version: release.meta.version.clone(),
        variant: release.meta.variant.clone(),
        dir: release.dir.display().to_string(),
        cli: cli.path.display().to_string(),
        cli_replaced: cli.replaced,
        cli_note: cli.reason.clone(),
    };
    if args.json {
        println!("{}", serde_json::to_string(&output)?);
        return Ok(());
    }
    for line in publish_lines(&output) {
        println!("{line}");
    }
    Ok(())
}

fn publish_lines(output: &PublishOutput) -> Vec<String> {
    let mut lines = vec![format!(
        "spawn: published {} ({}) to {}",
        output.version, output.variant, output.dir
    )];
    if output.cli_replaced {
        lines.push(format!("spawn: {} now runs this release", output.cli));
    } else {
        lines.push(format!(
            "spawn: {} was left as it is: {}",
            output.cli,
            output.cli_note.as_deref().unwrap_or("kept")
        ));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_pair(dir: &Path, version: &str, tree: &str, body_tag: &str) -> (PathBuf, PathBuf) {
        let spawnd = dir.join(crate::platform::executable_name("spawnd"));
        let worker = dir.join(crate::platform::executable_name("spawn-worker"));
        fs::write(
            &spawnd,
            format!("#!/bin/sh\n# {body_tag}\nprintf 'spawnd {version}\\n'\n"),
        )
        .unwrap();
        fs::write(
            &worker,
            format!("#!/bin/sh\n# {body_tag}\nprintf 'spawn-worker {version} tree={tree}\\n'\n"),
        )
        .unwrap();
        crate::platform::set_executable(&spawnd).unwrap();
        crate::platform::set_executable(&worker).unwrap();
        (spawnd, worker)
    }

    #[test]
    fn the_layout_has_one_shape_per_platform() {
        let layout = Layout::at("/home/x/.local");
        assert_eq!(layout.bin_dir(), PathBuf::from("/home/x/.local/bin"));
        #[cfg(not(windows))]
        {
            assert_eq!(
                layout.releases_dir(),
                PathBuf::from("/home/x/.local/lib/spawn/releases")
            );
            assert_eq!(
                layout.instances_dir(),
                PathBuf::from("/home/x/.local/lib/spawn/instances")
            );
        }
        #[cfg(windows)]
        {
            assert_eq!(
                layout.releases_dir(),
                PathBuf::from("/home/x/.local/releases")
            );
        }
        let instance = layout.instance_dir(Path::new("/srv/spawn/alice"));
        assert_eq!(
            instance.file_name().unwrap().to_string_lossy().len(),
            8,
            "the instance directory carries the service unit's 8-hex tag"
        );
        assert_eq!(
            instance.file_name().unwrap().to_string_lossy(),
            crate::service::instance_name(Path::new("/srv/spawn/alice"))
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn provenance_reads_every_launch_path_the_fleet_has() {
        let store = provenance_of(Path::new(
            "/home/x/.local/lib/spawn/releases/0.1.0+gabc-12345678/spawnd",
        ));
        assert_eq!(
            store,
            Provenance::Store {
                layout: Layout::at("/home/x/.local"),
                release_id: "0.1.0+gabc-12345678".into(),
            }
        );
        // The shared pair every instance launched from.
        assert_eq!(
            provenance_of(Path::new("/home/x/.local/bin/spawnd")),
            Provenance::Legacy {
                layout: Layout::at("/home/x/.local")
            }
        );
        // dream's hand-made recovery: a pair below instances/<tag>/.
        assert_eq!(
            provenance_of(Path::new(
                "/home/oem/.local/lib/spawn/instances/0fc1d50c/bin/spawnd"
            )),
            Provenance::Legacy {
                layout: Layout::at("/home/oem/.local")
            }
        );
        // A custom install root keeps its own store beside its bin.
        assert_eq!(
            provenance_of(Path::new("/opt/spawn/bin/spawnd")),
            Provenance::Legacy {
                layout: Layout::at("/opt/spawn")
            }
        );
        // A checkout is nobody's install.
        assert_eq!(
            provenance_of(Path::new(
                "/home/x/projects/spawn/daemon/target/debug/spawnd"
            )),
            Provenance::Unmanaged
        );
        // `releases/` under a directory that is not a store is not a store.
        assert_eq!(
            provenance_of(Path::new("/tmp/releases/x/spawnd")),
            Provenance::Unmanaged
        );
    }

    #[test]
    fn variants_are_read_from_the_version_metadata() {
        assert_eq!(variant_of_version("0.1.0+g32c8d4c15a37"), "release");
        assert_eq!(
            variant_of_version("0.1.0+g32c8d4c15a37.diagnostics"),
            "diagnostics"
        );
        assert_eq!(variant_of_version("0.1.0+diagnostics"), "diagnostics");
        assert_eq!(variant_of_version("0.1.0"), "release");
        // Only an exact metadata segment counts.
        assert_eq!(variant_of_version("0.1.0+gdiagnosticsish"), "release");
    }

    #[test]
    fn a_variant_and_its_release_share_a_base_version() {
        assert_eq!(base_version("0.1.0+gabc.diagnostics"), "0.1.0+gabc");
        assert_eq!(base_version("0.1.0+gabc"), "0.1.0+gabc");
        assert_eq!(base_version("0.1.0+diagnostics"), "0.1.0");
        assert_eq!(base_version("0.1.0"), "0.1.0");
        #[cfg(not(windows))]
        {
            assert!(is_shared_legacy_pair(Path::new(
                "/home/x/.local/bin/spawnd"
            )));
            assert!(!is_shared_legacy_pair(Path::new(
                "/home/oem/.local/lib/spawn/instances/0fc1d50c/bin/spawnd"
            )));
            assert!(!is_shared_legacy_pair(Path::new(
                "/home/x/.local/lib/spawn/releases/0.1.0+gabc-12345678/spawnd"
            )));
        }
    }

    #[test]
    fn release_ids_are_version_plus_a_pair_digest() {
        let id = release_id("0.1.0+gabc.diagnostics", &"a".repeat(64), &"b".repeat(64));
        assert!(id.starts_with("0.1.0+gabc.diagnostics-"));
        assert_eq!(id.len(), "0.1.0+gabc.diagnostics-".len() + 8);
        // The same version with different bytes is a different release.
        assert_ne!(
            id,
            release_id("0.1.0+gabc.diagnostics", &"a".repeat(64), &"c".repeat(64))
        );
        // Case of the hashes does not matter; a hostile version cannot escape.
        assert_eq!(
            id,
            release_id("0.1.0+gabc.diagnostics", &"A".repeat(64), &"B".repeat(64))
        );
        assert!(!release_id("../../etc", "a", "b").contains('/'));
    }

    #[test]
    fn version_lines_parse_and_reject_the_wrong_binary() {
        assert_eq!(
            parse_version_line("spawnd 0.1.0+gabc", "spawnd").unwrap(),
            ("0.1.0+gabc".into(), None)
        );
        assert_eq!(
            parse_version_line("spawn-worker 0.1.0+gabc tree=deadbeef", "spawn-worker").unwrap(),
            ("0.1.0+gabc".into(), Some("deadbeef".into()))
        );
        assert!(parse_version_line("spawn-worker 0.1.0", "spawnd").is_err());
        assert!(parse_version_line("spawnd", "spawnd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn publishing_is_immutable_deduplicated_and_refuses_a_different_pair_under_one_name() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::at(temp.path().join("root"));
        let source = temp.path().join("download");
        fs::create_dir_all(&source).unwrap();
        let (spawnd, worker) = fake_pair(&source, "0.1.0+gaaa", &"1".repeat(40), "one");

        let first = publish(
            &layout,
            PublishSource {
                spawnd: &spawnd,
                spawn_worker: &worker,
                source: "install",
            },
        )
        .unwrap();
        assert_eq!(first.meta.version, "0.1.0+gaaa");
        assert_eq!(first.meta.tree, "1".repeat(40));
        assert_eq!(first.meta.variant, "release");
        assert!(first.spawnd().is_file() && first.spawn_worker().is_file());
        assert!(first.dir.starts_with(layout.releases_dir()));
        assert!(fs::read_dir(layout.releases_dir())
            .unwrap()
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(STAGING_PREFIX)));

        // The same bytes again: the release already there, nothing rewritten.
        let before = fs::metadata(first.spawnd()).unwrap().modified().unwrap();
        let again = publish(
            &layout,
            PublishSource {
                spawnd: &spawnd,
                spawn_worker: &worker,
                source: "update",
            },
        )
        .unwrap();
        assert_eq!(again, first);
        assert_eq!(
            fs::metadata(first.spawnd()).unwrap().modified().unwrap(),
            before
        );

        // Different bytes, same version: a different release directory.
        let source_two = temp.path().join("download-two");
        fs::create_dir_all(&source_two).unwrap();
        let (spawnd_two, worker_two) = fake_pair(&source_two, "0.1.0+gaaa", &"1".repeat(40), "two");
        let second = publish(
            &layout,
            PublishSource {
                spawnd: &spawnd_two,
                spawn_worker: &worker_two,
                source: "install",
            },
        )
        .unwrap();
        assert_ne!(second.id(), first.id());
        assert_eq!(list_releases(&layout).len(), 2);

        // A pair whose halves disagree never becomes a release.
        let bad = temp.path().join("bad");
        fs::create_dir_all(&bad).unwrap();
        let (bad_spawnd, _) = fake_pair(&bad, "0.1.0+gbbb", &"2".repeat(40), "bad");
        let error = publish(
            &layout,
            PublishSource {
                spawnd: &bad_spawnd,
                spawn_worker: &worker,
                source: "install",
            },
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("does not match"), "{error}");
        assert_eq!(list_releases(&layout).len(), 2);

        // A record that lies about its bytes is refused when reused.
        let tampered = first.dir.join(RELEASE_META);
        let mut meta = first.meta.clone();
        meta.spawnd_sha256 = "f".repeat(64);
        fs::write(&tampered, serde_json::to_vec(&meta).unwrap()).unwrap();
        let error = publish(
            &layout,
            PublishSource {
                spawnd: &spawnd,
                spawn_worker: &worker,
                source: "install",
            },
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("different contents"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn selection_is_an_atomic_pointer_per_instance_and_the_worker_is_its_sibling() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::at(temp.path().join("root"));
        let source = temp.path().join("download");
        fs::create_dir_all(&source).unwrap();
        let (spawnd, worker) = fake_pair(&source, "0.1.0+gaaa", &"1".repeat(40), "one");
        let release = publish(
            &layout,
            PublishSource {
                spawnd: &spawnd,
                spawn_worker: &worker,
                source: "install",
            },
        )
        .unwrap();
        let (spawnd_two, worker_two) =
            fake_pair(&source, "0.1.0+gbbb.diagnostics", &"1".repeat(40), "two");
        let diagnostics = publish(
            &layout,
            PublishSource {
                spawnd: &spawnd_two,
                spawn_worker: &worker_two,
                source: "install",
            },
        )
        .unwrap();
        assert_eq!(diagnostics.meta.variant, "diagnostics");

        let alice = temp.path().join("config").join("alice");
        let bob = temp.path().join("config").join("bob");
        fs::create_dir_all(&alice).unwrap();
        fs::create_dir_all(&bob).unwrap();
        assert_eq!(selected(&layout, &alice).unwrap(), None);

        select(&layout, &alice, &release).unwrap();
        select(&layout, &bob, &diagnostics).unwrap();
        assert_eq!(
            selected(&layout, &alice).unwrap().unwrap().id(),
            release.id()
        );
        assert_eq!(
            selected(&layout, &bob).unwrap().unwrap().id(),
            diagnostics.id()
        );
        // The launch path is constant and resolves through the pointer to the
        // selected release, whose worker is the file beside it.
        let launch = launch_path(&layout, &alice);
        assert!(launch.ends_with("current/spawnd"), "{}", launch.display());
        let resolved = fs::canonicalize(&launch).unwrap();
        assert_eq!(resolved, fs::canonicalize(release.spawnd()).unwrap());
        assert_eq!(
            fs::canonicalize(launch.with_file_name("spawn-worker")).unwrap(),
            fs::canonicalize(release.spawn_worker()).unwrap()
        );
        assert!(
            matches!(provenance_of(&resolved), Provenance::Store { release_id, .. } if release_id == release.id())
        );
        // The pointer is relative, so a moved root still resolves.
        let target = fs::read_link(layout.instance_dir(&alice).join(CURRENT_LINK)).unwrap();
        assert!(target.is_relative(), "{}", target.display());
        // The instance records where its store is.
        assert_eq!(recorded_layout(&alice), Some(layout.clone()));

        // Re-pointing alice touches nothing of bob's.
        select(&layout, &alice, &diagnostics).unwrap();
        assert_eq!(
            selected(&layout, &alice).unwrap().unwrap().id(),
            diagnostics.id()
        );
        assert_eq!(
            selected(&layout, &bob).unwrap().unwrap().id(),
            diagnostics.id()
        );
        assert!(
            release.spawnd().is_file(),
            "the deselected release is untouched"
        );

        clear_selection(&layout, &bob).unwrap();
        assert_eq!(selected(&layout, &bob).unwrap(), None);
        assert!(diagnostics.spawnd().is_file());
    }

    #[cfg(unix)]
    #[test]
    fn the_cli_entry_never_replaces_a_pair_a_daemon_still_starts_from() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::at(temp.path().join("root"));
        let source = temp.path().join("download");
        fs::create_dir_all(&source).unwrap();
        let (spawnd, worker) = fake_pair(&source, "0.1.0+gaaa", &"1".repeat(40), "one");
        let release = publish(
            &layout,
            PublishSource {
                spawnd: &spawnd,
                spawn_worker: &worker,
                source: "install",
            },
        )
        .unwrap();

        // The legacy shared pair, as every host had it.
        fs::create_dir_all(layout.bin_dir()).unwrap();
        let (legacy_daemon, legacy_worker) =
            fake_pair(&layout.bin_dir(), "0.0.9+gold", &"0".repeat(40), "legacy");
        let kept = set_cli_entry(&layout, &release, true).unwrap();
        assert!(!kept.replaced);
        assert!(kept.reason.is_some());
        assert!(is_regular_file(&legacy_daemon) && is_regular_file(&legacy_worker));

        // Nobody launches from it any more: both halves become links.
        let replaced = set_cli_entry(&layout, &release, false).unwrap();
        assert!(replaced.replaced);
        assert!(fs::symlink_metadata(&legacy_daemon)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::canonicalize(&legacy_daemon).unwrap(),
            fs::canonicalize(release.spawnd()).unwrap()
        );
        assert_eq!(
            fs::canonicalize(&legacy_worker).unwrap(),
            fs::canonicalize(release.spawn_worker()).unwrap()
        );
        assert!(fs::read_link(&legacy_daemon).unwrap().is_relative());
        assert_eq!(cli_release(&layout).unwrap().id(), release.id());
        // Once a link, `legacy_in_use` is moot: links follow the newest install.
        let again = set_cli_entry(&layout, &release, true).unwrap();
        assert!(again.replaced);
    }

    #[cfg(unix)]
    #[test]
    fn garbage_collection_keeps_everything_referenced_and_removes_the_rest() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::at(temp.path().join("root"));
        let source = temp.path().join("download");
        fs::create_dir_all(&source).unwrap();
        let mut releases = Vec::new();
        for tag in ["a", "b", "c", "d", "e"] {
            let (spawnd, worker) =
                fake_pair(&source, &format!("0.1.0+g{tag}"), &"1".repeat(40), tag);
            releases.push(
                publish(
                    &layout,
                    PublishSource {
                        spawnd: &spawnd,
                        spawn_worker: &worker,
                        source: "install",
                    },
                )
                .unwrap(),
            );
        }
        // Age every release past the grace period.
        for release in &releases {
            let mut meta = release.meta.clone();
            meta.installed_at_unix_ms = 1;
            fs::write(
                release.dir.join(RELEASE_META),
                serde_json::to_vec(&meta).unwrap(),
            )
            .unwrap();
        }
        let alice = temp.path().join("config").join("alice");
        fs::create_dir_all(&alice).unwrap();
        select(&layout, &alice, &releases[0]).unwrap();
        // A marker names what an update on trial can fall back to.
        fs::write(
            probation_marker_path(&layout, &alice),
            serde_json::json!({"previous_release": releases[1].id(), "attempted_release": releases[2].id()})
                .to_string(),
        )
        .unwrap();
        set_cli_entry(&layout, &releases[3], false).unwrap();
        // A stale staging directory from an installer that died.
        let stale = layout
            .releases_dir()
            .join(format!("{STAGING_PREFIX}999-dead"));
        fs::create_dir_all(&stale).unwrap();
        let old = filetime_seconds_ago(2 * 60 * 60);
        set_mtime(&stale, old);

        let report = collect_garbage(&layout, &[]);
        assert_eq!(report.removed, vec![releases[4].id().to_owned()]);
        let mut kept = report.kept.clone();
        kept.sort();
        let mut expected: Vec<String> = releases[..4].iter().map(|r| r.id().to_owned()).collect();
        expected.sort();
        assert_eq!(kept, expected);
        assert!(!releases[4].dir.exists());
        assert!(!stale.exists());
        // A fresh, unreferenced release survives: another installer may be
        // between publishing it and selecting it.
        let (spawnd, worker) = fake_pair(&source, "0.1.0+gfresh", &"1".repeat(40), "fresh");
        let fresh = publish(
            &layout,
            PublishSource {
                spawnd: &spawnd,
                spawn_worker: &worker,
                source: "install",
            },
        )
        .unwrap();
        let report = collect_garbage(&layout, &[]);
        assert!(report.removed.is_empty());
        assert!(fresh.dir.exists());
    }

    #[cfg(unix)]
    fn filetime_seconds_ago(seconds: u64) -> SystemTime {
        SystemTime::now() - Duration::from_secs(seconds)
    }

    #[cfg(unix)]
    fn set_mtime(path: &Path, when: SystemTime) {
        let file = fs::File::open(path).unwrap();
        file.set_modified(when).unwrap();
    }

    #[test]
    fn swap_rolls_back_when_the_second_rename_fails() {
        let directory = tempfile::tempdir().unwrap();
        let live = directory
            .path()
            .join(crate::platform::executable_name("spawnd"));
        let missing_temporary = crate::platform::executable_variant(&live, "tmp").unwrap();
        fs::write(&live, b"old").unwrap();

        swap_one(&live, &missing_temporary).expect_err("missing replacement must fail");
        assert_eq!(fs::read(&live).unwrap(), b"old");
        assert!(!previous_path(&live).exists());
    }

    #[test]
    fn worker_swap_failure_rolls_back_the_completed_daemon_swap() {
        let directory = tempfile::tempdir().unwrap();
        let daemon = directory
            .path()
            .join(crate::platform::executable_name("spawnd"));
        let daemon_temporary = crate::platform::executable_variant(&daemon, "tmp").unwrap();
        let worker = directory
            .path()
            .join(crate::platform::executable_name("spawn-worker"));
        let missing_worker_temporary = crate::platform::executable_variant(&worker, "tmp").unwrap();
        fs::write(&daemon, b"old daemon").unwrap();
        fs::write(&daemon_temporary, b"new daemon").unwrap();
        fs::write(&worker, b"old worker").unwrap();

        swap_pair(
            &daemon,
            &daemon_temporary,
            &worker,
            &missing_worker_temporary,
        )
        .expect_err("worker replacement must fail");
        assert_eq!(fs::read(&daemon).unwrap(), b"old daemon");
        assert_eq!(fs::read(&daemon_temporary).unwrap(), b"new daemon");
        assert_eq!(fs::read(&worker).unwrap(), b"old worker");
        assert!(!previous_path(&daemon).exists());
        assert!(!previous_path(&worker).exists());
    }

    #[test]
    fn health_revert_restores_both_fake_binaries() {
        let directory = tempfile::tempdir().unwrap();
        let daemon = directory
            .path()
            .join(crate::platform::executable_name("spawnd"));
        let worker = directory
            .path()
            .join(crate::platform::executable_name("spawn-worker"));
        fs::write(&daemon, b"bad daemon").unwrap();
        fs::write(&worker, b"bad worker").unwrap();
        fs::write(previous_path(&daemon), b"old daemon").unwrap();
        fs::write(previous_path(&worker), b"old worker").unwrap();

        revert_pair(&daemon, &worker).unwrap();

        assert_eq!(fs::read(&daemon).unwrap(), b"old daemon");
        assert_eq!(fs::read(&worker).unwrap(), b"old worker");
        assert!(!previous_path(&daemon).exists());
        assert!(!previous_path(&worker).exists());
    }

    #[test]
    fn publish_lines_are_plain_and_say_what_happened_to_the_command() {
        let output = PublishOutput {
            release: "0.1.0+gabc-12345678".into(),
            version: "0.1.0+gabc".into(),
            variant: "release".into(),
            dir: "/home/x/.local/lib/spawn/releases/0.1.0+gabc-12345678".into(),
            cli: "/home/x/.local/bin/spawnd".into(),
            cli_replaced: false,
            cli_note: Some("a daemon on this machine still starts from it".into()),
        };
        let lines = publish_lines(&output);
        assert_eq!(
            lines[0],
            "spawn: published 0.1.0+gabc (release) to /home/x/.local/lib/spawn/releases/0.1.0+gabc-12345678"
        );
        assert!(lines[1].starts_with("spawn: /home/x/.local/bin/spawnd was left as it is: "));
        assert!(lines.iter().all(|line| line.starts_with("spawn: ")));
    }
}
