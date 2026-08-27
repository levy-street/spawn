use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{
    Dir, DirBuilder, DirBuilderExt as CapDirBuilderExt, OpenOptions as CapOpenOptions,
    OpenOptionsExt as CapOpenOptionsExt, PermissionsExt as CapPermissionsExt,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileIdentity {
    dev: u64,
    ino: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileStamp {
    bytes: Vec<u8>,
}

impl FileStamp {
    pub fn version_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

pub struct RawModeGuard {
    saved: nix::sys::termios::Termios,
}

pub struct VtOutputGuard;

impl Drop for VtOutputGuard {
    fn drop(&mut self) {}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProgramKind {
    Native,
    CmdShim,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedProgram {
    pub path: PathBuf,
    pub kind: ProgramKind,
}

pub fn default_config_base() -> io::Result<PathBuf> {
    dirs::config_dir()
        .map(|path| path.join("spawn"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "cannot resolve user config dir"))
}

pub fn create_private_dir_all(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(0o700).create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

pub fn validate_private_dir(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path is not a real directory",
        ));
    }
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private directory is owned by another user",
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private directory is accessible by group or other users",
        ));
    }
    Ok(())
}

pub fn open_private_dir(path: &Path) -> io::Result<Dir> {
    validate_private_dir(path)?;
    Dir::open_ambient_dir(path, ambient_authority())
}

pub fn open_or_create_private_dir_at(parent: &Dir, name: &Path) -> io::Result<Dir> {
    let mut builder = DirBuilder::new();
    builder.mode(0o700);
    match parent.create_dir_with(name, &builder) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let dir = parent.open_dir_nofollow(name)?;
    // Preserve the existing Unix upload/preview contract: a nofollow-opened
    // private directory is forced back to 0700 on every use.
    dir.set_permissions(Path::new("."), cap_std::fs::Permissions::from_mode(0o700))?;
    Ok(dir)
}

pub fn create_private_file_new(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)?;
    validate_private_file(&file)?;
    Ok(file)
}

pub fn open_private_file(path: &Path, write: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(write)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)?;
    validate_private_file(&file)?;
    Ok(file)
}

pub fn create_private_file_new_at(parent: &Dir, name: &Path) -> io::Result<File> {
    let mut options = CapOpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .follow(FollowSymlinks::No);
    let file = parent.open_with(name, &options)?;
    let file = file.into_std();
    validate_private_file(&file)?;
    Ok(file)
}

pub fn open_private_file_at(parent: &Dir, name: &Path, write: bool) -> io::Result<File> {
    let mut options = CapOpenOptions::new();
    options.read(true).write(write).follow(FollowSymlinks::No);
    let file = parent.open_with(name, &options)?.into_std();
    validate_private_file(&file)?;
    Ok(file)
}

pub fn validate_private_file(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path is not a regular file",
        ));
    }
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private file is owned by another user",
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private file is accessible by group or other users",
        ));
    }
    Ok(())
}

pub fn owned_by_current_user(file: &File) -> io::Result<bool> {
    Ok(file.metadata()?.uid() == rustix::process::geteuid().as_raw())
}

pub fn set_executable(path: &Path) -> io::Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

pub fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        from,
        rustix::fs::CWD,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(io::Error::from)
}

pub fn durable_replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

pub fn rename_noreplace_at(parent: &Dir, from: &Path, to: &Path) -> io::Result<()> {
    let parent = parent.try_clone()?.into_std_file();
    rustix::fs::renameat_with(
        parent.as_fd(),
        from,
        parent.as_fd(),
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(io::Error::from)
}

pub fn hard_link_noreplace_at(
    from_dir: &Dir,
    from: &Path,
    to_dir: &Dir,
    to: &Path,
) -> io::Result<()> {
    from_dir.hard_link(from, to_dir, to)
}

pub fn fsync_dir(dir: &Dir) -> io::Result<()> {
    // cap-std deliberately holds directories with O_PATH on Linux. Duplicating
    // that descriptor preserves O_PATH, and fsync(2) rejects it with EBADF.
    // Reopen the held directory itself as a real read-only directory handle;
    // openat remains anchored to the capability even if the directory is
    // concurrently renamed.
    let sync_handle = rustix::fs::openat(
        dir,
        Path::new("."),
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::DIRECTORY | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )
    .map_err(io::Error::from)?;
    rustix::fs::fsync(sync_handle).map_err(io::Error::from)
}

pub fn file_identity(file: &File) -> io::Result<FileIdentity> {
    let metadata = file.metadata()?;
    Ok(FileIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    })
}

pub fn file_stamp(file: &File) -> io::Result<FileStamp> {
    let metadata = file.metadata()?;
    let mut bytes = Vec::with_capacity(40);
    bytes.extend_from_slice(&metadata.dev().to_le_bytes());
    bytes.extend_from_slice(&metadata.ino().to_le_bytes());
    bytes.extend_from_slice(&metadata.len().to_le_bytes());
    bytes.extend_from_slice(&metadata.mtime().to_le_bytes());
    bytes.extend_from_slice(&metadata.mtime_nsec().to_le_bytes());
    Ok(FileStamp { bytes })
}

pub fn lock_secret(region: &[u8]) -> bool {
    if region.is_empty() {
        return true;
    }
    let result = unsafe { nix::libc::mlock(region.as_ptr().cast(), region.len()) };
    if result != 0 {
        return false;
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    unsafe {
        let _ = nix::libc::madvise(
            region.as_ptr().cast_mut().cast(),
            region.len(),
            nix::libc::MADV_DONTDUMP,
        );
    }
    true
}

pub fn unlock_secret(region: &[u8]) {
    if !region.is_empty() {
        unsafe {
            let _ = nix::libc::munlock(region.as_ptr().cast(), region.len());
        }
    }
}

pub fn enable_raw_mode() -> Option<RawModeGuard> {
    use nix::sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg};
    let stdin = std::io::stdin();
    let saved = tcgetattr(&stdin).ok()?;
    let mut raw = saved.clone();
    cfmakeraw(&mut raw);
    tcsetattr(&stdin, SetArg::TCSANOW, &raw).ok()?;
    Some(RawModeGuard { saved })
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        use nix::sys::termios::{tcsetattr, SetArg};
        let _ = tcsetattr(std::io::stdin(), SetArg::TCSANOW, &self.saved);
    }
}

pub fn enable_vt_output() -> Option<VtOutputGuard> {
    Some(VtOutputGuard)
}

pub fn terminal_size() -> Option<(u16, u16)> {
    let mut size: nix::libc::winsize = unsafe { std::mem::zeroed() };
    let ok =
        unsafe { nix::libc::ioctl(nix::libc::STDOUT_FILENO, nix::libc::TIOCGWINSZ, &mut size) };
    (ok == 0 && size.ws_col > 0 && size.ws_row > 0).then_some((size.ws_col, size.ws_row))
}

pub fn open_url(url: &str) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(not(target_os = "macos"))]
    let mut command = std::process::Command::new("xdg-open");
    let status = command.arg(url).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "browser opener exited with {status}"
        )))
    }
}

pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None) {
        Ok(()) | Err(nix::errno::Errno::EPERM) => true,
        Err(_) => false,
    }
}

pub fn resolve_program(path: &Path) -> Option<ResolvedProgram> {
    let resolve = |candidate: PathBuf| {
        let path = fs::canonicalize(candidate).ok()?;
        path.is_file().then_some(ResolvedProgram {
            path,
            kind: ProgramKind::Native,
        })
    };
    if path.is_absolute() || path.components().count() > 1 {
        return resolve(path.to_path_buf());
    }
    std::env::var_os("PATH").and_then(|search| {
        std::env::split_paths(&search).find_map(|directory| resolve(directory.join(path)))
    })
}

pub fn executable_name(stem: &str) -> OsString {
    let mut name = OsString::from(stem);
    name.push(std::env::consts::EXE_SUFFIX);
    name
}

pub fn executable_variant(live: &Path, tag: &str) -> io::Result<PathBuf> {
    let file_name = live.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "executable path has no file name",
        )
    })?;
    if tag.is_empty() || tag.contains(['/', '\\']) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid executable variant tag",
        ));
    }
    let mut variant = OsString::from(file_name);
    variant.push(".");
    variant.push(OsStr::new(tag));
    Ok(live.with_file_name(variant))
}
