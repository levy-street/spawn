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
}
