//! Foreground process detection for the session worker.
//!
//! Once per second the worker asks the kernel which process group owns the
//! PTY foreground (`tcgetpgrp` on the master fd) and resolves that group's
//! leader to an executable basename. Deliberately content-free beyond the
//! basename: no arguments, no paths, no output, no titles (docs/TRUST.md) —
//! it exists so the UI can label panes with what is running in them.

use std::os::fd::RawFd;

/// Longest basename the worker reports; anything longer is truncated.
pub const MAX_BASENAME_CHARS: usize = 64;

/// Basename of the executable whose process group currently owns the PTY
/// foreground, or `None` when the kernel or process lookup fails (for
/// example the group leader exited between the two syscalls).
pub fn foreground_basename(master_fd: RawFd) -> Option<String> {
    // The foreground process-group id doubles as the pid of the group leader:
    // shells make each job's leader its own process group.
    let pgid = unsafe { nix::libc::tcgetpgrp(master_fd) };
    if pgid <= 0 {
        return None;
    }
    // Immediately after spawn — before the child session leader has claimed
    // the terminal — the kernel can report the PTY opener itself as the
    // foreground. That is this very worker process (its pid under a
    // production `process_group(0)` launch, its inherited group otherwise);
    // reporting "spawn-worker" would be an artifact, not session state.
    if pgid == unsafe { nix::libc::getpgrp() } || pgid == std::process::id() as nix::libc::pid_t {
        return None;
    }
    let name = process_basename(pgid)?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Some tools install each release as a version-named file — Claude Code
    // runs `~/.local/share/claude/versions/2.1.235` — so the executable name
    // the kernel reports is a version, not a name. Fall back to the directory
    // that holds it, which is what the tool calls itself. Still a bare name:
    // no arguments, no path, and never more than two levels up.
    let resolved = if is_version_name(trimmed) {
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        process_exe_path(pgid)
            .as_deref()
            .and_then(|path| tool_name_from_path(path, home.as_deref()))
            .unwrap_or_else(|| trimmed.to_string())
    } else {
        trimmed.to_string()
    };
    Some(resolved.chars().take(MAX_BASENAME_CHARS).collect())
}

/// A name with no letters in it — "2.1.235", "1.0.0-rc1" — names a release,
/// not a program.
fn is_version_name(name: &str) -> bool {
    !name.is_empty() && !name.chars().any(|c| c.is_alphabetic())
}

/// Directories that hold programs rather than name them.
const GENERIC_DIRS: &[&str] = &[
    "bin",
    "sbin",
    "libexec",
    "lib",
    "lib64",
    "share",
    "local",
    "opt",
    "usr",
    "var",
    "versions",
    "version",
    "releases",
    "current",
    "latest",
    "stable",
    "node_modules",
    "dist",
    "build",
    "target",
    "release",
    "debug",
    "contents",
    "macos",
    "resources",
];

/// How far above a version-named file to look for the tool's own name.
const MAX_ANCESTOR_LEVELS: usize = 2;

/// Home directories, whose names are people rather than programs.
const HOME_PARENTS: &[&str] = &["users", "home"];

/// The nearest ancestor directory that names the tool, e.g. `claude` from
/// `/Users/x/.local/share/claude/versions/2.1.235`. `None` when only generic
/// or version-like directories are within reach: the walk gives up rather
/// than climbing into a home directory, whose name is a username.
fn tool_name_from_path(path: &std::path::Path, home: Option<&std::path::Path>) -> Option<String> {
    for ancestor in path.ancestors().skip(1).take(MAX_ANCESTOR_LEVELS) {
        if home.is_some_and(|home| ancestor == home) {
            return None;
        }
        let parent_name = ancestor
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .map(str::to_ascii_lowercase);
        if parent_name.is_some_and(|name| HOME_PARENTS.contains(&name.as_str())) {
            return None;
        }
        let Some(name) = ancestor.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let candidate = name.trim().trim_start_matches('.');
        if candidate.is_empty() || is_version_name(candidate) {
            continue;
        }
        if GENERIC_DIRS.contains(&candidate.to_ascii_lowercase().as_str()) {
            continue;
        }
        return Some(candidate.to_string());
    }
    None
}

/// Kernel-maintained executable basename (`/proc/<pid>/comm`, truncated by
/// the kernel to 15 bytes).
#[cfg(target_os = "linux")]
fn process_basename(pid: nix::libc::pid_t) -> Option<String> {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    Some(comm.trim_end_matches('\n').to_string())
}

/// Executable path, read only to name a version-named file after its
/// directory; never reported as a path.
#[cfg(target_os = "linux")]
fn process_exe_path(pid: nix::libc::pid_t) -> Option<std::path::PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(target_os = "macos")]
fn process_basename(pid: nix::libc::pid_t) -> Option<String> {
    libproc_name(pid).or_else(|| libproc_path_basename(pid))
}

// libproc (libSystem) syscall wrappers. Declared here rather than pulling in
// a crate: both live in libSystem, so plain externs link with no extra flags.
#[cfg(target_os = "macos")]
extern "C" {
    fn proc_name(
        pid: nix::libc::c_int,
        buffer: *mut nix::libc::c_void,
        buffersize: u32,
    ) -> nix::libc::c_int;
    fn proc_pidpath(
        pid: nix::libc::c_int,
        buffer: *mut nix::libc::c_void,
        buffersize: u32,
    ) -> nix::libc::c_int;
}

/// `proc_name`: the executable basename, not truncated at the kernel's
/// 16-byte `p_comm` width.
#[cfg(target_os = "macos")]
fn libproc_name(pid: nix::libc::pid_t) -> Option<String> {
    let mut buf = [0u8; 128];
    let len = unsafe { proc_name(pid as _, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if len <= 0 {
        return None;
    }
    std::str::from_utf8(&buf[..len as usize])
        .ok()
        .map(str::to_owned)
}

/// `proc_pidpath`: the full executable path, read only to name the process;
/// callers reduce it to a single name before it leaves this module.
#[cfg(target_os = "macos")]
fn process_exe_path(pid: nix::libc::pid_t) -> Option<std::path::PathBuf> {
    let mut buf = [0u8; 4096];
    let len = unsafe { proc_pidpath(pid as _, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if len <= 0 {
        return None;
    }
    let path = std::str::from_utf8(&buf[..len as usize]).ok()?;
    Some(std::path::PathBuf::from(path))
}

/// Path fallback for when `proc_name` has nothing to say.
#[cfg(target_os = "macos")]
fn libproc_path_basename(pid: nix::libc::pid_t) -> Option<String> {
    process_exe_path(pid)?
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_basename(_pid: nix::libc::pid_t) -> Option<String> {
    None
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_exe_path(_pid: nix::libc::pid_t) -> Option<std::path::PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_a_live_pid_to_a_nonempty_basename() {
        let name = process_basename(std::process::id() as nix::libc::pid_t)
            .expect("own pid must resolve");
        assert!(!name.trim().is_empty());
    }

    #[test]
    fn version_named_files_are_named_after_their_directory() {
        // Claude Code's real layout: every release is a version-named file.
        assert_eq!(
            tool_name_from_path(
                std::path::Path::new("/Users/x/.local/share/claude/versions/2.1.235"),
                Some(std::path::Path::new("/Users/x")),
            )
            .as_deref(),
            Some("claude")
        );
        // A dot-directory names the tool just as well.
        assert_eq!(
            tool_name_from_path(
                std::path::Path::new("/Users/x/.codex/bin/0.9.1"),
                Some(std::path::Path::new("/Users/x")),
            )
            .as_deref(),
            Some("codex")
        );
    }

    #[test]
    fn the_walk_stops_before_it_reaches_a_home_directory() {
        // Two levels up is all it looks: a username is never a program name.
        assert_eq!(
            tool_name_from_path(
                std::path::Path::new("/Users/x/bin/1.2.3"),
                Some(std::path::Path::new("/Users/x"))
            ),
            None
        );
        // Even with no HOME to compare against, a home directory is off limits.
        assert_eq!(
            tool_name_from_path(std::path::Path::new("/home/deploy/bin/1.2.3"), None),
            None
        );
    }

    #[test]
    fn only_letterless_names_look_like_versions() {
        assert!(is_version_name("2.1.235"));
        assert!(is_version_name("1.0.0-4"));
        assert!(!is_version_name("claude"));
        assert!(!is_version_name("v2.1.235"));
        assert!(!is_version_name(""));
    }

    #[test]
    fn a_dead_pid_and_a_bad_fd_resolve_to_none() {
        // pid_t::MAX is never a live pid.
        assert!(process_basename(nix::libc::pid_t::MAX).is_none());
        assert!(foreground_basename(-1).is_none());
    }
}
