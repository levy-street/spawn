//! One bounded, detached filesystem worker. The pending reply belongs to this
//! owner, not to a caller's future: cancellation cannot abandon a job and admit
//! another. A stuck standard thread is never joined by Tokio at shutdown.
use std::{
    any::Any,
    sync::{mpsc, Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    sync::{oneshot, Mutex as AsyncMutex},
    time::Instant,
};

type Value = Box<dyn Any + Send>;
pub(crate) struct State {
    pub flight: Option<(Instant, crate::support_store::Flight)>,
}
type Job = Box<dyn FnOnce(&mut State) -> Value + Send>;
struct Request {
    job: Job,
    reply: oneshot::Sender<Value>,
}
struct Pending {
    reply: oneshot::Receiver<Value>,
}
pub(crate) struct Worker {
    tx: mpsc::SyncSender<Request>,
    pending: AsyncMutex<Option<Pending>>,
    running: Arc<Mutex<Option<Instant>>>,
}
static WORKER: OnceLock<Option<Arc<Worker>>> = OnceLock::new();
pub(crate) const IO_DEADLINE: Duration = Duration::from_secs(2);

impl Worker {
    pub(crate) fn process() -> Option<Arc<Self>> {
        WORKER.get_or_init(Self::start).clone()
    }
    pub(crate) fn start() -> Option<Arc<Self>> {
        let (tx, rx) = mpsc::sync_channel::<Request>(1);
        let running = Arc::new(Mutex::new(None));
        let state = Arc::clone(&running);
        std::thread::Builder::new()
            .name("spawnd-support-io".into())
            .spawn(move || {
                let mut owned = State { flight: None };
                while let Ok(request) = rx.recv() {
                    if owned
                        .flight
                        .as_ref()
                        .is_some_and(|(deadline, _)| Instant::now() >= *deadline)
                    {
                        owned.flight = None;
                    }
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        (request.job)(&mut owned)
                    }));
                    *state.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    match result {
                        Ok(value) => {
                            let _ = request.reply.send(value);
                        }
                        Err(_) => break,
                    }
                }
            })
            .ok()?;
        Some(Arc::new(Self {
            tx,
            pending: AsyncMutex::new(None),
            running,
        }))
    }
    pub(crate) fn overdue(&self) -> bool {
        // Dispatch never waits for the worker's short bookkeeping section.
        self.running.try_lock().map_or(true, |running| {
            running.is_some_and(|deadline| Instant::now() >= deadline)
        })
    }
    fn enqueue<T: Send + 'static>(
        &self,
        pending: &mut Option<Pending>,
        deadline: Instant,
        job: impl FnOnce(&mut State) -> T + Send + 'static,
    ) -> Result<(), ()> {
        // A completed, abandoned result is destroyed here, off dispatch. Keep
        // an unfinished reply even when its original caller has gone away.
        if let Some(old) = pending.as_mut() {
            match old.reply.try_recv() {
                Ok(_) => *pending = None,
                Err(oneshot::error::TryRecvError::Empty) => return Err(()),
                Err(oneshot::error::TryRecvError::Closed) => return Err(()),
            }
        }
        if Instant::now() >= deadline {
            return Err(());
        }
        let (reply, rx) = oneshot::channel();
        *self.running.lock().unwrap_or_else(|e| e.into_inner()) = Some(deadline);
        self.tx
            .try_send(Request {
                job: Box::new(move |state| Box::new(job(state))),
                reply,
            })
            .map_err(|_| ())?;
        *pending = Some(Pending { reply: rx });
        Ok(())
    }
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        deadline: Instant,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, ()> {
        self.run_with(deadline, move |_| job()).await
    }
    pub(crate) async fn run_with<T: Send + 'static>(
        &self,
        deadline: Instant,
        job: impl FnOnce(&mut State) -> T + Send + 'static,
    ) -> Result<T, ()> {
        let mut pending = tokio::time::timeout_at(deadline, self.pending.lock())
            .await
            .map_err(|_| ())?;
        self.enqueue(&mut pending, deadline, job)?;
        let value = tokio::time::timeout_at(deadline, &mut pending.as_mut().unwrap().reply)
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        *pending = None;
        value.downcast::<T>().map(|v| *v).map_err(|_| ())
    }
    // Synchronous CLI cleanup has the same bounded worker and pending owner.
    // No support filesystem operation executes on the command's thread.
    pub(crate) fn run_sync<T: Send + 'static>(
        &self,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, ()> {
        let mut pending = self.pending.try_lock().map_err(|_| ())?;
        let deadline = Instant::now() + IO_DEADLINE;
        self.enqueue(&mut pending, deadline, move |_| job())?;
        loop {
            match pending.as_mut().unwrap().reply.try_recv() {
                Ok(value) => {
                    *pending = None;
                    return value.downcast::<T>().map(|v| *v).map_err(|_| ());
                }
                Err(oneshot::error::TryRecvError::Closed) => return Err(()),
                Err(oneshot::error::TryRecvError::Empty) => {}
            }
            if Instant::now() >= deadline {
                return Err(());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
