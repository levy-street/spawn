"""Private disk storage, outside the checkout and database backup boundary.

Directory flock coordinates publication/deletion across workers without holding
SQLite transactions over disk work. All filesystem jobs run off the event loop.
"""

from __future__ import annotations

import asyncio
import errno
import logging
import os
import re
import stat
import sys
import tempfile
import threading
import uuid
from concurrent.futures import Future
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from time import monotonic

try:
    import fcntl
except ImportError:
    fcntl = None

from .config import get_settings
from .support_consent import canonical_uuid

log = logging.getLogger("spawn.support_log")


STORE_ATTRIBUTE = "user.spawnd.support-log-store"
STORE_VERSION = b"v1"
READY_PIPE = ".server-ready"
UUID_NAME = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
STORE_FILE = re.compile(rf"(?:{UUID_NAME}\.ndjson|\.upload-{UUID_NAME}\.tmp)")


def _verify_identity(fd):
    if os.getxattr(fd, STORE_ATTRIBUTE) != STORE_VERSION:
        raise OSError("Unrecognized support store")
    if stat.S_IMODE(os.fstat(fd).st_mode) != 0o700:
        raise OSError("Support store must be private")


def checkout_root() -> Path:
    # Resolve only when configured storage is initialized.
    return Path(__file__).resolve().parents[2]


def _lock_directory(root: Path, flags: int, *, parent=None) -> int:
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        fcntl.flock(fd, flags)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _try_store_lock(parent):
    try:
        fd = _lock_directory(".", fcntl.LOCK_EX | fcntl.LOCK_NB, parent=parent)
    except BlockingIOError:
        return None
    try:
        _verify_identity(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _unlink(name, dir_fd):
    if not STORE_FILE.fullmatch(name):
        raise ValueError("Unrecognized support file name")
    try:
        os.unlink(name, dir_fd=dir_fd)
    except FileNotFoundError:
        pass


def _remove_committed(parent, ids, deadline, stopping):
    # Both descriptors belong to this worker, even if a syscall outlasts shutdown.
    try:
        if stopping.is_set():
            return
        if monotonic() >= deadline:
            raise TimeoutError
        fd = _try_store_lock(parent)
    finally:
        os.close(parent)
    if fd is None:
        raise BlockingIOError("Support store is busy")
    try:
        for record_id in ids:
            if stopping.is_set():
                break
            if monotonic() >= deadline:
                raise TimeoutError
            try:
                canonical_uuid(record_id)
                _unlink(f"{record_id}.ndjson", fd)
            except Exception:
                log.error("SPAWN D support log file cleanup failed; sweep will retry")
    finally:
        os.close(fd)


async def finish_job(awaitable):
    """Do not abandon an in-flight disk write or its database finalization."""
    task = asyncio.ensure_future(awaitable)
    cancelled = None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as exc:
            cancelled = exc
    result = task.result()
    if cancelled is not None:
        raise cancelled
    return result


class SupportLogFiles:
    def __init__(self, root: Path):
        self.root = root
        self._entries = None
        self.cleanup_tasks: set[asyncio.Future] = set()
        self.cleanup_stopping = threading.Event()
        self._cleanup_thread: threading.Thread | None = None
        self.ready_reader = None
        self.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def path(self, record_id: str) -> Path:
        canonical_uuid(record_id)
        return self.root / f"{record_id}.ndjson"

    def _try_lock(self):
        parent = self.fd
        if parent is None:
            raise OSError("Support store is closed")
        return _try_store_lock(parent)

    @asynccontextmanager
    async def locked(self, stop=None):
        fd = None
        try:
            while fd is None:
                if stop is not None and stop.is_set():
                    yield False
                    return
                # Nonblocking flock; no worker thread waits for another request.
                attempt = asyncio.create_task(asyncio.to_thread(self._try_lock))
                try:
                    fd = await asyncio.shield(attempt)
                except asyncio.CancelledError:
                    # The thread may already hold the lock: retrieve and close it.
                    fd = await attempt
                    raise
                if fd is None:
                    if stop is None:
                        await asyncio.sleep(0.01)
                    else:
                        try:
                            await asyncio.wait_for(stop.wait(), timeout=0.01)
                        except TimeoutError:
                            pass
            yield True
        finally:
            if fd is not None:
                os.close(fd)

    def write(self, record_id: str, body: bytes):
        destination = self.path(record_id).name
        temporary = f".upload-{uuid.uuid4()}.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination, src_dir_fd=self.fd, dst_dir_fd=self.fd)
        finally:
            self.unlink(temporary)

    def remove(self, record_id: str, *, dir_fd=None):
        self.unlink(self.path(record_id).name, dir_fd=dir_fd)

    def submit_cleanup(self, ids, seconds):
        # Only the event loop submits. The job outlives a timed-out waiter.
        if self.cleanup_stopping.is_set() or (
            self._cleanup_thread is not None and self._cleanup_thread.is_alive()
        ):
            return None
        deadline = monotonic() + seconds
        job = Future()
        job.set_running_or_notify_cancel()
        waiter = asyncio.wrap_future(job)
        parent = os.dup(self.fd)

        def run():
            try:
                _remove_committed(parent, ids, deadline, self.cleanup_stopping)
            except BaseException as exc:
                job.set_exception(exc)
            else:
                job.set_result(None)

        try:
            thread = threading.Thread(target=run, name="support-log-cleanup", daemon=True)
            thread.start()
        except BaseException:
            os.close(parent)
            raise
        self._cleanup_thread = thread
        return waiter

    def unlink(self, name, *, dir_fd=None):
        _unlink(name, self.fd if dir_fd is None else dir_fd)

    def read(self, record_id, limit):
        fd = os.open(
            self.path(record_id).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=self.fd,
        )
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise OSError("Expected a regular bundle file")
            return stream.read(limit + 1)

    def old_entries(self, cutoff: float, limit: int):
        # Keep the iterator between passes so fresh entries cannot starve old ones.
        if self._entries is None:
            self._entries = os.scandir(self.fd)
        result = []
        for _ in range(limit):
            entry = next(self._entries, None)
            if entry is None:
                self._entries.close()
                self._entries = None
                break
            if not STORE_FILE.fullmatch(entry.name):
                continue
            try:
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISDIR(info.st_mode) and info.st_mtime < cutoff:
                    result.append(entry.name)
            except FileNotFoundError:
                pass
        return result

    def close(self):
        self.cleanup_stopping.set()
        if self.ready_reader is not None:
            self.ready_reader.close()
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self._entries is not None:
            self._entries.close()
            self._entries = None


def _write_probe(fd):
    # Probe writes only after verifying or establishing the identity.
    name = f".upload-{uuid.uuid4()}.tmp"
    probe = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=fd)
    os.close(probe)
    os.unlink(name, dir_fd=fd)


def _probe(root: Path):
    fd = _lock_directory(root, fcntl.LOCK_EX)
    try:
        try:
            _verify_identity(fd)
        except OSError as exc:
            with os.scandir(fd) as entries:
                if exc.errno != errno.ENODATA or next(entries, None) is not None:
                    raise
            os.fchmod(fd, 0o700)
            os.setxattr(fd, STORE_ATTRIBUTE, STORE_VERSION, os.XATTR_CREATE)
        _write_probe(fd)
    finally:
        os.close(fd)


def _store_root(directory):
    if fcntl is None or not hasattr(os, "getxattr"):
        raise OSError("Support storage requires file locks and directory attributes")
    path = Path(directory)
    root = path.resolve()
    if not path.is_absolute() or path.is_symlink() or root.is_relative_to(checkout_root()):
        raise OSError("Support directory must be absolute and outside checkout")
    return root


def _store(directory: str) -> SupportLogFiles:
    root = _store_root(directory)
    if not root.exists():
        root.parent.mkdir(parents=True, exist_ok=True)
        # Probe a new directory before publishing it at the configured path.
        with tempfile.TemporaryDirectory(prefix=".support-", dir=root.parent) as temp:
            _probe(Path(temp))
            # Two starting workers must never replace each other's directory.
            parent = _lock_directory(root.parent, fcntl.LOCK_EX)
            try:
                if not root.exists():
                    os.rename(temp, root)
                    return SupportLogFiles(root)
            finally:
                os.close(parent)
    _probe(root)
    return SupportLogFiles(root)


def _uses_sansio(argv: list[str]) -> bool:
    try:
        from click.core import ParameterSource
        from uvicorn import main as uvicorn_cli

        # Distinguish an explicit option from an environment default or another option's value.
        with uvicorn_cli.make_context("uvicorn", argv.copy(), resilient_parsing=True) as ctx:
            return (
                ctx.get_parameter_source("ws") is ParameterSource.COMMANDLINE
                and ctx.params.get("ws") == "websockets-sansio"
            )
    except Exception:
        return False


def _open_ready_pipe(parent, flags):
    fd = os.open(READY_PIPE, flags | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
    try:
        if not stat.S_ISFIFO(os.fstat(fd).st_mode):
            raise OSError("Expected a support readiness pipe")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _prepare_server_store(directory):
    store = _store(directory)
    try:
        with suppress(FileExistsError):
            os.mkfifo(READY_PIPE, 0o600, dir_fd=store.fd)
        store.ready_reader = os.fdopen(_open_ready_pipe(store.fd, os.O_RDONLY), "rb", buffering=0)
        return store
    except BaseException:
        store.close()
        raise


async def prepare_store() -> SupportLogFiles | None:
    directory = get_settings().support_log_dir
    if not directory:
        return None
    if not _uses_sansio(sys.argv[1:]):
        log.error("SPAWN D support logs require --ws websockets-sansio")
        return None
    log.info("Checking support log storage")
    try:
        return await finish_job(asyncio.to_thread(_prepare_server_store, directory))
    except Exception:
        log.error("SPAWN D support log storage is unusable; sharing storage is off")
        return None


def open_existing_store(*, probe_write=False):
    directory = get_settings().support_log_dir
    if not directory:
        raise OSError("Support log storage is not configured or usable.")
    store = SupportLogFiles(_store_root(directory))
    try:
        _verify_identity(store.fd)
        # A nonblocking writer can open the FIFO only while a ready server holds its reader.
        os.close(_open_ready_pipe(store.fd, os.O_WRONLY))
        if probe_write:
            fcntl.flock(store.fd, fcntl.LOCK_EX)
            try:
                _verify_identity(store.fd)
                _write_probe(store.fd)
            finally:
                fcntl.flock(store.fd, fcntl.LOCK_UN)
        return store
    except BaseException:
        store.close()
        raise


def get_store(app) -> SupportLogFiles | None:
    return getattr(app.state, "support_log_store", None)


async def file_status(record, store) -> str:
    if record.state != "collected":
        return "not_collected"
    if store is None:
        return "unavailable"
    try:
        info = await asyncio.to_thread(store.path(record.id).lstat)
        return "present" if stat.S_ISREG(info.st_mode) else "missing"
    except FileNotFoundError:
        return "missing"
