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
    Some(trimmed.chars().take(MAX_BASENAME_CHARS).collect())
}

/// Kernel-maintained executable basename (`/proc/<pid>/comm`, truncated by
/// the kernel to 15 bytes).
#[cfg(target_os = "linux")]
fn process_basename(pid: nix::libc::pid_t) -> Option<String> {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    Some(comm.trim_end_matches('\n').to_string())
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

/// `proc_pidpath` fallback: the full executable path, reduced to its file
/// name before it leaves this module.
#[cfg(target_os = "macos")]
fn libproc_path_basename(pid: nix::libc::pid_t) -> Option<String> {
    let mut buf = [0u8; 4096];
    let len = unsafe { proc_pidpath(pid as _, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if len <= 0 {
        return None;
    }
    let path = std::str::from_utf8(&buf[..len as usize]).ok()?;
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_basename(_pid: nix::libc::pid_t) -> Option<String> {
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
    fn a_dead_pid_and_a_bad_fd_resolve_to_none() {
        // pid_t::MAX is never a live pid.
        assert!(process_basename(nix::libc::pid_t::MAX).is_none());
        assert!(foreground_basename(-1).is_none());
    }
}
