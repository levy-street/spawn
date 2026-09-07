//! The version this daemon reports — to `--version`, to the server on
//! register, and to device login.

/// `0.1.0+g<commit>` when the build could read git, plain `0.1.0` otherwise.
/// Composed by build.rs so the commit a binary came from is visible wherever
/// the version shows up.
pub const BUILD_VERSION: &str = env!("SPAWND_BUILD_VERSION");
pub const DAEMON_TREE: &str = env!("SPAWND_DAEMON_TREE");
pub const BUILD_COUNTER_RAW: &str = env!("SPAWND_BUILD_COUNTER");
/// True for the diagnostics variant (`--features diagnostics`): debug logging
/// by default and a `.diagnostics` build-metadata segment in the version.
pub const DIAGNOSTICS_BUILD: bool = cfg!(feature = "diagnostics");

pub fn build_version() -> String {
    BUILD_VERSION.to_string()
}

/// Git tree identity of daemon/ for this build. Builds made outside a git
/// checkout have no identity and omit it from registration.
pub fn daemon_tree() -> Option<&'static str> {
    (!DAEMON_TREE.is_empty()).then_some(DAEMON_TREE)
}

/// Monotonic release counter stamped from the source commit timestamp. Builds
/// made outside git have no counter and therefore no local downgrade floor.
pub fn build_counter() -> Option<u64> {
    BUILD_COUNTER_RAW.parse().ok()
}

/// Stable, machine-readable identity emitted by `spawn-worker --version`.
pub fn worker_identity_line() -> String {
    format!("spawn-worker {BUILD_VERSION} tree={DAEMON_TREE}")
}
