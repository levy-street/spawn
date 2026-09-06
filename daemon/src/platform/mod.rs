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
/// open files before and after, the hard ceiling it may not exceed (`None`
/// when the platform reports no ceiling), and whether the platform refused
/// the ask — a kernel maximum below the target, which is not the hard
/// limit — so the caller can say why `after` is short of what it wanted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenFileLimit {
    pub before: u64,
    pub after: u64,
    pub maximum: Option<u64>,
    pub refused: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_open_file_limit_rises_to_the_target_and_never_falls() {
        use rustix::process::{getrlimit, setrlimit, Resource, Rlimit};
        let current = getrlimit(Resource::Nofile);
        let soft = current.current.unwrap_or(u64::MAX);
        let hard = current.maximum.unwrap_or(u64::MAX);
        // Asking for less than we already have changes nothing.
        let unchanged = super::raise_open_file_limit(soft.saturating_sub(1)).unwrap();
        assert_eq!((unchanged.before, unchanged.after), (soft, soft));
        // Lower our own soft limit a little, then prove the raise brings it
        // back: this way the setrlimit path runs on every host, including
        // one whose soft limit already equals its hard limit. The margin is
        // small enough that the other tests in this process never notice.
        let lowered = soft.saturating_sub(64);
        setrlimit(
            Resource::Nofile,
            Rlimit {
                current: Some(lowered),
                maximum: current.maximum,
            },
        )
        .unwrap();
        let raised = super::raise_open_file_limit(soft.min(hard)).unwrap();
        assert_eq!((raised.before, raised.after), (lowered, soft), "{raised:?}");
        assert!(!raised.refused, "{raised:?}");
        assert_eq!(
            getrlimit(Resource::Nofile).current.unwrap_or(u64::MAX),
            soft
        );
        // Asking for more than the hard limit allows raises to the hard
        // limit and reports it as the ceiling, not as a refusal.
        let capped = super::raise_open_file_limit(hard.saturating_add(1)).unwrap();
        assert_eq!(capped.after, hard.max(soft).min(hard), "{capped:?}");
        assert!(!capped.refused, "{capped:?}");
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
