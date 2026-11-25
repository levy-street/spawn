"""Offer a newly active daemon release to daemons that are already connected.

Registration offers the active daemon release to every daemon that registers.
A deploy restarts the server before it switches the prebuilt `current` pointer,
so every daemon re-registers while the previous release is still active, and
nothing else would offer the new one until each daemon's next registration.

This task reads the active release about every 15 seconds. When it changes, it
asks each connected daemon's host, one at a time, through the registration's
own offer function (`ws.daemon._auto_update_after_registration`), and only for
a daemon that has just answered a ping. Nothing existing waits for it or calls
into it; with `daemon_release_offers` off it is never started.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

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
    ) -> None:
        self._read_manifest = read_manifest
        self._pause = pause or self._wait
        self._stop = asyncio.Event()
        self._started = False
        self._current: ReleaseIdentity | None = None
        self._seen: set[ReleaseIdentity] = set()
        self._highest_counter: int | None = None
        # Connection ids seen by the previous poll, and those still owed the
        # current release because they were new when it was first seen.
        self._previous: set[str] = set()
        self._owed: set[str] = set()

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
        self._owed.clear()
        already = identity in self._seen or self._older(identity)
        self._remember(identity)
        if already:
            log.info("daemon release changed to one already seen or older; nothing offered")
            return
        self._owed = set(connections) - {conn.id for conn in settled}
        await self._offer_pass(settled, manifest)

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
        loses its machine or network during the download (issue #170).
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
