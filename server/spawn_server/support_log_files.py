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
from functools import lru_cache
from pathlib import Path

try:
    import fcntl
except ImportError:
    fcntl = None

from .config import get_settings
from .support_consent import canonical_uuid

log = logging.getLogger("spawn.support_log")
PREPARE_SECONDS = 5


def checkout_root() -> Path:
    # Resolve only when configured storage is initialized.
    return Path(__file__).resolve().parents[2]


class StoreUnavailable(Exception):
    pass


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
    def __init__(self, directory: str):
        self.root = Path(directory)
        self.disabled = False
        self.ready = False
        self._entries = None
        self._init_lock = asyncio.Lock()

    @staticmethod
    def _probe(root: Path):
        if not root.is_dir():
            raise NotADirectoryError
        root.chmod(0o700)
        fd, path = tempfile.mkstemp(prefix=".probe-", dir=root)
        os.close(fd)
        os.unlink(path)

    def _prepare(self):
        if fcntl is None or not all(
            hasattr(os, name) for name in ("O_DIRECTORY", "O_NOFOLLOW", "fchmod")
        ):
            raise OSError("support storage requires Unix file locking and permissions")
        root = self.root.resolve()
        if not self.root.is_absolute() or root.is_relative_to(checkout_root()):
            raise OSError("support directory must be absolute and outside checkout")
        if self.disabled:
            raise StoreUnavailable
        if not root.exists():
            root.parent.mkdir(parents=True, exist_ok=True)
            # Probe a new directory before publishing it at the configured path.
            with tempfile.TemporaryDirectory(prefix=".support-", dir=root.parent) as temp:
                self._probe(Path(temp))
                # Two starting workers must never replace each other's directory.
                parent = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    fcntl.flock(parent, fcntl.LOCK_EX)
                    if self.disabled:
                        raise StoreUnavailable
                    if not root.exists():
                        os.rename(temp, root)
                        return root
                finally:
                    os.close(parent)
        self._probe(root)
        return root

    async def prepare(self):
        async with self._init_lock:
            if self.disabled:
                raise StoreUnavailable
            if not self.ready:
                try:
                    # Only the waiting task can publish readiness. A timed-out
                    # filesystem call may still return after startup has continued.
                    async with asyncio.timeout(PREPARE_SECONDS):
                        self.root = await asyncio.to_thread(self._prepare)
                except Exception:
                    self.disabled = True
                    log.error("SPAWN D support log storage is unusable; sharing storage is off")
                    raise StoreUnavailable from None
                self.ready = True

    def path(self, record_id: str) -> Path:
        canonical_uuid(record_id)
        return self.root / f"{record_id}.ndjson"

    def _try_lock(self):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            os.close(fd)
            return None
        except BaseException:
            os.close(fd)
            raise

    @asynccontextmanager
    async def locked(self):
        await self.prepare()
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


@lru_cache(maxsize=8)
def _store(directory: str) -> SupportLogFiles:
    return SupportLogFiles(directory)


def get_store() -> SupportLogFiles | None:
    directory = get_settings().support_log_dir
    if not directory:
        return None
    store = _store(directory)
    return None if store.disabled else store


async def file_status(record) -> str:
    if record.state != "collected":
        return "not_collected"
    store = get_store()
    if store is None:
        return "unavailable"
    try:
        await store.prepare()
        info = await asyncio.to_thread(store.path(record.id).lstat)
        return "present" if stat.S_ISREG(info.st_mode) else "missing"
    except FileNotFoundError:
        return "missing"
    except StoreUnavailable:
        return "unavailable"
