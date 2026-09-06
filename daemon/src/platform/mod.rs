//! Operating-system leaf operations.
//!
//! Filesystem security, atomic publication, terminal modes, browser launch,
//! process polling, and executable naming live here so feature modules do not
//! grow their own subtly different platform branches.

#![allow(dead_code)] // The shared surface is consumed incrementally by both binaries.

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

/// What [`raise_open_file_limit`] found and left behind: the soft limit on
/// open files before and after, and the hard ceiling it may not exceed
/// (`None` when the platform reports no ceiling).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenFileLimit {
    pub before: u64,
    pub after: u64,
    pub maximum: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_open_file_limit_rises_to_the_target_and_never_falls() {
        use rustix::process::{getrlimit, Resource};
        let current = getrlimit(Resource::Nofile);
        let soft = current.current.unwrap_or(u64::MAX);
        let hard = current.maximum.unwrap_or(u64::MAX);
        // Asking for less than we already have changes nothing.
        let unchanged = super::raise_open_file_limit(soft.saturating_sub(1)).unwrap();
        assert_eq!((unchanged.before, unchanged.after), (soft, soft));
        // Asking for more raises to the target, or to the hard limit if that
        // is lower, and reports both.
        let target = soft.saturating_add(64).min(hard);
        let raised = super::raise_open_file_limit(target).unwrap();
        assert_eq!(raised.after, target.max(soft), "{raised:?}");
        assert!(raised.after >= raised.before, "{raised:?}");
        assert_eq!(
            getrlimit(Resource::Nofile).current.unwrap_or(u64::MAX),
            raised.after
        );
    }

    use std::path::Path;

    #[test]
    fn executable_names_use_the_target_suffix() {
        assert_eq!(
            executable_name("spawnd"),
            std::ffi::OsString::from(format!("spawnd{}", std::env::consts::EXE_SUFFIX))
        );
        assert_eq!(
            executable_name("spawn-worker"),
            std::ffi::OsString::from(format!("spawn-worker{}", std::env::consts::EXE_SUFFIX))
        );
    }

    #[test]
    fn executable_variant_inserts_tag_before_suffix() {
        let live = Path::new(if cfg!(windows) {
            "C:\\spawn\\spawnd.exe"
        } else {
            "/opt/spawn/spawnd"
        });
        let expected = if cfg!(windows) {
            Path::new("C:\\spawn\\spawnd.prev.exe")
        } else {
            Path::new("/opt/spawn/spawnd.prev")
        };
        assert_eq!(executable_variant(live, "prev").unwrap(), expected);
    }

    #[cfg(unix)]
    #[test]
    fn directory_sync_accepts_a_capability_directory_handle() {
        let temporary = tempfile::tempdir().unwrap();
        create_private_dir_all(temporary.path()).unwrap();
        let directory = open_private_dir(temporary.path()).unwrap();

        fsync_dir(&directory).unwrap();
    }
}
