//! In-memory registry of sessions owned by this daemon process. The server
//! holds the durable view; we use this map only to route inbound frames to
//! the right PTY and to enumerate `existing_sessions` on (re)connect.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use uuid::Uuid;

use crate::pty::{ForwarderControl, SessionHandle, SessionLifecycle};
use spawnd::sessiond::wire::LifecycleSignal;

#[derive(Default, Clone)]
pub struct SessionRegistry {
    inner: Arc<Mutex<HashMap<Uuid, RegistryEntry>>>,
    generation: Arc<AtomicU64>,
    /// One-shot guard for startup worker discovery. The first WS session of
    /// the process triggers discovery; reconnects skip.
    discovery_done: Arc<AtomicBool>,
    /// The validated directory used by the completed startup scan.
    discovered_dir: Arc<std::sync::OnceLock<std::path::PathBuf>>,
    /// Preserve serialization of the existing lazy adoption path.
    attach_lock: Arc<AsyncMutex<()>>,
    /// Launch, lazy adoption and the whole restart have gaps outside the
    /// generation transition. A device may inspect only between those jobs.
    worker_gates: Arc<Mutex<HashMap<Uuid, Weak<tokio::sync::RwLock<()>>>>>,
    /// Serializes the linearization point between a concrete backend
    /// generation and RTC peer insertion/teardown for its UUID. The registry
    /// entry itself remains behind the small synchronous lock above; this
    /// async lock is held only across replacement lifecycle awaits.
    generation_transitions: Arc<Mutex<HashMap<Uuid, Weak<AsyncMutex<()>>>>>,
}

struct RegistryEntry {
    generation: u64,
    handle: SessionHandle,
    /// The environment this daemon started the window's shell with, when it
    /// started it (not for a worker it adopted): what `codex_launch` asks the
    /// window's Codex with.
    launch_env: Option<LaunchEnv>,
}

/// The environment this daemon started a window's shell with.
pub type LaunchEnv = Arc<BTreeMap<String, String>>;

/// Immutable identity of one concrete backend registered for a session UUID.
///
/// Session UUIDs are reused across restart. RTC callbacks must therefore carry
/// this value and use the bound accessors below instead of resolving by UUID,
/// or a callback from the old peer could act on the replacement backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionBinding {
    session_id: Uuid,
    generation: u64,
}

/// One immutable lifecycle capability paired with the exact registry
/// generation from which it was read. The pair is cloned under one registry
/// lock, preventing an old binding from ever being combined with a
/// replacement worker's lifecycle endpoint.
#[derive(Clone)]
pub struct SessionLifecycleSnapshot {
    binding: SessionBinding,
    lifecycle: SessionLifecycle,
}

impl SessionLifecycleSnapshot {
    pub fn binding(&self) -> SessionBinding {
        self.binding
    }

    pub fn lifecycle(&self) -> &SessionLifecycle {
        &self.lifecycle
    }
}

impl SessionBinding {
    pub(crate) fn new(session_id: Uuid, generation: u64) -> Self {
        Self {
            session_id,
            generation,
        }
    }

    pub fn session_id(self) -> Uuid {
        self.session_id
    }

    pub fn generation(self) -> u64 {
        self.generation
    }
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns true the first time it's called per process. Subsequent calls
    /// return false. Used to gate one-shot worker discovery.
    pub fn claim_discovery(&self) -> bool {
        !self.discovery_done.swap(true, Ordering::SeqCst)
    }

    pub async fn lock_attach(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.attach_lock.lock().await
    }

    pub fn finish_discovery(&self, dir: std::path::PathBuf) {
        let _ = self.discovered_dir.set(dir);
    }

    pub fn discovered_dir(&self) -> Option<&std::path::PathBuf> {
        self.discovered_dir.get()
    }

    pub fn worker_gate(&self, id: Uuid) -> Arc<tokio::sync::RwLock<()>> {
        let mut gates = self.worker_gates.lock().expect("worker gates");
        if let Some(gate) = gates.get(&id).and_then(Weak::upgrade) {
            return gate;
        }
        gates.retain(|_, gate| gate.strong_count() > 0);
        let gate = Arc::new(tokio::sync::RwLock::new(()));
        gates.insert(id, Arc::downgrade(&gate));
        gate
    }

    /// Lock one session UUID's backend-generation transition.
    ///
    /// RTC offer insertion revalidates its captured binding while holding
    /// this guard. Removal/replacement invalidates the registry binding and
    /// scans old peers under the same guard, so an old peer is either visible
    /// to that scan or rejected before insertion.
    pub async fn lock_generation_transition(&self, id: Uuid) -> OwnedMutexGuard<()> {
        let transition = {
            let mut transitions = self
                .generation_transitions
                .lock()
                .expect("session generation transitions lock");
            transitions.retain(|_, transition| transition.strong_count() > 0);
            if let Some(transition) = transitions.get(&id).and_then(Weak::upgrade) {
                transition
            } else {
                let transition = Arc::new(AsyncMutex::new(()));
                transitions.insert(id, Arc::downgrade(&transition));
                transition
            }
        };
        transition.lock_owned().await
    }

    /// Whether anyone holds or waits for `id`'s generation transition: a
    /// registration, restart, exit or attach is in the middle of changing or
    /// reading what runs under that id.
    pub fn generation_transition_in_progress(&self, id: Uuid) -> bool {
        self.generation_transitions
            .lock()
            .expect("session generation transitions lock")
            .get(&id)
            .is_some_and(|transition| transition.strong_count() > 0)
    }

    /// How many hold or wait for `id`'s generation transition right now. A
    /// test that holds the transition itself reads two once something else
    /// has reached the lock and is parked on it.
    #[cfg(test)]
    pub(crate) fn generation_transition_holders(&self, id: Uuid) -> usize {
        self.generation_transitions
            .lock()
            .expect("session generation transitions lock")
            .get(&id)
            .map_or(0, Weak::strong_count)
    }

    pub fn contains(&self, id: Uuid) -> bool {
        self.inner.lock().expect("sessions lock").contains_key(&id)
    }

    pub fn binding_for(&self, id: Uuid) -> Option<SessionBinding> {
        self.inner
            .lock()
            .expect("sessions lock")
            .get(&id)
            .map(|entry| SessionBinding {
                session_id: id,
                generation: entry.generation,
            })
    }

    pub fn is_current(&self, binding: SessionBinding) -> bool {
        self.inner
            .lock()
            .expect("sessions lock")
            .get(&binding.session_id)
            .is_some_and(|entry| entry.generation == binding.generation)
    }

    #[cfg(test)]
    pub fn insert(&self, handle: SessionHandle) -> u64 {
        self.insert_launched(handle, None)
    }

    /// `insert`, with the environment this daemon started the shell with when
    /// it started it (`handle_session_create`; none for an adopted worker).
    pub fn insert_launched(&self, handle: SessionHandle, launch_env: Option<LaunchEnv>) -> u64 {
        let id = handle.session_id;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.inner.lock().expect("sessions lock").insert(
            id,
            RegistryEntry {
                generation,
                handle,
                launch_env,
            },
        );
        generation
    }

    pub fn remove_if_generation(&self, id: Uuid, generation: u64) -> Option<SessionHandle> {
        let mut guard = self.inner.lock().expect("sessions lock");
        if guard
            .get(&id)
            .map(|entry| entry.generation == generation)
            .unwrap_or(false)
        {
            return guard.remove(&id).map(|entry| entry.handle);
        }
        None
    }

    pub fn ids(&self) -> Vec<Uuid> {
        self.inner
            .lock()
            .expect("sessions lock")
            .keys()
            .copied()
            .collect()
    }

    /// Apply `f` to the handle if it exists. Returns whether it was found.
    #[cfg(test)]
    pub fn with_handle<F: FnOnce(&SessionHandle)>(&self, id: Uuid, f: F) -> bool {
        let guard = self.inner.lock().expect("sessions lock");
        if let Some(entry) = guard.get(&id) {
            f(&entry.handle);
            true
        } else {
            false
        }
    }

    /// Apply `f` only when the UUID still resolves to the backend captured in
    /// `binding`. This check and the handle access occur under the same lock.
    pub fn with_bound_handle<F: FnOnce(&SessionHandle)>(
        &self,
        binding: SessionBinding,
        f: F,
    ) -> bool {
        let guard = self.inner.lock().expect("sessions lock");
        if let Some(entry) = guard
            .get(&binding.session_id)
            .filter(|entry| entry.generation == binding.generation)
        {
            f(&entry.handle);
            true
        } else {
            false
        }
    }

    pub fn control_for_binding(&self, binding: SessionBinding) -> Option<ForwarderControl> {
        let guard = self.inner.lock().expect("sessions lock");
        guard
            .get(&binding.session_id)
            .filter(|entry| entry.generation == binding.generation)
            .map(|entry| entry.handle.control.clone())
    }

    /// The shell a window's processes hang from, for inspecting them
    /// (`host_conv`). `None` for an unknown session or a worker that never
    /// reported its shell.
    pub fn shell_pid(&self, id: Uuid) -> Option<u32> {
        self.inner
            .lock()
            .expect("sessions lock")
            .get(&id)
            .and_then(|entry| entry.handle.shell_pid())
    }

    /// Note the environment the window's current shell was started with, as
    /// `insert_launched` does.
    #[cfg(all(test, unix))]
    pub fn set_launch_env(&self, id: Uuid, env: LaunchEnv) {
        if let Some(entry) = self.inner.lock().expect("sessions lock").get_mut(&id) {
            entry.launch_env = Some(env);
        }
    }

    /// The environment and folder the window's current shell was started
    /// with, when this daemon started it.
    pub fn launch_context(&self, id: Uuid) -> Option<(LaunchEnv, Arc<str>)> {
        let guard = self.inner.lock().expect("sessions lock");
        let entry = guard.get(&id)?;
        Some((entry.launch_env.clone()?, Arc::clone(&entry.handle.cwd)))
    }

    /// Every window whose worker has reported both its shell and what runs
    /// in its foreground: (session, shell pid, foreground basename), for
    /// `host_conv::watch`.
    pub fn foregrounds(&self) -> Vec<(Uuid, u32, String)> {
        self.inner
            .lock()
            .expect("sessions lock")
            .iter()
            .filter_map(|(id, entry)| {
                Some((
                    *id,
                    entry.handle.shell_pid()?,
                    entry.handle.control.foreground()?,
                ))
            })
            .collect()
    }

    pub fn cwd_for_binding(&self, binding: SessionBinding) -> Option<Arc<str>> {
        let guard = self.inner.lock().expect("sessions lock");
        guard
            .get(&binding.session_id)
            .filter(|entry| entry.generation == binding.generation)
            .map(|entry| Arc::clone(&entry.handle.cwd))
    }

    pub fn lifecycle_snapshot(&self, id: Uuid) -> Option<SessionLifecycleSnapshot> {
        let guard = self.inner.lock().expect("sessions lock");
        guard.get(&id).map(|entry| SessionLifecycleSnapshot {
            binding: SessionBinding::new(id, entry.generation),
            lifecycle: entry.handle.lifecycle(),
        })
    }

    /// Deliver only while the snapshot is still the current generation. The
    /// transition guard prevents remove/replace from linearizing between the
    /// revalidation and the acknowledged worker-owned lifecycle syscall.
    pub async fn shutdown_if_current(
        &self,
        snapshot: &SessionLifecycleSnapshot,
        signal: LifecycleSignal,
    ) -> anyhow::Result<()> {
        let _transition = self
            .lock_generation_transition(snapshot.binding.session_id())
            .await;
        if !self.is_current(snapshot.binding) {
            anyhow::bail!("stale session lifecycle generation");
        }
        snapshot.lifecycle.shutdown(signal).await
    }

    /// Snapshot the per-session forwarder controls so a WS connection can
    /// install/clear sinks across all known sessions at once.
    pub fn snapshot_controls(&self) -> Vec<(Uuid, ForwarderControl)> {
        self.inner
            .lock()
            .expect("sessions lock")
            .iter()
            .map(|(id, entry)| (*id, entry.handle.control.clone()))
            .collect()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::pty::{self, WorkerHandleParts};
    use std::path::PathBuf;
    use tokio::net::UnixListener;
    use tokio::sync::mpsc;

    fn test_handle(session_id: Uuid, lifecycle_socket: PathBuf) -> SessionHandle {
        let (cmd_tx, _cmd_rx) = mpsc::channel(pty::WORKER_COMMAND_QUEUE_DEPTH);
        let (outbox_tx, _outbox_rx) = mpsc::channel(pty::WORKER_OUTPUT_QUEUE_DEPTH);
        SessionHandle::new_worker(WorkerHandleParts {
            session_id,
            cwd: "/".into(),
            cmd_tx,
            lifecycle: SessionLifecycle::new(lifecycle_socket, Uuid::new_v4()),
            alive: Arc::new(AtomicBool::new(true)),
            cols: 80,
            rows: 24,
            outbox_tx,
            control: ForwarderControl::new(),
        })
    }

    #[tokio::test]
    async fn removed_or_replaced_snapshot_cannot_reach_new_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let session_id = Uuid::new_v4();
        let lifecycle_socket = dir.path().join("session.lifecycle.sock");
        let registry = SessionRegistry::new();

        let old_generation = registry.insert(test_handle(session_id, lifecycle_socket.clone()));
        let old = registry
            .lifecycle_snapshot(session_id)
            .expect("old atomic snapshot");
        assert_eq!(old.binding().generation(), old_generation);

        registry
            .remove_if_generation(session_id, old_generation)
            .expect("remove old generation");
        let new_generation = registry.insert(test_handle(session_id, lifecycle_socket.clone()));
        assert_ne!(new_generation, old_generation);

        // A replacement worker may already own the same filesystem path. The
        // stale registry snapshot must fail before opening that endpoint.
        let listener = UnixListener::bind(&lifecycle_socket).unwrap();
        let error = registry
            .shutdown_if_current(&old, LifecycleSignal::Kill)
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("stale session lifecycle generation"));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );

        let removed = registry
            .remove_if_generation(session_id, new_generation)
            .expect("remove replacement");
        drop(removed);
        let removed_error = registry
            .shutdown_if_current(&old, LifecycleSignal::Term)
            .await
            .unwrap_err();
        assert!(removed_error
            .to_string()
            .contains("stale session lifecycle generation"));
    }
}
