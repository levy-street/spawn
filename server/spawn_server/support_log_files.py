"""Private disk storage, outside the checkout and database backup boundary.

Directory flock coordinates publication/deletion across workers without holding
SQLite transactions over disk work. All filesystem jobs run off the event loop.
"""

from __future__ import annotations

import asyncio
import logging
import os
import stat
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

try:
    import fcntl
except ImportError:
    fcntl = None

from .config import get_settings
from .support_consent import canonical_uuid

log = logging.getLogger("spawn.support_log")


def checkout_root() -> Path:
    # Resolve only when configured storage is initialized.
    return Path(__file__).resolve().parents[2]


def _lock_directory(root: Path, flags: int) -> int:
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, flags)
    except BaseException:
        os.close(fd)
        raise
    return fd


async def finish_job(awaitable):
    """Do not abandon an in-flight disk write or its database finalization."""
    task = asyncio.ensure_future(awaitable)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        finally:
            raise


class SupportLogFiles:
    def __init__(self, root: Path):
        self.root = root
        self._entries = None

    def path(self, record_id: str) -> Path:
        canonical_uuid(record_id)
        return self.root / f"{record_id}.ndjson"

    def _try_lock(self):
        try:
            return _lock_directory(self.root, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return None

    @asynccontextmanager
    async def locked(self):
        fd = None
        try:
            while fd is None:
                # Nonblocking flock; no worker thread waits for another request.
                attempt = asyncio.create_task(asyncio.to_thread(self._try_lock))
                try:
                    fd = await asyncio.shield(attempt)
                except asyncio.CancelledError:
                    # The thread may already hold the lock: retrieve and close it.
                    fd = await attempt
                    raise
                if fd is None:
                    await asyncio.sleep(0.01)
            yield
        finally:
            if fd is not None:
                os.close(fd)

    def write(self, record_id: str, body: bytes):
        destination = self.path(record_id)
        fd, temporary = tempfile.mkstemp(prefix=".upload-", dir=self.root)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def remove(self, record_id: str):
        self.path(record_id).unlink(missing_ok=True)

    def old_entries(self, cutoff: float, limit: int):
        # Keep the iterator between passes so fresh entries cannot starve old ones.
        if self._entries is None:
            self._entries = os.scandir(self.root)
        result = []
        for _ in range(limit):
            entry = next(self._entries, None)
            if entry is None:
                self._entries.close()
                self._entries = None
                break
            try:
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISDIR(info.st_mode) and info.st_mtime < cutoff:
                    result.append(entry.name)
            except FileNotFoundError:
                pass
        return result

    def close(self):
        if self._entries is not None:
            self._entries.close()
            self._entries = None


def _probe(root: Path):
    if not root.is_dir():
        raise NotADirectoryError
    root.chmod(0o700)
    os.close(_lock_directory(root, fcntl.LOCK_EX))
    fd, path = tempfile.mkstemp(prefix=".probe-", dir=root)
    os.close(fd)
    os.unlink(path)


def _store(directory: str) -> SupportLogFiles:
    if fcntl is None or not all(
        hasattr(os, name) for name in ("O_DIRECTORY", "O_NOFOLLOW", "fchmod")
    ):
        raise OSError("support storage requires Unix file locking and permissions")
    path = Path(directory)
    root = path.resolve()
    if not path.is_absolute() or root.is_relative_to(checkout_root()):
        raise OSError("support directory must be absolute and outside checkout")
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


async def prepare_store() -> SupportLogFiles | None:
    directory = get_settings().support_log_dir
    if not directory:
        return None
    log.info("Checking support log storage")
    try:
        return await finish_job(asyncio.to_thread(_store, directory))
    except Exception:
        log.error("SPAWN D support log storage is unusable; sharing storage is off")
        return None


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
