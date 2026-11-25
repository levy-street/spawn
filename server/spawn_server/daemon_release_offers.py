"""Offer a newly active daemon release to daemons that are already connected,
and try again an update that a sleeping or disconnected machine interrupted.

Registration offers the active daemon release to every daemon that registers.
A deploy restarts the server before it switches the prebuilt `current` pointer,
so every daemon re-registers while the previous release is still active, and
nothing else would offer the new one until each daemon's next registration.

This task reads the active release about every 15 seconds. When it changes, it
asks each connected daemon's host, one at a time, through the registration's
own offer function (`ws.daemon._auto_update_after_registration`), and only for
a daemon that has just answered a ping. Nothing existing waits for it or calls
into it; with `daemon_release_offers` off it is never started.

On a poll that makes no such pass, it also tries again an update that
registration recorded as interrupted (issue #170): a host marked updating that
registered again on its old build, typically a laptop that slept or lost its
network during the download. That is done only on a connection the task has
seen registered for six minutes without a break, once per connection, at most
three times per host and release, through a conditional write that clears the
failure only if the row is exactly as read, and then the same offer function.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Iterable

from sqlalchemy import update

from . import release, schemas
from .config import get_settings
from .db import get_sessionmaker
from .models import Host
from .ws import daemon as daemon_ws
from .ws.broker import DaemonConn, get_broker

log = logging.getLogger("spawn.daemon_release_offers")

#: How often the active release is read.
POLL_SECONDS = 15.0
#: The wait between two offers in one pass, so a fleet does not download and
#: restart at once from one small server.
OFFER_GAP_SECONDS = 2.0
#: How long a daemon has to answer the ping sent just before its offer.
PING_SECONDS = 2.0
#: How long the whole ping may take, its send included: the broker's ping
#: limits only the wait for the answer, and a stuck socket could otherwise
#: hold a pass at the send.
PING_LIMIT_SECONDS = 3.0

#: What registration's activation write (`_prepare_host_activation` in
#: `ws/daemon.py`) stores when a host it had marked updating registers again on
#: another build than the one offered. That is the only place this text is
#: written, and it is written whether or not any update result arrived, so it
#: is the one failure this task tries again. Any other text is a failure the
#: daemon or the server reported, and stays for the owner.
INTERRUPTED_UPDATE_ERROR = "restarted on the previous binary"
#: How long the task must have seen a connection registered, without a break,
#: before it tries an interrupted update again on it. Six minutes is longer
#: than the daemon's own five-minute limit on a download (`DOWNLOAD_TIMEOUT` in
#: `daemon/src/update.rs`), so the download of an earlier attempt on that
#: machine has ended by then, and far longer than a sleeping laptop's brief
#: wake. That limit covers the download only: the two manifest fetches before
#: it have a five-minute request limit each. A retry that still finds an
#: attempt running is refused by the daemon as busy, which is stored as that
#: failure and not tried again.
RETRY_AFTER_SECONDS = 6 * 60.0
#: Retries per host per release. The count is kept in memory, so a server
#: restart forgets it. That is acceptable: it is a backstop against a loop
#: within one process's life (a machine interrupted every time, or a real
#: failure whose report never arrives), a restart is rare and allows at most
#: this many more, and each retry still needs six minutes on one connection
#: and an answered ping.
RETRIES_PER_RELEASE = 3

#: What names one daemon release: its daemon tree and its release counter.
#: Hosts compare trees; the counter tells a re-release of an older tree apart.
ReleaseIdentity = tuple[str, int | None]


def release_identity(manifest: schemas.DaemonReleaseOut) -> ReleaseIdentity:
    return (manifest.tree, manifest.release_counter)


async def read_active_release() -> schemas.DaemonReleaseOut | None:
    # The first read of a new release hashes every binary it lists, so it is
    # kept off the event loop. Later reads hit the hash cache.
    return await asyncio.to_thread(release.read_prebuilt_manifest)


class DaemonReleaseOffers:
    def __init__(
        self,
        *,
        read_manifest: Callable[[], Awaitable[schemas.DaemonReleaseOut | None]] = (
            read_active_release
        ),
        pause: Callable[[float], Awaitable[None]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._read_manifest = read_manifest
        self._pause = pause or self._wait
        self._clock = clock
        self._stop = asyncio.Event()
        self._started = False
        self._current: ReleaseIdentity | None = None
        self._seen: set[ReleaseIdentity] = set()
        self._highest_counter: int | None = None
        # Connection ids seen by the previous poll, and those still owed the
        # current release because they were new when it was first seen.
        self._previous: set[str] = set()
        self._owed: set[str] = set()
        # When each connection the last poll saw was first seen, and those
        # already used for a retry. A connection is forgotten as soon as a poll
        # no longer sees it, so one that drops and returns starts again.
        self._first_seen: dict[str, float] = {}
        self._retried: set[str] = set()
        # Retries made per host and release, for the life of this process.
        self._retries: dict[tuple[str, ReleaseIdentity], int] = {}

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def stop(self) -> None:
        self._stop.set()

    async def _wait(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except TimeoutError:
            pass

    async def run(self) -> None:
        while not self.stopping:
            try:
                await self.poll_once()
            except Exception as exc:
                log.error("daemon release offer poll failed: %s", type(exc).__name__)
            if not self.stopping:
                await self._pause(POLL_SECONDS)

    async def poll_once(self) -> None:
        manifest = await self._read_manifest()
        # Taken after the read: a daemon that becomes routable later reads this
        # release, or a newer one, at its own registration.
        connections = {conn.id: conn for conn in get_broker().daemons()}
        # Registration makes its own offer just after its connection becomes
        # routable, and that offer reads the host and writes it in two steps.
        # Only a connection already seen by the previous poll is offered to, so
        # this task never runs inside that window.
        settled = [conn for conn_id, conn in connections.items() if conn_id in self._previous]
        self._previous = set(connections)
        self._track(connections)
        if not self._started:
            # Startup: registration offers to every daemon from here on.
            self._started = True
            if manifest is not None:
                self._remember(release_identity(manifest))
            return
        if manifest is None or self.stopping:
            return
        identity = release_identity(manifest)
        if identity == self._current:
            owed = [conn for conn in settled if conn.id in self._owed]
            self._owed.clear()
            if owed:
                await self._offer_pass(owed, manifest)
                return
            # Only on a poll that made no release pass, so a retry never runs
            # beside one, and a whole poll interval follows that pass's offers.
            await self._retry_pass(list(connections.values()), manifest, identity)
            return
        self._owed.clear()
        already = identity in self._seen or self._older(identity)
        self._remember(identity)
        if already:
            log.info("daemon release changed to one already seen or older; nothing offered")
            return
        self._owed = set(connections) - {conn.id for conn in settled}
        await self._offer_pass(settled, manifest)

    def _track(self, connection_ids: Iterable[str]) -> None:
        now = self._clock()
        self._first_seen = {
            conn_id: self._first_seen.get(conn_id, now) for conn_id in connection_ids
        }
        self._retried.intersection_update(self._first_seen)

    def _remember(self, identity: ReleaseIdentity) -> None:
        self._current = identity
        self._seen.add(identity)
        counter = identity[1]
        if counter is not None and (
            self._highest_counter is None or counter > self._highest_counter
        ):
            self._highest_counter = counter

    def _older(self, identity: ReleaseIdentity) -> bool:
        counter = identity[1]
        return (
            counter is not None
            and self._highest_counter is not None
            and counter < self._highest_counter
        )

    async def _offer_pass(
        self, connections: list[DaemonConn], manifest: schemas.DaemonReleaseOut
    ) -> None:
        # `tried` counts hosts handed to the offer function. That function does
        # not say whether it sent; a send the socket did not take is recorded
        # by it as failed, as at registration.
        considered = tried = 0
        for conn in connections:
            if self.stopping:
                break
            considered += 1
            try:
                if not await self._due(conn, manifest):
                    continue
                if tried:
                    await self._pause(OFFER_GAP_SECONDS)
                    if self.stopping:
                        break
                    if not await self._due(conn, manifest):
                        continue
                if not await self._answers(conn) or self.stopping:
                    continue
                tried += 1
                await daemon_ws._auto_update_after_registration(conn)
            except Exception as exc:
                log.error("daemon release offer to one host failed: %s", type(exc).__name__)
        log.info(
            "daemon release offer pass: %d connections considered, %d tried",
            considered,
            tried,
        )

    async def _due(self, conn: DaemonConn, manifest: schemas.DaemonReleaseOut) -> bool:
        """Whether the registration's ordinary offer would go to this host now.

        The same gate the offer function applies, read in a short session of
        its own, so the pass pings, waits for and counts only hosts it would
        hand to that function. A host whose worker pair is mismatched is left
        to registration: the function repairs such a host whatever its update
        state, and a second offer while the first is still running is refused
        by the daemon as busy and stored as a failure for the new release. A
        host marked updating is left alone however long ago that began: the
        function stops counting an update as running after three minutes, and
        a daemon still busy with it would refuse the new release, which would
        then be stored as failed. Registration settles that mark when the host
        next connects.
        """
        broker = get_broker()
        if broker.get_daemon_for_host(conn.host_id) is not conn:
            return False
        if not get_settings().daemon_auto_update:
            return False
        async with get_sessionmaker()() as session:
            host = await session.get(Host, conn.host_id)
        if host is None or host.worker_mismatch or host.update_state == "updating":
            return False
        if release.host_update_state(host, manifest).state != "available":
            return False
        return broker.get_daemon_for_host(conn.host_id) is conn

    async def _answers(self, conn: DaemonConn) -> bool:
        """Whether this daemon answers a ping now, on the same connection.

        A send into a connection that is already dead can still succeed. The
        host would be marked updating, and when it came back on its old build
        that release would be stored as failed for it. A daemon that does not
        answer, within `PING_LIMIT_SECONDS` for the whole ping, is offered
        nothing and its host is not written; its next registration offers the
        release instead. This does not cover a daemon that answers and then
        loses its machine or network during the download; `_retry_pass` is
        for that case (issue #170).
        """
        broker = get_broker()
        try:
            async with asyncio.timeout(PING_LIMIT_SECONDS):
                answered = await broker.request_host_ping(conn, timeout=PING_SECONDS)
        except TimeoutError:
            return False
        if not answered:
            return False
        return broker.get_daemon_for_host(conn.host_id) is conn

    async def _retry_pass(
        self,
        connections: list[DaemonConn],
        manifest: schemas.DaemonReleaseOut,
        identity: ReleaseIdentity,
    ) -> None:
        """Try again an update that registration recorded as interrupted.

        Only on a connection seen for `RETRY_AFTER_SECONDS` without a break,
        once per connection (whatever the outcome, from the ping on), and at
        most `RETRIES_PER_RELEASE` times per host and release. One host at a
        time, with the release pass's gap between two hosts pinged.
        """
        now = self._clock()
        attempted = 0
        for conn in connections:
            if self.stopping:
                break
            first_seen = self._first_seen.get(conn.id)
            if (
                conn.id in self._retried
                or first_seen is None
                or now - first_seen < RETRY_AFTER_SECONDS
                or self._retries.get((conn.host_id, identity), 0) >= RETRIES_PER_RELEASE
            ):
                continue
            try:
                daemon_tree = await self._interrupted(conn, manifest)
                if daemon_tree is None:
                    continue
                if attempted:
                    await self._pause(OFFER_GAP_SECONDS)
                    if self.stopping:
                        break
                    daemon_tree = await self._interrupted(conn, manifest)
                    if daemon_tree is None:
                        continue
                attempted += 1
                self._retried.add(conn.id)
                await self._retry(conn, manifest, identity, daemon_tree)
            except Exception as exc:
                log.error("daemon update retry for one host failed: %s", type(exc).__name__)

    async def _retry(
        self,
        conn: DaemonConn,
        manifest: schemas.DaemonReleaseOut,
        identity: ReleaseIdentity,
        daemon_tree: str,
    ) -> None:
        if not await self._answers(conn):
            log.info("daemon update retry: no answer to the ping; nothing written")
            return
        if self.stopping:
            return
        if not await self._clear_interrupted(conn, manifest, daemon_tree):
            log.info("daemon update retry: the host changed first; nothing written")
            return
        key = (conn.host_id, identity)
        count = self._retries[key] = self._retries.get(key, 0) + 1
        if get_broker().get_daemon_for_host(conn.host_id) is not conn:
            # Replaced since the write. The host now reads as available, so the
            # replacement's registration makes the offer.
            log.info(
                "daemon update retry %d of %d: failure cleared; the daemon reconnected, "
                "so its registration makes the offer",
                count,
                RETRIES_PER_RELEASE,
            )
            return
        log.info(
            "daemon update retry %d of %d: failure cleared; handed to the offer function",
            count,
            RETRIES_PER_RELEASE,
        )
        await daemon_ws._auto_update_after_registration(conn)

    async def _interrupted(
        self, conn: DaemonConn, manifest: schemas.DaemonReleaseOut
    ) -> str | None:
        """The daemon tree of this connection's host, if it may be retried now.

        That is a host whose update to the active release registration
        recorded as interrupted on this very connection, that is still behind
        the release, can update itself and has no mismatched worker pair, with
        automatic updates on. Read in a short session of its own, as `_due`.
        """
        broker = get_broker()
        if broker.get_daemon_for_host(conn.host_id) is not conn:
            return None
        if not get_settings().daemon_auto_update:
            return None
        async with get_sessionmaker()() as session:
            host = await session.get(Host, conn.host_id)
        if host is None or not _interrupted_on(host, conn, manifest):
            return None
        if broker.get_daemon_for_host(conn.host_id) is not conn:
            return None
        return host.daemon_tree

    async def _clear_interrupted(
        self, conn: DaemonConn, manifest: schemas.DaemonReleaseOut, daemon_tree: str
    ) -> bool:
        """Clear the interrupted failure if the row still holds exactly what was read.

        One conditional write: a registration since the read (a new
        connection), the owner's Try again (updating) or a reported failure
        (another text) makes it match nothing, and nothing is written. Only
        the state and its text are cleared, so the host reads as available;
        the attempted tree is kept, so a failure reported after this write
        still reads as failed for this release and the offer function leaves
        it alone.
        """
        async with get_sessionmaker()() as session:
            result = await session.execute(
                update(Host)
                .where(
                    Host.id == conn.host_id,
                    Host.daemon_connection_id == conn.id,
                    Host.daemon_generation == conn.host_generation,
                    Host.daemon_tree == daemon_tree,
                    Host.self_update.is_(True),
                    Host.worker_mismatch.is_(False),
                    Host.update_state == "failed",
                    Host.update_error == INTERRUPTED_UPDATE_ERROR,
                    Host.update_tree == manifest.tree,
                )
                .values(update_state=None, update_error=None)
            )
            if result.rowcount != 1:
                await session.rollback()
                return False
            await session.commit()
            return True


def _interrupted_on(host: Host, conn: DaemonConn, manifest: schemas.DaemonReleaseOut) -> bool:
    return (
        host.daemon_connection_id == conn.id
        and host.daemon_generation == conn.host_generation
        and host.update_state == "failed"
        and host.update_error == INTERRUPTED_UPDATE_ERROR
        and host.update_tree == manifest.tree
        and host.self_update is True
        and host.worker_mismatch is False
        # Failed for this release, which also means a daemon that reports a
        # clean tree other than the release's: behind it, not current.
        and release.host_update_state(host, manifest).state == "failed"
    )
