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

/// What became of an offer to press Enter.
///
/// `Unavailable` is not the same as "nobody pressed it": it means this process
/// cannot watch the terminal at all, so a screen that says "Press Enter" is
/// making a promise it cannot keep and has to say so instead of waiting
/// silently for ever.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnterWait {
    /// Someone pressed Enter.
    Pressed,
    /// The wait was stood down because the thing it offered already happened.
    Retired,
    /// Stdin cannot be watched here.
    Unavailable,
}

#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

#[cfg(test)]
mod tests {
    use super::*;
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
