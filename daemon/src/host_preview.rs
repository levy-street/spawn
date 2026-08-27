//! Host-rendered previews.
//!
//! Formats no browser can draw — Office documents, Keynote, Photoshop, Sketch,
//! anything with a third-party generator installed — are rendered by QuickLook
//! on the host and returned as a PNG.
//!
//! Two decisions dominate this module.
//!
//! **The renderer runs out of process.** QuickLook generators are arbitrary
//! third-party binaries parsing attacker-influenceable documents. Calling the
//! framework in-process would make every memory-safety bug in every installed
//! generator a bug in a daemon that holds the host's identity key; spawning
//! `qlmanage` instead makes a crash cost one failed preview. That is a security
//! property, not a performance trade.
//!
//! **The renderer is never told the real path.** It cannot be: reconstructing a
//! path from validated components produces a string the kernel never resolved,
//! and a component swapped for a symlink in between would redirect the open.
//! Instead the validated inode is hard-linked into a daemon-private staging
//! directory under a name the daemon chose, and the link is verified to point
//! at the same inode before anything is spawned. No part of a client-supplied
//! path ever reaches another process.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::host_files::{FsError, FsResult, HostFileOperations, HostFileService, PreviewSource};

/// Render sizes the daemon accepts. An allowlist, not a clamp: a free integer
/// lets a caller ask a generator for a 16384px render and allocate a gigabyte.
pub(crate) const PREVIEW_PIXEL_SIZES: [u32; 4] = [128, 256, 512, 1024];
/// Largest PNG we will read back and stream.
pub(crate) const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;
/// Concurrent renders. Deliberately small and separate from the file-service
/// long-task budget.
pub(crate) const PREVIEW_RENDER_PERMITS: usize = 2;

pub(crate) struct PreviewImage {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub content_type: &'static str,
    pub source_content_type: &'static str,
    pub version: String,
    pub path: String,
    pub name: String,
}

/// Indirection so tests can drive the whole staging and cleanup path without a
/// window server.
pub(crate) trait PreviewRenderer: Send + Sync + 'static {
    /// Render `source` into `out_dir`, returning the file that was produced.
    fn render(&self, source: &Path, out_dir: &Path, max_pixels: u32) -> FsResult<PathBuf>;
}

pub(crate) fn is_supported_size(max_pixels: u32) -> bool {
    PREVIEW_PIXEL_SIZES.contains(&max_pixels)
}

/// Width and height straight out of a PNG's `IHDR`, which is always the first
/// chunk. Eight bytes of parsing beats a decoding dependency.
pub(crate) fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    if &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Some((width, height))
}

/// A filename in the staging directory that unlinks itself when dropped.
struct StagedFile {
    dir: Arc<cap_std::fs::Dir>,
    name: String,
    display: PathBuf,
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        let _ = self.dir.remove_file(&self.name);
    }
}

pub(crate) struct PreviewService {
    stage: Arc<cap_std::fs::Dir>,
    stage_display: PathBuf,
    out: Arc<cap_std::fs::Dir>,
    out_display: PathBuf,
    renders: Arc<tokio::sync::Semaphore>,
    renderer: Arc<dyn PreviewRenderer>,
}

impl PreviewService {
    /// Create the staging area.
    ///
    /// This is the second and last consumption of ambient authority in the
    /// daemon. It is safe in a way the home root is not: the client can never
    /// name this directory, never list it, and never remove anything from it,
    /// because it lives outside the capability root entirely.
    pub(crate) fn new(renderer: Arc<dyn PreviewRenderer>) -> FsResult<Self> {
        let base = std::env::temp_dir().join(format!("spawn-preview-{}", uuid::Uuid::new_v4()));
        let stage_display = base.join("in");
        let out_display = base.join("out");
        create_private_dir(&base)?;
        create_private_dir(&stage_display)?;
        create_private_dir(&out_display)?;
        let stage = open_private_dir(&stage_display)?;
        let out = open_private_dir(&out_display)?;
        Ok(Self {
            stage: Arc::new(stage),
            stage_display,
            out: Arc::new(out),
            out_display,
            renders: Arc::new(tokio::sync::Semaphore::new(PREVIEW_RENDER_PERMITS)),
            renderer,
        })
    }

    pub(crate) async fn render(
        &self,
        files: &HostFileService,
        path: &str,
        max_pixels: u32,
        if_version: Option<String>,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<PreviewImage> {
        if !is_supported_size(max_pixels) {
            return Err(FsError::new("invalid_request", "unsupported preview size"));
        }
        // Taken before any file-service permit. The other order lets queued
        // previews hold every long-task permit while waiting on this much
        // narrower semaphore, starving reads and writes completely.
        let _permit = self
            .renders
            .clone()
            .try_acquire_owned()
            .map_err(|_| FsError::new("too_many_tasks", "too many previews in flight"))?;

        let source = files
            .open_preview_source_in_session(path, if_version, operations)
            .await?;
        let classification = crate::host_mime::classify(&source.name, &source.head);

        let staged = self.stage_source(&source)?;
        let renderer = Arc::clone(&self.renderer);
        let staged_display = staged.display.clone();
        let out_display = self.out_display.clone();
        // The renderer spawns a process and waits on it, so it must not run on
        // a runtime worker.
        let rendered = tokio::task::spawn_blocking(move || {
            renderer.render(&staged_display, &out_display, max_pixels)
        })
        .await
        .map_err(|_| FsError::new("io_error", "the preview task did not finish"))??;
        let bytes = self.read_output(&rendered)?;
        drop(staged);

        let (width, height) = png_dimensions(&bytes).unwrap_or((0, 0));
        Ok(PreviewImage {
            bytes,
            width,
            height,
            content_type: "image/png",
            source_content_type: classification.content_type,
            version: source.version.clone(),
            path: source.display.clone(),
            name: source.leaf.clone(),
        })
    }

    /// Give the validated inode a second name somewhere a renderer can reach.
    ///
    /// `linkat` is exclusive, so a squatter cannot pre-create the target name.
    /// It also links a symlink *as a symlink* rather than following it, which is
    /// exactly why the result is stat'd afterwards and required to be the same
    /// regular file we opened.
    fn stage_source(&self, source: &PreviewSource) -> FsResult<StagedFile> {
        let extension = sanitized_extension(&source.leaf);
        let name = match extension {
            Some(ext) => format!("{}.{}", uuid::Uuid::new_v4(), ext),
            None => uuid::Uuid::new_v4().to_string(),
        };
        let display = self.stage_display.join(&name);
        let staged = StagedFile {
            dir: Arc::clone(&self.stage),
            name: name.clone(),
            display,
        };

        let linked = crate::platform::hard_link_noreplace_at(
            &source.parent,
            Path::new(&source.name),
            &self.stage,
            Path::new(&name),
        );

        match linked {
            Ok(()) => {
                let mut options = cap_std::fs::OpenOptions::new();
                use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
                options.read(true).follow(FollowSymlinks::No);
                let staged_file = self
                    .stage
                    .open_with(&name, &options)
                    .map(cap_std::fs::File::into_std)
                    .map_err(|_| FsError::new("io_error", "could not verify the staged file"))?;
                let metadata = staged_file.metadata()?;
                let identity = crate::platform::file_identity(&staged_file)?;
                if !metadata.is_file() || identity != source.identity {
                    // The name we just created does not refer to the inode we
                    // validated. Drop unlinks it; nothing is rendered.
                    return Err(FsError::new(
                        "symlink_rejected",
                        "the staged file did not match the requested file",
                    ));
                }
                Ok(staged)
            }
            // Different filesystem, or a filesystem without links. Copy from
            // the descriptor we already hold, never by re-resolving a path.
            Err(_) => {
                self.copy_source(source, &name)?;
                Ok(staged)
            }
        }
    }

    fn copy_source(&self, source: &PreviewSource, name: &str) -> FsResult<()> {
        use std::io::{Read, Seek, SeekFrom, Write};

        let mut reader = source
            .file
            .try_clone()
            .map_err(|_| FsError::new("io_error", "could not stage the file"))?;
        reader.seek(SeekFrom::Start(0))?;
        let mut writer = crate::platform::create_private_file_new_at(&self.stage, Path::new(name))
            .map_err(|_| FsError::new("io_error", "could not stage the file"))?;
        let mut bounded = reader.take(crate::host_files::PREVIEW_MAX_INPUT_BYTES);
        let copied = std::io::copy(&mut bounded, &mut writer)?;
        if copied != source.size {
            return Err(FsError::new("file_changed", "file changed while staging"));
        }
        writer.flush()?;
        Ok(())
    }

    fn read_output(&self, rendered: &Path) -> FsResult<Vec<u8>> {
        use std::io::Read;

        let name = rendered
            .file_name()
            .ok_or_else(|| FsError::new("preview_unavailable", "renderer produced nothing"))?;
        let mut file = self
            .out
            .open(name)
            .map_err(|_| FsError::new("preview_unavailable", "renderer produced nothing"))?;
        let mut bytes = Vec::new();
        file.by_ref()
            .take(MAX_PREVIEW_BYTES + 1)
            .read_to_end(&mut bytes)?;
        let _ = self.out.remove_file(name);
        if bytes.len() as u64 > MAX_PREVIEW_BYTES {
            return Err(FsError::new(
                "preview_too_large",
                "rendered preview exceeded the size limit",
            ));
        }
        if bytes.is_empty() {
            return Err(FsError::new(
                "preview_unavailable",
                "renderer produced nothing",
            ));
        }
        Ok(bytes)
    }
}

/// QuickLook, out of process.
#[cfg(target_os = "macos")]
pub(crate) struct QlmanageRenderer;

#[cfg(target_os = "macos")]
impl PreviewRenderer for QlmanageRenderer {
    fn render(&self, source: &Path, out_dir: &Path, max_pixels: u32) -> FsResult<PathBuf> {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        /// Absolute, never a `PATH` lookup.
        const QLMANAGE: &str = "/usr/bin/qlmanage";
        // Generous, because the first render of a session pays for QuickLook's
        // agents starting up — often several seconds on a cold machine — and a
        // timeout there would make the feature look broken exactly once per
        // login, which is the worst possible time.
        const RENDER_TIMEOUT: Duration = Duration::from_secs(20);

        let mut command = Command::new(QLMANAGE);
        command
            .arg("-t")
            .arg("-s")
            .arg(max_pixels.to_string())
            .arg("-o")
            .arg(out_dir)
            .arg(source);
        // Piping would risk deadlocking on a full pipe while we poll for exit,
        // and the output is only ever chatter — the produced file is the signal.
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.env_clear();
        for key in ["HOME", "PATH", "TMPDIR", "USER", "LANG"] {
            if let Ok(value) = std::env::var(key) {
                command.env(key, value);
            }
        }
        // Its own process group, because `qlmanage` starts helper agents that
        // outlive it. Killing just the child would leave them running.
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = command
            .spawn()
            .map_err(|_| FsError::new("preview_unsupported", "no renderer on this host"))?;
        let group = child.id() as i32;
        let deadline = Instant::now() + RENDER_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(_) => break,
            }
            if Instant::now() >= deadline {
                // SAFETY: `group` is this child's own session, created above.
                unsafe {
                    nix::libc::killpg(group, nix::libc::SIGKILL);
                }
                let _ = child.wait();
                return Err(FsError::new(
                    "preview_timeout",
                    "the host took too long to render this file",
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }

        // `qlmanage` exits 0 having produced nothing all the time — for any
        // type without a generator installed. The output file is the only
        // reliable success signal, so the exit status is deliberately ignored.
        let leaf = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let expected = out_dir.join(format!("{leaf}.png"));
        if expected.is_file() {
            return Ok(expected);
        }
        Err(FsError::new(
            "preview_unavailable",
            "this host has no preview generator for that file type",
        ))
    }
}

/// Only `[a-z0-9]`, at most 16 characters. QuickLook selects a generator by
/// extension, so the staged name needs one — but nothing else about the
/// client's filename may survive into a path handed to another process.
fn sanitized_extension(name: &str) -> Option<String> {
    let extension = Path::new(name)
        .extension()?
        .to_string_lossy()
        .to_lowercase();
    if extension.is_empty() || extension.len() > 16 {
        return None;
    }
    if !extension.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(extension)
}

fn create_private_dir(path: &Path) -> FsResult<()> {
    crate::platform::create_private_dir_all(path)
        .map_err(|_| FsError::new("io_error", "could not create the preview staging directory"))
}

/// Open the staging directory and prove it is ours before trusting it.
fn open_private_dir(path: &Path) -> FsResult<cap_std::fs::Dir> {
    crate::platform::open_private_dir(path)
        .map_err(|_| FsError::new("io_error", "could not open the preview staging directory"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_HEADER: &[u8] =
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x01\x00\x00\x00\x00\xC0";

    #[test]
    fn png_dimensions_are_read_from_the_ihdr() {
        assert_eq!(png_dimensions(PNG_HEADER), Some((256, 192)));
    }

    #[test]
    fn non_png_output_has_no_dimensions() {
        assert_eq!(png_dimensions(b"not a png at all"), None);
        assert_eq!(png_dimensions(b""), None);
    }

    #[test]
    fn only_allowlisted_render_sizes_are_accepted() {
        for size in PREVIEW_PIXEL_SIZES {
            assert!(is_supported_size(size));
        }
        for size in [0, 1, 300, 2048, 16384, u32::MAX] {
            assert!(!is_supported_size(size), "{size} must be refused");
        }
    }

    #[test]
    fn staged_extensions_carry_nothing_from_the_original_name() {
        assert_eq!(sanitized_extension("deck.key").as_deref(), Some("key"));
        assert_eq!(sanitized_extension("REPORT.DOCX").as_deref(), Some("docx"));
        // Anything that could be argv, a path, or a shell character is dropped
        // rather than sanitised.
        assert_eq!(sanitized_extension("evil.-rf"), None);
        assert_eq!(sanitized_extension("evil.a b"), None);
        assert_eq!(sanitized_extension("evil.a/b"), None);
        assert_eq!(sanitized_extension("evil.$(id)"), None);
        assert_eq!(sanitized_extension("noext"), None);
        assert_eq!(sanitized_extension(&format!("a.{}", "x".repeat(20))), None);
    }
}
