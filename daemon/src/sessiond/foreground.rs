//! Foreground process detection for the session worker.
//!
//! Once per second the worker asks the kernel which process group owns the
//! PTY foreground (`tcgetpgrp` on the master fd) and resolves that group's
//! leader to an executable basename. Deliberately content-free beyond the
//! basename: no arguments, no paths, no output, no titles (docs/TRUST.md) —
//! it exists so the UI can label panes with what is running in them.

#[cfg(unix)]
use std::os::fd::RawFd;

/// Longest basename the worker reports; anything longer is truncated.
pub const MAX_BASENAME_CHARS: usize = 64;

/// Basename of the executable whose process group currently owns the PTY
/// foreground, or `None` when the kernel or process lookup fails (for
/// example the group leader exited between the two syscalls).
#[cfg(unix)]
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

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process_basename(_pid: nix::libc::pid_t) -> Option<String> {
    None
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process_exe_path(_pid: nix::libc::pid_t) -> Option<std::path::PathBuf> {
    None
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone)]
struct ProcessNode {
    pid: u32,
    parent_pid: u32,
    basename: String,
    created_100ns: Option<u64>,
    image_path: Option<std::path::PathBuf>,
}

#[cfg(any(windows, test))]
fn descendant_depth(
    pid: u32,
    root_pid: u32,
    by_pid: &std::collections::HashMap<u32, &ProcessNode>,
) -> Option<usize> {
    if pid == root_pid {
        return Some(0);
    }
    let mut current = pid;
    let mut depth = 0_usize;
    let mut visited = std::collections::HashSet::new();
    while visited.insert(current) {
        let node = by_pid.get(&current)?;
        depth += 1;
        if node.parent_pid == root_pid {
            return Some(depth);
        }
        if node.parent_pid == 0 || node.parent_pid == current {
            return None;
        }
        current = node.parent_pid;
    }
    None
}

#[cfg(any(windows, test))]
fn ignored_windows_process(node: &ProcessNode, worker_pid: u32) -> bool {
    if node.pid == worker_pid {
        return true;
    }
    matches!(
        node.basename.to_ascii_lowercase().as_str(),
        "spawn-worker" | "spawn-worker.exe" | "conhost.exe" | "openconsole.exe"
    )
}

#[cfg(any(windows, test))]
fn select_windows_foreground<'a>(
    root_pid: u32,
    worker_pid: u32,
    nodes: &'a [ProcessNode],
) -> Option<&'a ProcessNode> {
    let by_pid = nodes
        .iter()
        .map(|node| (node.pid, node))
        .collect::<std::collections::HashMap<_, _>>();
    let root = by_pid.get(&root_pid).copied()?;
    nodes
        .iter()
        .filter(|node| node.pid != root_pid && !ignored_windows_process(node, worker_pid))
        .filter_map(|node| {
            let depth = descendant_depth(node.pid, root_pid, &by_pid)?;
            let created = node.created_100ns?;
            Some((depth, created, node.pid, node))
        })
        .max_by_key(|(depth, created, pid, _)| (*depth, *created, *pid))
        .map_or(Some(root), |(_, _, _, node)| Some(node))
}

#[cfg(any(windows, test))]
fn reported_name(node: &ProcessNode, home: Option<&std::path::Path>) -> Option<String> {
    let trimmed = node.basename.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_suffix = trimmed
        .strip_suffix(".exe")
        .or_else(|| trimmed.strip_suffix(".EXE"))
        .unwrap_or(trimmed);
    let resolved = if is_version_name(without_suffix) {
        node.image_path
            .as_deref()
            .and_then(|path| tool_name_from_path(path, home))
            .unwrap_or_else(|| without_suffix.to_owned())
    } else {
        without_suffix.to_owned()
    };
    (!resolved.is_empty()).then(|| resolved.chars().take(MAX_BASENAME_CHARS).collect())
}

/// Best-effort Windows foreground label. ConPTY has no foreground-process API,
/// so this chooses the deepest descendant of the retained root shell, then the
/// newest creation time and PID. It is advisory and never lifecycle authority.
#[cfg(windows)]
pub fn foreground_basename(root_shell_pid: u32) -> Option<String> {
    let nodes = snapshot_windows_processes()?;
    let selected = select_windows_foreground(root_shell_pid, std::process::id(), &nodes)?;
    reported_name(selected, dirs::home_dir().as_deref())
}

#[cfg(windows)]
fn snapshot_windows_processes() -> Option<Vec<ProcessNode>> {
    use std::mem::size_of;

    use windows_sys::Win32::Foundation::{
        CloseHandle, FILETIME, INVALID_HANDLE_VALUE, STILL_ACTIVE, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
        WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    struct Snapshot(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for Snapshot {
        fn drop(&mut self) {
            // SAFETY: this wrapper uniquely owns the snapshot handle.
            unsafe { CloseHandle(self.0) };
        }
    }
    // SAFETY: flags and pid are the documented process-snapshot request.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let snapshot = Snapshot(snapshot);
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: entry has the documented size and writable lifetime.
    if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
        return None;
    }
    let mut nodes = Vec::new();
    loop {
        let end = entry
            .szExeFile
            .iter()
            .position(|code_unit| *code_unit == 0)
            .unwrap_or(entry.szExeFile.len());
        let basename = String::from_utf16_lossy(&entry.szExeFile[..end]);
        let pid = entry.th32ProcessID;
        let parent_pid = entry.th32ParentProcessID;
        let mut created_100ns = None;
        let mut image_path = None;
        // SAFETY: OpenProcess returns an owned handle or null. Candidates are
        // query-only and never controlled by this heuristic.
        let process =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
        if !process.is_null() {
            struct Process(windows_sys::Win32::Foundation::HANDLE);
            impl Drop for Process {
                fn drop(&mut self) {
                    // SAFETY: this wrapper uniquely owns the process handle.
                    unsafe { CloseHandle(self.0) };
                }
            }
            let process = Process(process);
            let mut exit_code = 0_u32;
            // SAFETY: process and output slots remain live for each call.
            let live = unsafe { WaitForSingleObject(process.0, 0) } == WAIT_TIMEOUT
                && unsafe { GetExitCodeProcess(process.0, &mut exit_code) } != 0
                && exit_code == STILL_ACTIVE as u32;
            if live {
                let mut created = FILETIME {
                    dwLowDateTime: 0,
                    dwHighDateTime: 0,
                };
                let mut exited = created;
                let mut kernel = created;
                let mut user = created;
                if unsafe {
                    GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user)
                } != 0
                {
                    created_100ns = Some(
                        (u64::from(created.dwHighDateTime) << 32)
                            | u64::from(created.dwLowDateTime),
                    );
                }
                let basename_without_suffix = basename
                    .strip_suffix(".exe")
                    .or_else(|| basename.strip_suffix(".EXE"))
                    .unwrap_or(&basename);
                if is_version_name(basename_without_suffix) {
                    let mut path = vec![0_u16; 32_768];
                    let mut length = path.len() as u32;
                    if unsafe {
                        QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut length)
                    } != 0
                    {
                        path.truncate(length as usize);
                        image_path = String::from_utf16(&path).ok().map(std::path::PathBuf::from);
                    }
                }
            }
        }
        if created_100ns.is_some() {
            nodes.push(ProcessNode {
                pid,
                parent_pid,
                basename,
                created_100ns,
                image_path,
            });
        }
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        // SAFETY: entry remains correctly sized and writable.
        if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
            break;
        }
    }
    Some(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn resolves_a_live_pid_to_a_nonempty_basename() {
        let name =
            process_basename(std::process::id() as nix::libc::pid_t).expect("own pid must resolve");
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

    #[cfg(unix)]
    #[test]
    fn a_dead_pid_and_a_bad_fd_resolve_to_none() {
        // pid_t::MAX is never a live pid.
        assert!(process_basename(nix::libc::pid_t::MAX).is_none());
        assert!(foreground_basename(-1).is_none());
    }

    #[test]
    fn windows_graph_prefers_depth_then_creation_then_pid() {
        let nodes = vec![
            ProcessNode {
                pid: 10,
                parent_pid: 1,
                basename: "pwsh.exe".into(),
                created_100ns: Some(1),
                image_path: None,
            },
            ProcessNode {
                pid: 20,
                parent_pid: 10,
                basename: "node.exe".into(),
                created_100ns: Some(5),
                image_path: None,
            },
            ProcessNode {
                pid: 30,
                parent_pid: 20,
                basename: "claude.exe".into(),
                created_100ns: Some(2),
                image_path: None,
            },
            ProcessNode {
                pid: 31,
                parent_pid: 20,
                basename: "codex.exe".into(),
                created_100ns: Some(2),
                image_path: None,
            },
        ];
        let selected = select_windows_foreground(10, 99, &nodes).unwrap();
        assert_eq!(selected.pid, 31);
        assert_eq!(reported_name(selected, None).as_deref(), Some("codex"));
    }

    #[test]
    fn windows_graph_ignores_helpers_cycles_and_unreachable_processes() {
        let nodes = vec![
            ProcessNode {
                pid: 10,
                parent_pid: 1,
                basename: "pwsh.exe".into(),
                created_100ns: Some(1),
                image_path: None,
            },
            ProcessNode {
                pid: 11,
                parent_pid: 10,
                basename: "conhost.exe".into(),
                created_100ns: Some(9),
                image_path: None,
            },
            ProcessNode {
                pid: 40,
                parent_pid: 41,
                basename: "cycle-a.exe".into(),
                created_100ns: Some(99),
                image_path: None,
            },
            ProcessNode {
                pid: 41,
                parent_pid: 40,
                basename: "cycle-b.exe".into(),
                created_100ns: Some(100),
                image_path: None,
            },
        ];
        let selected = select_windows_foreground(10, 99, &nodes).unwrap();
        assert_eq!(selected.pid, 10);
        assert_eq!(reported_name(selected, None).as_deref(), Some("pwsh"));
    }

    #[test]
    fn windows_version_named_executable_uses_tool_directory_and_truncates() {
        let node = ProcessNode {
            pid: 20,
            parent_pid: 10,
            basename: "2.1.235.exe".into(),
            created_100ns: Some(2),
            image_path: Some(std::path::PathBuf::from(
                "C:/Users/x/.local/share/claude/versions/2.1.235.exe",
            )),
        };
        assert_eq!(reported_name(&node, None).as_deref(), Some("claude"));
        let long = ProcessNode {
            basename: format!("{}.exe", "x".repeat(100)),
            ..node
        };
        assert_eq!(reported_name(&long, None).unwrap().chars().count(), 64);
    }
}
