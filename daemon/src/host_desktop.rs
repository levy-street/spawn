//! Reveal and open, on the host's own desktop.
//!
//! These are the only operations in `spawn.host.ctl` whose effect lands on
//! someone's screen rather than in their filesystem, and `desktop.open` is the
//! only one that hands a file to another program. That matters more than it
//! looks: the same channel already offers `fs.write.begin`, so an unguarded
//! "open this file" would compose with it into write-then-execute. Everything
//! below exists to make that composition useless.
//!
//! The wire payload is a path and nothing else — there is no field for an
//! application, arguments or flags, so argv is built entirely from constants
//! plus one path the daemon resolved itself. Nothing a client sends can name a
//! program.

#[cfg(target_os = "macos")]
use std::path::Path;

#[cfg(target_os = "macos")]
use crate::host_files::FsResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DesktopAction {
    /// Select the file in the file manager. Never executes the target.
    Reveal,
    /// Hand the file to its default application.
    Open,
}

impl DesktopAction {
    pub(crate) fn as_wire(self) -> &'static str {
        match self {
            DesktopAction::Reveal => "reveal",
            DesktopAction::Open => "open",
        }
    }
}

/// Indirection so tests can assert what *would* have been launched without
/// opening windows on the machine running them.
#[cfg(target_os = "macos")]
pub(crate) trait Launcher: Send + Sync + 'static {
    fn launch(&self, action: DesktopAction, path: &Path) -> FsResult<()>;
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{DesktopAction, Launcher};
    use crate::host_files::{FsError, FsResult, HostFileOperations, HostFileService, LaunchTarget};
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Mutex;
    use tokio::time::Instant;

    /// Absolute, never a `PATH` lookup: a hijacked `PATH` in the agent's
    /// environment must not be able to choose which binary this is.
    const OPEN_BINARY: &str = "/usr/bin/open";
    const LAUNCH_TIMEOUT: Duration = Duration::from_secs(5);
    /// Burst allowance, then one launch every `REFILL`.
    const BURST: f64 = 3.0;
    const REFILL: Duration = Duration::from_millis(500);

    pub(crate) struct SystemLauncher;

    impl Launcher for SystemLauncher {
        fn launch(&self, action: DesktopAction, path: &Path) -> FsResult<()> {
            let path = path.to_path_buf();
            std::thread::spawn(move || {
                if let Err(error) = run_open(action, &path) {
                    tracing::debug!(?error, "desktop launch failed");
                }
            });
            Ok(())
        }
    }

    fn run_open(action: DesktopAction, path: &Path) -> std::io::Result<()> {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};

        let mut command = Command::new(OPEN_BINARY);
        if action == DesktopAction::Reveal {
            command.arg("-R");
        }
        command.arg(path);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Anything in this process's environment would otherwise be inherited
        // by whatever application LaunchServices starts. The Mach bootstrap
        // port that makes the GUI session reachable rides the task port, not
        // the environment, so clearing it does not break launching.
        command.env_clear();
        for key in ["HOME", "PATH", "TMPDIR", "USER", "LANG"] {
            if let Ok(value) = std::env::var(key) {
                command.env(key, value);
            }
        }
        // Its own session, so a launched application does not share our process
        // group and cannot be taken down with us.
        unsafe {
            command.pre_exec(|| {
                // Only async-signal-safe calls are legal here; setsid is.
                if nix::libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let deadline = std::time::Instant::now() + LAUNCH_TIMEOUT;
        loop {
            if let Some(_status) = child.try_wait()? {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    struct TokenBucket {
        tokens: f64,
        updated: Instant,
    }

    pub(crate) struct DesktopService {
        launcher: Arc<dyn Launcher>,
        bucket: Mutex<TokenBucket>,
    }

    impl DesktopService {
        pub(crate) fn new() -> Self {
            Self::with_launcher(Arc::new(SystemLauncher))
        }

        pub(crate) fn with_launcher(launcher: Arc<dyn Launcher>) -> Self {
            Self {
                launcher,
                bucket: Mutex::new(TokenBucket {
                    tokens: BURST,
                    updated: Instant::now(),
                }),
            }
        }

        /// A compromised or simply buggy client must not be able to open a
        /// thousand windows on someone's desktop.
        async fn take_token(&self) -> FsResult<()> {
            let mut bucket = self.bucket.lock().await;
            let now = Instant::now();
            let elapsed = now.saturating_duration_since(bucket.updated).as_secs_f64();
            bucket.tokens = (bucket.tokens + elapsed / REFILL.as_secs_f64()).min(BURST);
            bucket.updated = now;
            if bucket.tokens < 1.0 {
                return Err(FsError::new(
                    "launch_rate_limited",
                    "too many launch requests; try again shortly",
                ));
            }
            bucket.tokens -= 1.0;
            Ok(())
        }

        pub(crate) async fn reveal(
            &self,
            files: &HostFileService,
            path: &str,
            operations: Arc<HostFileOperations>,
        ) -> FsResult<String> {
            // Reveal only selects the file; it never executes it, so any path
            // the capability walk accepts is fair game, directories included.
            let target = files
                .open_launch_target_in_session(path, false, operations)
                .await?;
            self.take_token().await?;
            self.launcher
                .launch(DesktopAction::Reveal, &target.display)?;
            Ok(target.display.to_string_lossy().into_owned())
        }

        pub(crate) async fn open(
            &self,
            files: &HostFileService,
            path: &str,
            operations: Arc<HostFileOperations>,
        ) -> FsResult<String> {
            let target = files
                .open_launch_target_in_session(path, true, operations)
                .await?;
            gate_open(&target)?;
            self.take_token().await?;
            self.launcher.launch(DesktopAction::Open, &target.display)?;
            Ok(target.display.to_string_lossy().into_owned())
        }
    }

    /// Every reason the daemon will refuse to launch something.
    ///
    /// Re-run on the host for every request. Whatever the client believes about
    /// `open_allowed` from an earlier `fs.stat` is a hint for drawing a menu,
    /// never a grant.
    pub(crate) fn gate_open(target: &LaunchTarget) -> FsResult<()> {
        // A `.app` is a directory. Refusing directories outright is what makes
        // "upload a bundle, then open it" impossible, and it costs nothing:
        // folders are served by reveal instead.
        if target.is_dir {
            return Err(FsError::new("not_file", "path is not a regular file"));
        }
        if target.mode & 0o111 != 0 {
            return Err(FsError::new(
                "open_not_permitted",
                "executable files are not opened",
            ));
        }
        let classification = crate::host_mime::classify(&target.name, &target.head);
        if !classification.open_allowed {
            return Err(FsError::new(
                "open_not_permitted",
                "this file type is not opened on the host",
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::ffi::OsString;
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct RecordingLauncher {
            calls: AtomicUsize,
        }

        impl Launcher for RecordingLauncher {
            fn launch(&self, _action: DesktopAction, _path: &Path) -> FsResult<()> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }

        fn target(name: &str, head: &[u8], mode: u32, is_dir: bool) -> LaunchTarget {
            LaunchTarget {
                display: PathBuf::from(format!("/Users/tester/{name}")),
                is_dir,
                mode,
                name: OsString::from(name),
                head: head.to_vec(),
            }
        }

        const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
        const MACH_O: &[u8] = &[0xCF, 0xFA, 0xED, 0xFE, 0x0C, 0x00, 0x00, 0x01];

        #[test]
        fn a_directory_is_never_opened() {
            // The whole `.app` bundle vector closes here.
            let result = gate_open(&target("Some.app", b"", 0o755, true));
            assert_eq!(result.unwrap_err().code, "not_file");
        }

        #[test]
        fn the_execute_bit_alone_is_disqualifying() {
            let result = gate_open(&target("photo.png", PNG, 0o755, false));
            assert_eq!(result.unwrap_err().code, "open_not_permitted");
        }

        #[test]
        fn executable_content_is_refused_however_it_is_named() {
            let result = gate_open(&target("notes.txt", MACH_O, 0o644, false));
            assert_eq!(result.unwrap_err().code, "open_not_permitted");
        }

        #[test]
        fn url_indirection_is_refused() {
            let result = gate_open(&target(
                "link.webloc",
                b"<?xml version=\"1.0\"?>",
                0o644,
                false,
            ));
            assert_eq!(result.unwrap_err().code, "open_not_permitted");
        }

        #[test]
        fn ordinary_documents_pass_the_gate() {
            gate_open(&target("photo.png", PNG, 0o644, false)).expect("png should open");
            gate_open(&target("doc.pdf", b"%PDF-1.7\n", 0o644, false)).expect("pdf should open");
        }

        #[tokio::test(start_paused = true)]
        async fn the_rate_limiter_bounds_a_burst_and_then_refills() {
            let launcher = Arc::new(RecordingLauncher {
                calls: AtomicUsize::new(0),
            });
            let service = DesktopService::with_launcher(launcher.clone());

            for _ in 0..3 {
                service.take_token().await.expect("burst allowance");
            }
            let refused = service.take_token().await.unwrap_err();
            assert_eq!(refused.code, "launch_rate_limited");

            tokio::time::advance(Duration::from_millis(600)).await;
            service.take_token().await.expect("a token refilled");
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use crate::host_files::{FsError, FsResult, HostFileOperations, HostFileService};
    use std::sync::Arc;

    /// Not shipped off macOS. `xdg-open` on a headless user service is a no-op
    /// at best, and "reveal" has no portable equivalent — GNOME, KDE and the
    /// rest each want a different command. The capability is simply not
    /// advertised, so the UI never offers these.
    pub(crate) struct DesktopService;

    impl DesktopService {
        pub(crate) fn new() -> Self {
            Self
        }

        pub(crate) async fn reveal(
            &self,
            _files: &HostFileService,
            _path: &str,
            _operations: Arc<HostFileOperations>,
        ) -> FsResult<String> {
            Err(unavailable())
        }

        pub(crate) async fn open(
            &self,
            _files: &HostFileService,
            _path: &str,
            _operations: Arc<HostFileOperations>,
        ) -> FsResult<String> {
            Err(unavailable())
        }
    }

    fn unavailable() -> FsError {
        FsError::new(
            "desktop_unavailable",
            "this host cannot open files on a desktop",
        )
    }
}

pub(crate) use imp::DesktopService;

/// Whether this build advertises the desktop operations at all.
pub(crate) const DESKTOP_SUPPORTED: bool = cfg!(target_os = "macos");
