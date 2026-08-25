//! The version this daemon reports — to `--version`, to the server on
//! register, and to device login.

/// `0.1.0+g<commit>` when the build could read git, plain `0.1.0` otherwise.
/// Composed by build.rs so the commit a binary came from is visible wherever
/// the version shows up.
pub const BUILD_VERSION: &str = env!("SPAWND_BUILD_VERSION");
pub const DAEMON_TREE: &str = env!("SPAWND_DAEMON_TREE");

pub fn build_version() -> String {
    BUILD_VERSION.to_string()
}

/// Git tree identity of daemon/ for this build. Builds made outside a git
/// checkout have no identity and omit it from registration.
pub fn daemon_tree() -> Option<&'static str> {
    (!DAEMON_TREE.is_empty()).then_some(DAEMON_TREE)
}
