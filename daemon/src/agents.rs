//! In-memory registry of agents owned by this daemon process. The server
//! holds the durable view; we use this map only to route inbound frames to
//! the right PTY and to enumerate `existing_agents` on (re)connect.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use uuid::Uuid;

use crate::pty::{AgentHandle, ForwarderControl};

#[derive(Default, Clone)]
pub struct AgentRegistry {
    inner: Arc<Mutex<HashMap<Uuid, AgentHandle>>>,
    /// One-shot guard for "have we already scanned tmux for orphaned sessions
    /// from a previous daemon process this lifetime?". The first WS session
    /// of the process triggers discovery; reconnects skip.
    discovery_done: Arc<AtomicBool>,
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

    pub fn contains(&self, id: Uuid) -> bool {
        self.inner.lock().expect("agents lock").contains_key(&id)
    }

    pub fn insert(&self, handle: AgentHandle) {
        let id = handle.agent_id;
        self.inner.lock().expect("agents lock").insert(id, handle);
    }

    pub fn remove(&self, id: Uuid) -> Option<AgentHandle> {
        self.inner.lock().expect("agents lock").remove(&id)
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
        if let Some(h) = guard.get(&id) {
            f(h);
            true
        } else {
            false
        }
    }

    /// Snapshot the per-agent forwarder controls so a WS session can
    /// install/clear sinks across all known agents at once.
    pub fn snapshot_controls(&self) -> Vec<(Uuid, ForwarderControl)> {
        self.inner
            .lock()
            .expect("agents lock")
            .iter()
            .map(|(id, h)| (*id, h.control.clone()))
            .collect()
    }
}
