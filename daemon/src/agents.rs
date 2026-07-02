//! In-memory registry of agents owned by this daemon process. The server
//! holds the durable view; we use this map only to route inbound frames to
//! the right PTY and to enumerate `existing_agents` on (re)connect.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use uuid::Uuid;

use crate::pty::{AgentHandle, ForwarderControl};

#[derive(Default, Clone)]
pub struct AgentRegistry {
    inner: Arc<Mutex<HashMap<Uuid, RegistryEntry>>>,
    generation: Arc<AtomicU64>,
    /// One-shot guard for "have we already scanned tmux for orphaned sessions
    /// from a previous daemon process this lifetime?". The first WS session
    /// of the process triggers discovery; reconnects skip.
    discovery_done: Arc<AtomicBool>,
    /// Serializes lazy reattach: concurrent snapshot bursts and inbound stdin
    /// both attach on demand, and racing attaches displace each other's
    /// handles in `insert`, orphaning a live `tmux attach` pipeline (and its
    /// PTY fds) until the session dies.
    attach_lock: Arc<tokio::sync::Mutex<()>>,
}

struct RegistryEntry {
    generation: u64,
    handle: AgentHandle,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns true the first time it's called per process. Subsequent calls
    /// return false. Used to gate one-shot tmux discovery.
    pub fn claim_discovery(&self) -> bool {
        !self.discovery_done.swap(true, Ordering::SeqCst)
    }

    /// Guard held for the duration of a lazy reattach (tmux lookup + attach).
    pub async fn lock_attach(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.attach_lock.lock().await
    }

    pub fn contains(&self, id: Uuid) -> bool {
        self.inner.lock().expect("agents lock").contains_key(&id)
    }

    pub fn insert(&self, handle: AgentHandle) -> u64 {
        let id = handle.agent_id;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.inner
            .lock()
            .expect("agents lock")
            .insert(id, RegistryEntry { generation, handle });
        generation
    }

    pub fn remove(&self, id: Uuid) -> Option<AgentHandle> {
        self.inner
            .lock()
            .expect("agents lock")
            .remove(&id)
            .map(|entry| entry.handle)
    }

    pub fn remove_if_generation(&self, id: Uuid, generation: u64) -> Option<AgentHandle> {
        let mut guard = self.inner.lock().expect("agents lock");
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
            .expect("agents lock")
            .keys()
            .copied()
            .collect()
    }

    /// Apply `f` to the handle if it exists. Returns whether it was found.
    pub fn with_handle<F: FnOnce(&AgentHandle)>(&self, id: Uuid, f: F) -> bool {
        let guard = self.inner.lock().expect("agents lock");
        if let Some(entry) = guard.get(&id) {
            f(&entry.handle);
            true
        } else {
            false
        }
    }

    pub fn session_for(&self, id: Uuid) -> Option<String> {
        let guard = self.inner.lock().expect("agents lock");
        guard.get(&id).and_then(|entry| entry.handle.session().ok())
    }

    pub fn update_session(&self, id: Uuid, next: String) -> bool {
        let guard = self.inner.lock().expect("agents lock");
        if let Some(entry) = guard.get(&id) {
            if let Err(e) = entry.handle.set_session(next) {
                tracing::warn!(%id, error = %e, "updating agent tmux session failed");
            }
            true
        } else {
            false
        }
    }

    pub fn control_for(&self, id: Uuid) -> Option<ForwarderControl> {
        let guard = self.inner.lock().expect("agents lock");
        guard.get(&id).map(|entry| entry.handle.control.clone())
    }

    /// Snapshot the per-agent forwarder controls so a WS session can
    /// install/clear sinks across all known agents at once.
    pub fn snapshot_controls(&self) -> Vec<(Uuid, ForwarderControl)> {
        self.inner
            .lock()
            .expect("agents lock")
            .iter()
            .map(|(id, entry)| (*id, entry.handle.control.clone()))
            .collect()
    }
}
