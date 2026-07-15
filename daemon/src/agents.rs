//! In-memory registry of agents owned by this daemon process. The server
//! holds the durable view; we use this map only to route inbound frames to
//! the right PTY and to enumerate `existing_agents` on (re)connect.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

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
    /// Serializes the linearization point between a concrete backend
    /// generation and RTC peer insertion/teardown for its UUID. The registry
    /// entry itself remains behind the small synchronous lock above; this
    /// async lock is held only across replacement lifecycle awaits.
    generation_transitions: Arc<Mutex<HashMap<Uuid, Weak<AsyncMutex<()>>>>>,
}

struct RegistryEntry {
    generation: u64,
    handle: AgentHandle,
}

/// Immutable identity of one concrete backend registered for an agent UUID.
///
/// Agent UUIDs are reused across restart. RTC callbacks must therefore carry
/// this value and use the bound accessors below instead of resolving by UUID,
/// or a callback from the old peer could act on the replacement backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentBinding {
    agent_id: Uuid,
    generation: u64,
}

impl AgentBinding {
    pub(crate) fn new(agent_id: Uuid, generation: u64) -> Self {
        Self {
            agent_id,
            generation,
        }
    }

    pub fn agent_id(self) -> Uuid {
        self.agent_id
    }

    pub fn generation(self) -> u64 {
        self.generation
    }
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

    /// Lock one agent UUID's backend-generation transition.
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
                .expect("agent generation transitions lock");
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

    pub fn contains(&self, id: Uuid) -> bool {
        self.inner.lock().expect("agents lock").contains_key(&id)
    }

    pub fn binding_for(&self, id: Uuid) -> Option<AgentBinding> {
        self.inner
            .lock()
            .expect("agents lock")
            .get(&id)
            .map(|entry| AgentBinding {
                agent_id: id,
                generation: entry.generation,
            })
    }

    pub fn is_current(&self, binding: AgentBinding) -> bool {
        self.inner
            .lock()
            .expect("agents lock")
            .get(&binding.agent_id)
            .is_some_and(|entry| entry.generation == binding.generation)
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

    /// Apply `f` only when the UUID still resolves to the backend captured in
    /// `binding`. This check and the handle access occur under the same lock.
    pub fn with_bound_handle<F: FnOnce(&AgentHandle)>(&self, binding: AgentBinding, f: F) -> bool {
        let guard = self.inner.lock().expect("agents lock");
        if let Some(entry) = guard
            .get(&binding.agent_id)
            .filter(|entry| entry.generation == binding.generation)
        {
            f(&entry.handle);
            true
        } else {
            false
        }
    }

    pub fn session_for_binding(&self, binding: AgentBinding) -> Option<String> {
        let guard = self.inner.lock().expect("agents lock");
        guard
            .get(&binding.agent_id)
            .filter(|entry| entry.generation == binding.generation)
            .and_then(|entry| entry.handle.session().ok())
    }

    pub fn is_worker_binding(&self, binding: AgentBinding) -> Option<bool> {
        let guard = self.inner.lock().expect("agents lock");
        guard
            .get(&binding.agent_id)
            .filter(|entry| entry.generation == binding.generation)
            .map(|entry| entry.handle.is_worker())
    }

    pub fn control_for_binding(&self, binding: AgentBinding) -> Option<ForwarderControl> {
        let guard = self.inner.lock().expect("agents lock");
        guard
            .get(&binding.agent_id)
            .filter(|entry| entry.generation == binding.generation)
            .map(|entry| entry.handle.control.clone())
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

    /// Whether the agent runs on the worker backend (vs tmux). None when the
    /// agent isn't in the registry.
    pub fn is_worker(&self, id: Uuid) -> Option<bool> {
        let guard = self.inner.lock().expect("agents lock");
        guard.get(&id).map(|entry| entry.handle.is_worker())
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
