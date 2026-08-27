//! The one moment SPAWN D asks macOS for anything.
//!
//! macOS gates Desktop, Documents and Downloads behind TCC, and it asks the
//! *responsible* process rather than the one that touched the file. For this
//! daemon that means every consent dialog on the machine names `spawnd`, even
//! when the thing reading the folder was an agent the person started inside a
//! session. Left alone that is what the complaint was: half a dozen anonymous
//! dialogs arriving mid-session, each for something the person did not ask for
//! in that moment and cannot connect to anything they did.
//!
//! There is no way to *not* be asked — the daemon genuinely reads those folders
//! and macOS genuinely gates them. What can be chosen is **when**, and what the
//! dialog says. So this module does the asking once, deliberately, on the first
//! registration after possession, while the wizard is still on screen having
//! just explained it; `Info.plist` supplies the sentence macOS prints.
//!
//! Three constraints shape the rest:
//!
//! - **It must run inside the service.** A grant is recorded against the
//!   responsible process, so priming from a `spawnd` the desktop app spawned
//!   would file the grant under the *app* and the launchd daemon would be asked
//!   all over again the first time it read a folder. Whoever will need the
//!   grant has to be the one who asks for it.
//! - **A refusal is sticky.** "Don't Allow" persists until someone clears it in
//!   System Settings, so asking where nobody can answer is worse than not
//!   asking: the dialog is auto-refused and the answer is kept. Nothing is
//!   primed unless a console session says a person is at this screen.
//! - **Only what is actually used.** Desktop, Documents and Downloads are the
//!   folders a working directory sits in. Photos and the media library are not,
//!   and the prompts for them observed in the field came from an agent walking
//!   `$HOME`, not from anything the daemon set out to do — so they stay lazy.
//!   Asking for a photo library up front is how software teaches people that
//!   the safe answer to a SPAWN D dialog is no.

use std::path::PathBuf;
use std::time::Duration;

/// How long one folder gets. The dialog has no timeout of its own, and an
/// unanswered one must not hold registration open for ever; a person who walks
/// away simply keeps the lazy prompt they would have had anyway.
const ASK_TIMEOUT: Duration = Duration::from_secs(90);

/// Set to any value to never prime. For headless fleets that do have a console
/// user, and for anyone who would rather be asked lazily.
pub const NO_PRIME_ENV: &str = "SPAWND_NO_PERMISSION_PRIME";

/// What the daemon reads, in the order it asks.
///
/// `label` is what the daemon's own log and status call it; the sentence the
/// person actually reads comes from the matching `NS*UsageDescription` in
/// `daemon/Info.plist`, which macOS prints inside the dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Location {
    Desktop,
    Documents,
    Downloads,
}

impl Location {
    /// The order of asking. Desktop first because it is the folder people
    /// recognise fastest, so the first dialog is the least surprising one.
    pub const ORDER: [Location; 3] = [Location::Desktop, Location::Documents, Location::Downloads];

    pub fn label(self) -> &'static str {
        match self {
            Location::Desktop => "Desktop",
            Location::Documents => "Documents",
            Location::Downloads => "Downloads",
        }
    }

    fn relative(self) -> &'static str {
        self.label()
    }

    fn path(self, home: &std::path::Path) -> PathBuf {
        home.join(self.relative())
    }
}

/// What macOS answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grant {
    /// Readable — either just granted, or granted some time before.
    Granted,
    /// Refused, now or previously. Sticky until System Settings says otherwise.
    Refused,
    /// No such folder on this Mac. Nothing was asked and nothing is wrong.
    Absent,
    /// The dialog went unanswered inside `ASK_TIMEOUT`, or the probe failed for
    /// a reason that was not permission. The lazy prompt still stands.
    Unanswered,
    /// The person declined the batch before macOS was asked anything. Nothing
    /// is denied — the ordinary prompt still arrives the first time something
    /// actually reads the folder.
    Declined,
}

impl Grant {
    pub fn as_wire(self) -> &'static str {
        match self {
            Grant::Granted => "granted",
            Grant::Refused => "refused",
            Grant::Absent => "absent",
            Grant::Unanswered => "unanswered",
            Grant::Declined => "declined",
        }
    }
}

/// One line per location, in `Location::ORDER`.
pub type Report = Vec<(Location, Grant)>;

/// Classify one directory by trying to read it.
///
/// Reading a single entry is the whole test: it is what TCC gates, and it is
/// the smallest thing that triggers the dialog. Nothing is read beyond the
/// first name, and the name is discarded.
fn probe_blocking(path: &std::path::Path) -> Grant {
    match std::fs::read_dir(path) {
        Ok(mut entries) => match entries.next() {
            // An empty folder answers the question just as well as a full one.
            None => Grant::Granted,
            Some(Ok(_)) => Grant::Granted,
            Some(Err(error)) => classify(&error),
        },
        Err(error) => classify(&error),
    }
}

fn classify(error: &std::io::Error) -> Grant {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => Grant::Refused,
        std::io::ErrorKind::NotFound => Grant::Absent,
        _ => Grant::Unanswered,
    }
}

/// Ask for each location in turn, and say what came back.
///
/// Serial on purpose. Three dialogs at once is a stack of anonymous sheets and
/// reads as an app grabbing at everything; one at a time, each answered before
/// the next appears, reads as a list being worked through.
#[cfg(target_os = "macos")]
pub async fn prime() -> Report {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut report = Vec::with_capacity(Location::ORDER.len());
    for location in Location::ORDER {
        let path = location.path(&home);
        let asked = tokio::time::timeout(
            ASK_TIMEOUT,
            tokio::task::spawn_blocking(move || probe_blocking(&path)),
        )
        .await;
        // A timed-out probe leaves its thread parked on the open dialog; that
        // is the cost of a syscall that cannot be cancelled, and it ends when
        // the person answers. Registration does not wait for it.
        let grant = match asked {
            Ok(Ok(grant)) => grant,
            Ok(Err(_)) | Err(_) => Grant::Unanswered,
        };
        report.push((location, grant));
    }
    report
}

#[cfg(not(target_os = "macos"))]
pub async fn prime() -> Report {
    // Only macOS gates these folders. Everywhere else the question does not
    // exist, and asking it would invent a step that has no dialog behind it.
    Vec::new()
}

/// Whether to ask at all, on this machine, right now.
///
/// The console check is the load-bearing one: `/dev/console` is owned by
/// whoever is logged in at the screen, so "nobody, or somebody else" is the
/// case where a dialog would be auto-refused and the refusal kept. A daemon
/// possessed over SSH onto an idle Mac must reach Online with its lazy prompts
/// intact rather than with three denials burned in.
#[cfg(target_os = "macos")]
pub fn someone_is_at_this_screen() -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(console) = std::fs::metadata("/dev/console") else {
        return false;
    };
    console.uid() == rustix::process::getuid().as_raw()
}

#[cfg(not(target_os = "macos"))]
pub fn someone_is_at_this_screen() -> bool {
    false
}

/// Where the app and the service meet.
///
/// One directory for the whole machine rather than one per account instance,
/// because that is what the thing being recorded actually is: TCC grants
/// `spawnd` the binary, once, whoever it is running for. A per-instance answer
/// would ask the same person the same question again the first time they added
/// a second account, for a grant they had already given.
///
/// This is `dirs::config_dir()/spawn` — the daemon's own base — chosen because
/// the desktop app derives the identical path with the identical call and needs
/// no knowledge of instance directory naming to find it.
pub fn shared_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|base| base.join("spawn"))
}

/// Set by the app when it is about to show the consent screen, and the reason
/// the daemon waits at all. Its absence means nobody is driving — an
/// `install.sh` run, a headless possession — and the daemon primes nothing and
/// waits for nothing, leaving the ordinary lazy prompts alone.
pub fn request_path(shared: &std::path::Path) -> PathBuf {
    shared.join("permissions.request")
}

/// The person's answer, written by the app when they press a button.
pub fn consent_path(shared: &std::path::Path) -> PathBuf {
    shared.join("permissions.consent")
}

/// What was asked and what came back. Its existence is what makes this
/// once-per-machine.
pub fn report_path(shared: &std::path::Path) -> PathBuf {
    shared.join("permissions.json")
}

/// Longest the daemon will hold for an answer.
///
/// Bounded because the window can be closed, and an unbounded wait would leave
/// a task parked for the life of the daemon. On expiry nothing is primed *and
/// nothing is recorded*, so the person keeps their lazy prompts and the next
/// possession may offer the gate again — closing the window costs nothing and
/// forecloses nothing.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(120);
const CONSENT_POLL: Duration = Duration::from_millis(250);

/// What the app said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Consent {
    /// Ask macOS now.
    Prime,
    /// The person declined the batch. Recorded so it is never batched again.
    Decline,
    /// Nobody answered inside `CONSENT_TIMEOUT`.
    Unanswered,
}

/// Read an answer the app has already written, if any.
///
/// Deliberately lenient about the file's shape: this is a handshake between two
/// programs shipped together, and a malformed answer should leave the person
/// with lazy prompts rather than fail a possession.
pub fn read_consent(shared: &std::path::Path) -> Option<Consent> {
    let raw = std::fs::read(consent_path(shared)).ok()?;
    let parsed: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    match parsed.get("prime").and_then(serde_json::Value::as_bool) {
        Some(true) => Some(Consent::Prime),
        Some(false) => Some(Consent::Decline),
        None => None,
    }
}

/// Announce that a screen is about to ask, so the daemon holds instead of
/// asking over the top of it.
pub fn request_gate(shared: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(shared)?;
    // A stale answer from a previous, abandoned gate must never be read as this
    // one's: the request opens a fresh question.
    let _ = std::fs::remove_file(consent_path(shared));
    write_atomic(&request_path(shared), b"{}")
}

/// Record the person's answer.
pub fn write_consent(shared: &std::path::Path, prime: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(shared)?;
    let body = serde_json::json!({ "prime": prime, "answered_at_unix": unix_now() });
    write_atomic(&consent_path(shared), &serde_json::to_vec_pretty(&body)?)
}

/// Wait for the app's answer, up to `CONSENT_TIMEOUT`.
///
/// Polled rather than watched: the wait is bounded, quarter-second granularity
/// is imperceptible against a person reading a screen, and a filesystem watcher
/// would be a dependency and a set of platform edge cases bought for nothing.
pub async fn await_consent(shared: &std::path::Path) -> Consent {
    let deadline = tokio::time::Instant::now() + CONSENT_TIMEOUT;
    loop {
        if let Some(consent) = read_consent(shared) {
            return consent;
        }
        if tokio::time::Instant::now() >= deadline {
            return Consent::Unanswered;
        }
        tokio::time::sleep(CONSENT_POLL).await;
    }
}

/// Clear the handshake once it has been honoured, so a later possession starts
/// from a clean question rather than replaying this one's answer.
pub fn clear_gate(shared: &std::path::Path) {
    let _ = std::fs::remove_file(request_path(shared));
    let _ = std::fs::remove_file(consent_path(shared));
}

/// Record what was asked and what came back, so the next registration does not
/// ask again — including after a refusal, which only System Settings can undo
/// and which re-asking cannot fix.
pub fn write_report(shared: &std::path::Path, report: &Report) -> std::io::Result<()> {
    let entries: Vec<serde_json::Value> = report
        .iter()
        .map(|(location, grant)| {
            serde_json::json!({ "location": location.label(), "grant": grant.as_wire() })
        })
        .collect();
    let body = serde_json::json!({
        "asked_at_unix": unix_now(),
        "locations": entries,
    });
    std::fs::create_dir_all(shared)?;
    write_atomic(&report_path(shared), &serde_json::to_vec_pretty(&body)?)
}

/// A declined batch, recorded in the same shape a real one would be, so the
/// "have we asked?" check is one file test either way.
pub fn declined_report() -> Report {
    Location::ORDER
        .iter()
        .map(|location| (*location, Grant::Declined))
        .collect()
}

/// Seconds since the epoch, for the "when" line in the files above.
///
/// Deliberately not a formatted date: nothing parses these back, and the civil
/// calendar conversion that would prettify them is seventeen lines of
/// arithmetic that already exists once in `state.rs`. One copy of that is
/// enough, and a number nobody has to keep correct is better than a second.
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)
}

/// One line summarising the whole ceremony, in the daemon's own voice.
pub fn summary(report: &Report) -> String {
    if report.is_empty() {
        return "nothing to ask for on this platform".into();
    }
    report
        .iter()
        .map(|(location, grant)| format!("{} {}", location.label(), grant.as_wire()))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_location_is_a_folder_directly_under_home() {
        let home = std::path::Path::new("/Users/someone");
        for location in Location::ORDER {
            let path = location.path(home);
            assert_eq!(path.parent(), Some(home));
            assert_eq!(
                path.file_name().and_then(|name| name.to_str()),
                Some(location.label())
            );
        }
    }

    #[test]
    fn the_asking_order_is_desktop_documents_downloads() {
        // The order is the thing a person experiences, so it is pinned rather
        // than left to however the enum happens to be written.
        let labels: Vec<&str> = Location::ORDER.iter().map(|l| l.label()).collect();
        assert_eq!(labels, ["Desktop", "Documents", "Downloads"]);
    }

    #[test]
    fn the_photo_and_media_libraries_are_never_primed() {
        // Regression guard for the actual complaint: the prompts that read as
        // "weird things" came from a library nothing here sets out to read, and
        // adding one to ORDER would put it back in front of every new user.
        for location in Location::ORDER {
            assert!(!location.label().to_lowercase().contains("photo"));
            assert!(!location.label().to_lowercase().contains("music"));
        }
        assert_eq!(Location::ORDER.len(), 3);
    }

    #[test]
    fn a_readable_directory_reads_as_granted_and_a_missing_one_as_absent() {
        let temporary = tempfile::tempdir().expect("temp dir");
        assert_eq!(probe_blocking(temporary.path()), Grant::Granted);
        std::fs::write(temporary.path().join("a"), b"x").expect("write");
        assert_eq!(probe_blocking(temporary.path()), Grant::Granted);
        assert_eq!(
            probe_blocking(&temporary.path().join("no-such-folder")),
            Grant::Absent
        );
    }

    #[test]
    fn permission_denied_is_the_only_refusal() {
        use std::io::{Error, ErrorKind};
        assert_eq!(
            classify(&Error::from(ErrorKind::PermissionDenied)),
            Grant::Refused
        );
        assert_eq!(classify(&Error::from(ErrorKind::NotFound)), Grant::Absent);
        // Anything else leaves the lazy prompt in place rather than recording
        // an answer macOS never gave.
        assert_eq!(
            classify(&Error::from(ErrorKind::InvalidInput)),
            Grant::Unanswered
        );
    }

    #[test]
    fn the_report_names_every_location_and_its_answer() {
        let report: Report = vec![
            (Location::Desktop, Grant::Granted),
            (Location::Documents, Grant::Refused),
            (Location::Downloads, Grant::Absent),
        ];
        assert_eq!(
            summary(&report),
            "Desktop granted, Documents refused, Downloads absent"
        );
        let temporary = tempfile::tempdir().expect("temp dir");
        write_report(temporary.path(), &report).expect("write report");
        let written = std::fs::read_to_string(report_path(temporary.path())).expect("read report");
        let parsed: serde_json::Value = serde_json::from_str(&written).expect("valid json");
        assert_eq!(parsed["locations"][0]["location"], "Desktop");
        assert_eq!(parsed["locations"][0]["grant"], "granted");
        assert_eq!(parsed["locations"][1]["grant"], "refused");
        assert!(parsed["asked_at_unix"]
            .as_u64()
            .is_some_and(|when| when > 0));
    }

    #[test]
    fn an_empty_report_still_says_something() {
        assert_eq!(summary(&Vec::new()), "nothing to ask for on this platform");
    }

    /// The handshake is a contract with the desktop app, so its file names and
    /// its shape are pinned here rather than left to match by luck.
    #[test]
    fn the_handshake_files_sit_together_and_are_named_exactly() {
        let shared = std::path::Path::new("/Users/someone/Library/Application Support/spawn");
        assert_eq!(
            request_path(shared).file_name().unwrap(),
            "permissions.request"
        );
        assert_eq!(
            consent_path(shared).file_name().unwrap(),
            "permissions.consent"
        );
        assert_eq!(report_path(shared).file_name().unwrap(), "permissions.json");
        for path in [
            request_path(shared),
            consent_path(shared),
            report_path(shared),
        ] {
            assert_eq!(path.parent(), Some(shared));
        }
    }

    #[test]
    fn an_answer_round_trips_both_ways_and_absence_is_not_an_answer() {
        let temporary = tempfile::tempdir().expect("temp dir");
        assert_eq!(read_consent(temporary.path()), None, "nothing asked yet");

        write_consent(temporary.path(), true).expect("consent");
        assert_eq!(read_consent(temporary.path()), Some(Consent::Prime));

        write_consent(temporary.path(), false).expect("decline");
        assert_eq!(read_consent(temporary.path()), Some(Consent::Decline));
    }

    #[test]
    fn opening_a_gate_discards_an_abandoned_answer() {
        // Otherwise a person who closed the window last time would have that
        // stale answer applied to a question they are only now being asked.
        let temporary = tempfile::tempdir().expect("temp dir");
        write_consent(temporary.path(), true).expect("stale answer");
        request_gate(temporary.path()).expect("open the gate");
        assert_eq!(read_consent(temporary.path()), None);
        assert!(request_path(temporary.path()).exists());
    }

    #[test]
    fn honouring_a_gate_leaves_neither_marker_behind() {
        let temporary = tempfile::tempdir().expect("temp dir");
        request_gate(temporary.path()).expect("open");
        write_consent(temporary.path(), true).expect("answer");
        clear_gate(temporary.path());
        assert!(!request_path(temporary.path()).exists());
        assert!(!consent_path(temporary.path()).exists());
    }

    #[test]
    fn a_malformed_answer_is_no_answer_rather_than_a_yes() {
        // Two programs shipped together, so this should not happen — but the
        // safe reading of a damaged file is "nobody said prime".
        let temporary = tempfile::tempdir().expect("temp dir");
        std::fs::write(consent_path(temporary.path()), b"not json at all").expect("write");
        assert_eq!(read_consent(temporary.path()), None);
        std::fs::write(consent_path(temporary.path()), br#"{"prime":"yes"}"#).expect("write");
        assert_eq!(read_consent(temporary.path()), None);
    }

    #[tokio::test]
    async fn waiting_returns_unanswered_rather_than_blocking_for_ever() {
        // Pinned because the failure mode is invisible: a wait that never ends
        // parks a task for the life of the daemon and nothing looks wrong.
        let temporary = tempfile::tempdir().expect("temp dir");
        tokio::time::pause();
        let shared = temporary.path().to_path_buf();
        let waiting = tokio::spawn(async move { await_consent(&shared).await });
        tokio::time::advance(CONSENT_TIMEOUT + Duration::from_secs(1)).await;
        assert_eq!(waiting.await.expect("join"), Consent::Unanswered);
    }

    #[test]
    fn a_declined_batch_records_every_location_as_declined() {
        let report = declined_report();
        assert_eq!(report.len(), Location::ORDER.len());
        assert!(report.iter().all(|(_, grant)| *grant == Grant::Declined));
        // "Declined" must be tellable from "Refused": one is our screen, the
        // other is macOS, and only the second is sticky.
        assert_eq!(Grant::Declined.as_wire(), "declined");
        assert_ne!(Grant::Declined.as_wire(), Grant::Refused.as_wire());
    }
}
