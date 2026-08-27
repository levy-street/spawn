//! Focus-weighted CPU scheduling for session workers.
//!
//! Every launched worker is enrolled into a per-session transient systemd scope
//! (`spawn-session-<uuid>.scope`), so the session process tree gets its own
//! cgroup instead of pooling with spawnd and every other session inside
//! `spawnd.service`. The session currently receiving keystrokes gets its
//! scope's `CPUWeight` boosted and decays back after idle — under host CPU
//! contention (builds, scrapers), the session the operator is typing into
//! wins the scheduler instead of stuttering. Weights are shares, not limits:
//! they change nothing on an idle host.
//!
//! Everything here is best-effort. Enrollment failure (no systemd user
//! manager, no cpu-controller delegation, unit collision) leaves the worker
//! exactly where it was; boost failure (session exited, scope collected) just
//! drops the bookkeeping. `SPAWND_NO_CPU_SCOPES=1` disables the whole
//! feature.

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::process::Stdio;
#[cfg(target_os = "linux")]
use std::sync::OnceLock;
#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(target_os = "linux")]
use tokio::process::Command;
#[cfg(target_os = "linux")]
use tokio::sync::mpsc;
#[cfg(target_os = "linux")]
use tokio::time::Instant;
use uuid::Uuid;

/// Baseline weight for an enrolled session scope (systemd's own default).
#[cfg(target_os = "linux")]
const DEFAULT_WEIGHT: u32 = 100;
/// Weight while the session is receiving input. 5× siblings: decisive under
/// contention, irrelevant when idle.
#[cfg(target_os = "linux")]
const FOCUS_WEIGHT: u32 = 500;
/// How long after the last keystroke the boost is retained. Long enough to
/// cover the response the keystrokes provoked (the session streaming output),
/// short enough that a parked session stops outranking an active one.
#[cfg(target_os = "linux")]
const FOCUS_IDLE_DECAY: Duration = Duration::from_secs(30);
#[cfg(target_os = "linux")]
const DECAY_SWEEP: Duration = Duration::from_secs(5);
/// Bounded queue: a typing burst coalesces; dropped notes only delay a boost
/// by one sweep at worst.
#[cfg(target_os = "linux")]
const NOTE_QUEUE_DEPTH: usize = 64;

#[cfg(target_os = "linux")]
pub fn enabled() -> bool {
    // Unit tests launch real workers and forward real input; without this
    // gate they would create genuine scopes on the developer's user manager
    // and exec systemctl from test runtimes.
    if cfg!(test) {
        return false;
    }
    std::env::var_os("SPAWND_NO_CPU_SCOPES").is_none()
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)] // Kept as the platform capability query; public callers are Linux-only today.
pub fn enabled() -> bool {
    false
}

#[cfg(target_os = "linux")]
fn scope_unit(session_id: Uuid) -> String {
    format!("spawn-session-{session_id}.scope")
}

/// Move a freshly spawned worker into its per-session scope. Called before the
/// shell itself is spawned (`T_START`), so the whole session process tree
/// inherits the scope's cgroup. A scope surviving from a previous spawnd
/// (worker relaunch reusing the id) makes the create fail benignly.
#[cfg(target_os = "linux")]
pub async fn enroll_worker(session_id: Uuid, pid: u32) {
    if !enabled() {
        return;
    }
    let unit = scope_unit(session_id);
    let result = Command::new("busctl")
        .args([
            "--user",
            "call",
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
            "StartTransientUnit",
            "ssa(sv)a(sa(sv))",
            &unit,
            "fail",
            "2",
            "PIDs",
            "au",
            "1",
            &pid.to_string(),
            "CPUWeight",
            "t",
            &DEFAULT_WEIGHT.to_string(),
            "0",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    match result {
        Ok(status) if status.success() => {
            tracing::debug!(%session_id, pid, %unit, "worker enrolled in cpu scope");
        }
        Ok(status) => {
            // Most commonly "unit already loaded" from a prior enrollment.
            tracing::debug!(%session_id, pid, %unit, code = ?status.code(), "cpu scope enrollment declined");
        }
        Err(error) => {
            tracing::debug!(%session_id, pid, %error, "cpu scope enrollment unavailable");
        }
    }
}

#[cfg(not(target_os = "linux"))]
pub async fn enroll_worker(_session_id: Uuid, _pid: u32) {}

/// Record input activity for a session. Cheap enough for the per-keystroke
/// path: one bounded `try_send`; the scheduler task does the rest.
#[cfg(target_os = "linux")]
pub fn note_input(session_id: Uuid) {
    if !enabled() {
        return;
    }
    let sender = NOTE_TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel(NOTE_QUEUE_DEPTH);
        tokio::spawn(run_focus_scheduler(rx));
        tx
    });
    let _ = sender.try_send(session_id);
}

#[cfg(not(target_os = "linux"))]
pub fn note_input(_session_id: Uuid) {}

#[cfg(target_os = "linux")]
static NOTE_TX: OnceLock<mpsc::Sender<Uuid>> = OnceLock::new();

#[cfg(target_os = "linux")]
async fn run_focus_scheduler(mut notes: mpsc::Receiver<Uuid>) {
    let mut focused: HashMap<Uuid, Instant> = HashMap::new();
    let mut sweep = tokio::time::interval(DECAY_SWEEP);
    sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            note = notes.recv() => {
                let Some(session_id) = note else { return };
                let newly_focused = focused.insert(session_id, Instant::now()).is_none();
                if newly_focused {
                    set_scope_weight(session_id, FOCUS_WEIGHT).await;
                }
            }
            _ = sweep.tick() => {
                let now = Instant::now();
                let expired: Vec<Uuid> = focused
                    .iter()
                    .filter(|(_, last)| now.duration_since(**last) >= FOCUS_IDLE_DECAY)
                    .map(|(id, _)| *id)
                    .collect();
                for session_id in expired {
                    focused.remove(&session_id);
                    set_scope_weight(session_id, DEFAULT_WEIGHT).await;
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
async fn set_scope_weight(session_id: Uuid, weight: u32) {
    let unit = scope_unit(session_id);
    let result = Command::new("systemctl")
        .args([
            "--user",
            "set-property",
            "--runtime",
            &unit,
            &format!("CPUWeight={weight}"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    match result {
        Ok(status) if status.success() => {
            tracing::debug!(%session_id, weight, "session cpu weight set");
        }
        // The scope is gone (session exited) or systemd is unavailable; the
        // bookkeeping entry is already dropped or will expire on its own.
        Ok(_) | Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn scope_names_are_deterministic_and_unit_safe() {
        let id = Uuid::parse_str("5068ede1-ee21-43b4-b43f-908a3c4f9c8b").unwrap();
        assert_eq!(
            scope_unit(id),
            "spawn-session-5068ede1-ee21-43b4-b43f-908a3c4f9c8b.scope"
        );
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn cpu_scopes_are_disabled_off_linux() {
        assert!(!enabled());
    }
}
