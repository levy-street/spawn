"""Order support writes and wire delivery within the single server process."""

import asyncio
import logging
from collections import deque
from contextlib import asynccontextmanager
from weakref import WeakValueDictionary

from .ws.broker import daemon_wire, get_broker

log = logging.getLogger("spawn.support_log")
ORDER_SECONDS = 4
SEND_SECONDS = 2
# Rust counts UTF-8 bytes of the entire text message. Reserve 1 KiB.
DAEMON_LIMIT = 64 * 1024
SUPPORT_LIMIT = DAEMON_LIMIT - 1024


def enabled_timestamp(statement: dict | None) -> int | None:
    return statement["issued_at_ms"] if statement and statement["enabled"] else None


def wire_size(frame):
    return len(daemon_wire(frame).encode("utf-8"))


class DeliveryTurn:
    def __init__(self):
        self.ready = asyncio.Event()
        self.valid = True
        self.sends = set()

    def interrupt(self):
        self.valid = False
        for task in self.sends:
            task.cancel()

    async def send(self, conn, frame):
        if not self.valid:
            return False
        task = asyncio.create_task(conn.send_text(frame))
        self.sends.add(task)
        try:
            async with asyncio.timeout(SEND_SECONDS):
                await task
        except asyncio.CancelledError:
            if self.valid or asyncio.current_task().cancelling():
                raise
            return False
        finally:
            self.sends.discard(task)
        return True


class AccountOrder:
    def __init__(self):
        self.queue = deque()

    @asynccontextmanager
    async def enter(self, *, reducing=False):
        turn = DeliveryTurn()
        if not self.queue:
            turn.ready.set()
        self.queue.append(turn)
        try:
            try:
                async with asyncio.timeout(ORDER_SECONDS):
                    await turn.ready.wait()
            except TimeoutError:
                if reducing:
                    # Bypass delivery, never the database's mutation checks.
                    # Older turns lose their right to send, even if a claim is
                    # still committing or a write is waiting on the socket.
                    for older in self.queue:
                        if older is turn:
                            break
                        older.interrupt()
                else:
                    turn.interrupt()
            yield turn if reducing or turn.valid else None
        finally:
            self.queue.remove(turn)
            if self.queue:
                # Later dispatch cannot start until every preceding mutation,
                # including an interrupted or out-of-order reduction, finishes.
                self.queue[0].ready.set()


_orders: WeakValueDictionary[str, AccountOrder] = WeakValueDictionary()


def delivery_order(user_id):
    order = _orders.get(user_id)
    if order is None:
        order = _orders[user_id] = AccountOrder()
    return order


async def send_statement(turn, conn, statement):
    conn.support_enabled_sent_ms = None
    frame = {"type": "host.support_log_consent", "consent": statement}
    try:
        if wire_size(frame) <= SUPPORT_LIMIT and await turn.send(conn, frame) and turn.valid:
            conn.support_delivery_ready = True
            conn.support_enabled_sent_ms = enabled_timestamp(statement)
            return
    except Exception:
        pass
    conn.support_delivery_ready = False
    log.warning("SPAWN D could not send the support log statement to a host")


async def deliver_statement(turn, user_id, statement):
    # One slow socket costs at most one send deadline for the entire account.
    await asyncio.gather(
        *(
            send_statement(turn, conn, statement)
            for conn in get_broker().support_daemons_for_account(user_id)
            if conn.support_delivery_ready
        )
    )
