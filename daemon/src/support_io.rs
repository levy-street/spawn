//! One detached support I/O thread. Callers await each job to completion or
//! its deadline. A timed-out job still owns the thread; no job queues behind it.
use std::{
    any::Any,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, OnceLock,
    },
    time::Duration,
};
use tokio::{sync::oneshot, time::Instant};

type Value = Box<dyn Any + Send>;
pub(crate) struct State {
    pub flight: Option<(Instant, crate::support_store::Flight)>,
    pub control_budget: crate::support_store::ControlBudget,
}
struct Request {
    job: Box<dyn FnOnce(&mut State) -> Value + Send>,
    reply: oneshot::Sender<Value>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    ExpiredBeforeSubmission,
    Busy,
    Deadline,
    Stopped,
}
pub(crate) struct Worker {
    tx: mpsc::SyncSender<Request>,
    busy: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
}
static WORKER: OnceLock<Option<Arc<Worker>>> = OnceLock::new();
#[cfg(not(test))]
pub(crate) const IO_DEADLINE: Duration = Duration::from_secs(3);
#[cfg(test)]
pub(crate) const IO_DEADLINE: Duration = Duration::from_secs(15);

impl Worker {
    pub(crate) fn process() -> Option<Arc<Self>> {
        WORKER.get_or_init(Self::start).clone()
    }
    pub(crate) fn start() -> Option<Arc<Self>> {
        let (tx, rx) = mpsc::sync_channel::<Request>(1);
        let busy = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let (working, dead) = (Arc::clone(&busy), Arc::clone(&stopped));
        std::thread::Builder::new()
            .name("spawnd-support-io".into())
            .spawn(move || {
                let mut state = State {
                    flight: None,
                    control_budget: Default::default(),
                };
                loop {
                    // Bounded even in test builds; timeout is idle, disconnect exits.
                    let request = match rx.recv_timeout(Duration::from_secs(1)) {
                        Ok(request) => request,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        (request.job)(&mut state)
                    }));
                    if state
                        .flight
                        .as_ref()
                        .is_some_and(|(end, _)| Instant::now() >= *end)
                    {
                        state.flight = None;
                    }
                    match result {
                        Ok(value) => {
                            working.store(false, Ordering::SeqCst);
                            let _ = request.reply.send(value);
                        }
                        Err(_) => {
                            dead.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
                dead.store(true, Ordering::SeqCst);
            })
            .ok()?;
        Some(Arc::new(Self { tx, busy, stopped }))
    }
    fn enqueue<T: Send + 'static>(
        &self,
        deadline: Instant,
        job: impl FnOnce(&mut State) -> T + Send + 'static,
    ) -> Result<oneshot::Receiver<Value>, Error> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err(Error::Stopped);
        }
        if Instant::now() >= deadline {
            return Err(Error::ExpiredBeforeSubmission);
        }
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(Error::Busy);
        }
        let (reply, rx) = oneshot::channel();
        self.tx
            .try_send(Request {
                job: Box::new(move |state| Box::new(job(state))),
                reply,
            })
            .map_err(|_| Error::Stopped)?;
        Ok(rx)
    }
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        deadline: Instant,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, Error> {
        self.run_with(deadline, move |_| job()).await
    }
    pub(crate) async fn run_with<T: Send + 'static>(
        &self,
        deadline: Instant,
        job: impl FnOnce(&mut State) -> T + Send + 'static,
    ) -> Result<T, Error> {
        let reply = self.enqueue(deadline, job)?;
        let value = tokio::time::timeout_at(deadline, reply)
            .await
            .map_err(|_| Error::Deadline)?
            .map_err(|_| Error::Stopped)?;
        Ok(*value.downcast::<T>().expect("support job result type"))
    }
    pub(crate) fn run_sync<T: Send + 'static>(
        &self,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, Error> {
        let deadline = Instant::now() + IO_DEADLINE;
        let mut reply = self.enqueue(deadline, move |_| job())?;
        loop {
            match reply.try_recv() {
                Ok(value) => return Ok(*value.downcast::<T>().expect("support job result type")),
                Err(oneshot::error::TryRecvError::Closed) => return Err(Error::Stopped),
                Err(oneshot::error::TryRecvError::Empty) => {}
            }
            if Instant::now() >= deadline {
                return Err(Error::Deadline);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
