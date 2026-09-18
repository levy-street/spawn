#!/usr/bin/env python3
"""Bounded loopback UDP fault injector for disposable RTC/TURN acceptance fixtures.

Run with --upstream 127.0.0.1:PORT. The first stdout JSON line is a ready event
with the allocated listen port. Send JSON lines on stdin:

  {"id":"slow","op":"set","c2s":{"delay_ms":100,"loss":0.1}}
  {"id":"offline","op":"set","c2s":{"outage":true},"s2c":{"outage":true}}
  {"id":"snapshot","op":"status"}
  {"id":"done","op":"stop"}

c2s means client to upstream server; s2c means server to client. Unspecified
fault fields stay unchanged. Each set atomically starts a new epoch and drops
pending delayed packets. Replies include cumulative and current-epoch counters.
EOF, signals, stop, and the runtime limit close every socket and discard queues.
There is no payload logging, packet rewriting, firewall change, or dependency.

For WebRTC relay tests, configure the acceptance client with relay-only ICE and
turn:<listen>?transport=udp, with disposable coturn as upstream. Each client tuple
gets a stable, separate upstream socket so TURN allocations remain distinct.
The fixture must record the selected relay/UDP ICE pair and successful application
traffic, then show TURN data counter deltas during each injected fault. These
counters alone do not prove an application path: STUN checks and consent also
cross TURN. Direct ICE paths bypassing the proxy are NOT impaired or validated.
"""

from __future__ import annotations

import argparse
import heapq
import ipaddress
import json
import math
import os
import queue
import random
import selectors
import signal
import socket
import sys
import threading
import time
from dataclasses import asdict, dataclass

DIRECTIONS = ("c2s", "s2c")
CLASSES = ("turn_channel_data", "turn_send", "turn_data", "stun", "dtls", "other")
CONTROL_LIMIT = 16 * 1024
STDIN_EOF = object()


def address(value: str) -> tuple[str, int]:
    host, separator, port = value.rpartition(":")
    try:
        parsed = ipaddress.ip_address(host.strip("[]"))
        if not separator or not parsed.is_loopback or not port.isdecimal():
            raise ValueError
        number = int(port)
        if not 0 <= number <= 65535:
            raise ValueError
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected numeric loopback HOST:PORT") from exc
    return str(parsed), number


def packet_class(data: bytes) -> str:
    if len(data) >= 4 and 0x40 <= data[0] <= 0x7F:
        if len(data) >= 4 + int.from_bytes(data[2:4], "big"):
            return "turn_channel_data"
    if len(data) >= 20 and data[0] < 4 and data[4:8] == b"\x21\x12\xa4\x42":
        if len(data) >= 20 + int.from_bytes(data[2:4], "big"):
            kind = int.from_bytes(data[:2], "big")
            return {0x0016: "turn_send", 0x0017: "turn_data"}.get(kind, "stun")
    if len(data) >= 13 and 20 <= data[0] <= 63 and data[1] == 0xFE:
        return "dtls"
    return "other"


@dataclass(frozen=True)
class Fault:
    loss: float = 0.0
    delay_ms: float = 0.0
    jitter_ms: float = 0.0
    outage: bool = False

    def update(self, change: object) -> Fault:
        if not isinstance(change, dict) or set(change) - set(asdict(self)):
            raise ValueError(
                "fault must contain only loss, delay_ms, jitter_ms, outage"
            )
        values = asdict(self) | change
        if type(values["outage"]) is not bool:
            raise ValueError("outage must be boolean")
        for name, ceiling in (("loss", 1), ("delay_ms", 30000), ("jitter_ms", 30000)):
            value = values[name]
            if (
                type(value) not in (int, float)
                or not 0 <= value <= ceiling
                or not math.isfinite(value)
            ):
                raise ValueError(f"{name} must be a finite number in 0..{ceiling}")
        return Fault(**values)


def counters() -> dict:
    return {
        direction: {
            "received": {"packets": 0, "bytes": 0},
            "forwarded": {"packets": 0, "bytes": 0},
            "dropped": {"packets": 0, "bytes": 0},
            "drop_reasons": {},
            "classes": {
                name: {"received": 0, "forwarded": 0, "dropped": 0} for name in CLASSES
            },
            "last_received_ms": None,
            "last_forwarded_ms": None,
        }
        for direction in DIRECTIONS
    }


@dataclass
class Mapping:
    client: tuple
    upstream: socket.socket
    touched: float
    closed: bool = False


class Proxy:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.selector = selectors.DefaultSelector()
        self.listener = self.make_socket(args.listen)
        try:
            self.listener.bind(args.listen)
            self.selector.register(self.listener, selectors.EVENT_READ, None)
        except BaseException:
            self.listener.close()
            self.selector.close()
            raise
        self.started = time.monotonic()
        self.faults = {direction: Fault() for direction in DIRECTIONS}
        self.rng = {
            direction: random.Random(args.seed + index)
            for index, direction in enumerate(DIRECTIONS)
        }
        self.epoch = 0
        self.totals = counters()
        self.epoch_totals = counters()
        self.mappings: dict[tuple, Mapping] = {}
        self.pending: list[tuple[float, int, Mapping, str, bytes]] = []
        self.queued_bytes = 0
        self.sequence = 0
        self.high_water_mappings = 0
        self.high_water_queue_bytes = 0
        self.last_transition_dropped = 0
        self.socket_errors = 0
        self.stop_reason: str | None = None

    @staticmethod
    def make_socket(endpoint: tuple[str, int]) -> socket.socket:
        family = socket.AF_INET6 if ":" in endpoint[0] else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_DGRAM)
        sock.setblocking(False)
        return sock

    def count(
        self, direction: str, action: str, data: bytes, reason: str | None = None
    ) -> None:
        kind = packet_class(data)
        for values in (self.totals[direction], self.epoch_totals[direction]):
            values[action]["packets"] += 1
            values[action]["bytes"] += len(data)
            values["classes"][kind][action] += 1
            if action in ("received", "forwarded"):
                values[f"last_{action}_ms"] = round(
                    (time.monotonic() - self.started) * 1000, 3
                )
            if reason:
                values["drop_reasons"][reason] = (
                    values["drop_reasons"].get(reason, 0) + 1
                )

    def status(self) -> dict:
        return {
            "epoch": self.epoch,
            "elapsed_ms": round((time.monotonic() - self.started) * 1000, 3),
            "faults": {
                direction: asdict(fault) for direction, fault in self.faults.items()
            },
            "totals": self.totals,
            "epoch_totals": self.epoch_totals,
            "mappings": len(self.mappings),
            "queued_datagrams": len(self.pending),
            "queued_bytes": self.queued_bytes,
            "high_water_mappings": self.high_water_mappings,
            "high_water_queue_bytes": self.high_water_queue_bytes,
            "last_transition_dropped": self.last_transition_dropped,
            "socket_errors": self.socket_errors,
        }

    def discard_pending(self, reason: str) -> None:
        for _, _, _, direction, data in self.pending:
            self.count(direction, "dropped", data, reason)
        self.pending.clear()
        self.queued_bytes = 0

    def command(self, value: object) -> dict:
        request_id = value.get("id") if isinstance(value, dict) else None
        op = value.get("op") if isinstance(value, dict) else None
        reply = {"event": "reply", "id": request_id, "op": op}
        try:
            if not isinstance(value, dict) or set(value) - {"id", "op", *DIRECTIONS}:
                raise ValueError("command must contain only id, op, c2s, s2c")
            if request_id is not None and type(request_id) not in (str, int):
                raise ValueError("id must be a string or integer")
            if op == "set":
                faults = {
                    direction: self.faults[direction].update(value.get(direction, {}))
                    for direction in DIRECTIONS
                }
                self.last_transition_dropped = len(self.pending)
                self.discard_pending("reconfigured")
                self.faults = faults
                self.epoch += 1
                self.epoch_totals = counters()
            elif op in ("status", "stop"):
                if any(direction in value for direction in DIRECTIONS):
                    raise ValueError("fault fields require op set")
                if op == "stop":
                    self.stop_reason = "control_stop"
            else:
                raise ValueError("op must be set, status, or stop")
            reply.update(ok=True, status=self.status())
        except ValueError as exc:
            reply.update(ok=False, error=str(exc))
        return reply

    def mapping(self, client: tuple) -> Mapping | None:
        existing = self.mappings.get(client)
        if existing:
            return existing
        if len(self.mappings) >= self.args.max_clients:
            return None
        upstream = self.make_socket(self.args.upstream)
        try:
            upstream.connect(self.args.upstream)
            item = Mapping(client, upstream, time.monotonic())
            self.selector.register(upstream, selectors.EVENT_READ, item)
        except OSError:
            upstream.close()
            self.socket_errors += 1
            return None
        self.mappings[client] = item
        self.high_water_mappings = max(self.high_water_mappings, len(self.mappings))
        return item

    def receive(self, source: socket.socket, item: Mapping | None) -> None:
        try:
            data, sender = source.recvfrom(65536)
        except BlockingIOError:
            return
        except OSError:
            self.socket_errors += 1
            return
        direction = "s2c" if item is not None else "c2s"
        self.count(direction, "received", data)
        if item is None:
            item = self.mapping(sender)
        if item is None:
            self.count(direction, "dropped", data, "mapping_limit_or_error")
            return
        item.touched = time.monotonic()
        fault = self.faults[direction]
        if fault.outage:
            self.count(direction, "dropped", data, "outage")
            return
        if fault.loss and self.rng[direction].random() < fault.loss:
            self.count(direction, "dropped", data, "loss")
            return
        delay = (
            max(
                0,
                fault.delay_ms
                + self.rng[direction].uniform(-fault.jitter_ms, fault.jitter_ms),
            )
            / 1000
        )
        if not delay:
            self.forward(item, direction, data)
        elif (
            len(self.pending) >= self.args.max_queued_datagrams
            or self.queued_bytes + len(data) > self.args.max_queued_bytes
        ):
            self.count(direction, "dropped", data, "queue_limit")
        else:
            self.sequence += 1
            heapq.heappush(
                self.pending,
                (time.monotonic() + delay, self.sequence, item, direction, data),
            )
            self.queued_bytes += len(data)
            self.high_water_queue_bytes = max(
                self.high_water_queue_bytes, self.queued_bytes
            )

    def forward(self, item: Mapping, direction: str, data: bytes) -> None:
        if item.closed:
            self.count(direction, "dropped", data, "mapping_expired")
            return
        try:
            if direction == "c2s":
                sent = item.upstream.send(data)
            else:
                sent = self.listener.sendto(data, item.client)
            if sent != len(data):
                raise OSError("partial UDP datagram")
        except OSError:
            self.socket_errors += 1
            self.count(direction, "dropped", data, "socket_error")
            return
        item.touched = time.monotonic()
        self.count(direction, "forwarded", data)

    def tick(self) -> None:
        now = time.monotonic()
        while self.pending and self.pending[0][0] <= now:
            _, _, item, direction, data = heapq.heappop(self.pending)
            self.queued_bytes -= len(data)
            self.forward(item, direction, data)
        for client, item in list(self.mappings.items()):
            if now - item.touched >= self.args.idle_seconds:
                self.close_mapping(item)
                del self.mappings[client]

    def close_mapping(self, item: Mapping) -> None:
        self.selector.unregister(item.upstream)
        item.upstream.close()
        item.closed = True

    def close(self) -> None:
        self.discard_pending("shutdown")
        for item in self.mappings.values():
            self.close_mapping(item)
        self.mappings.clear()
        self.selector.unregister(self.listener)
        self.listener.close()
        self.selector.close()


class Output:
    """A stalled controller cannot stop socket cleanup or the runtime deadline."""

    def __init__(self) -> None:
        self.lines: queue.Queue = queue.Queue(maxsize=64)
        self.failed = threading.Event()
        self.thread = threading.Thread(target=self.write, daemon=True)
        self.thread.start()

    def write(self) -> None:
        try:
            while (line := self.lines.get()) is not None:
                while line:
                    line = line[os.write(sys.stdout.fileno(), line) :]
        except OSError:
            self.failed.set()

    def emit(self, value: dict) -> None:
        if self.failed.is_set():
            raise BrokenPipeError("stdout closed")
        try:
            self.lines.put_nowait(
                (json.dumps(value, separators=(",", ":")) + "\n").encode()
            )
        except queue.Full as exc:
            raise BrokenPipeError("controller is not draining stdout") from exc

    def finish(self) -> None:
        try:
            self.lines.put_nowait(None)
        except queue.Full:
            pass
        self.thread.join(timeout=1)


def read_commands(commands: queue.Queue) -> None:
    # A bounded reader thread works with Windows anonymous stdin pipes too;
    # selecting on stdin would only work on Unix. Raw reads avoid holding a
    # Python buffered-I/O lock when a runtime deadline exits with stdin open.
    buffered = b""
    overlong = False

    def parse(line: bytes, too_long: bool) -> None:
        if too_long:
            commands.put(ValueError("control line exceeds 16 KiB"))
            return
        try:

            def reject_constant(value: str) -> None:
                raise ValueError(f"non-finite JSON number: {value}")

            commands.put(json.loads(line, parse_constant=reject_constant))
        except (ValueError, UnicodeDecodeError, RecursionError) as exc:
            commands.put(ValueError(str(exc)))

    while True:
        block = os.read(sys.stdin.fileno(), 4096)
        if not block:
            if buffered or overlong:
                parse(buffered, overlong)
            commands.put(STDIN_EOF)
            return
        parts = block.split(b"\n")
        for index, part in enumerate(parts):
            if not overlong:
                buffered += part
                if len(buffered) > CONTROL_LIMIT:
                    buffered = b""
                    overlong = True
            if index < len(parts) - 1:
                parse(buffered, overlong)
                buffered = b""
                overlong = False


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--listen", type=address, default=("127.0.0.1", 0))
    parser.add_argument("--upstream", type=address, required=True)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--max-clients", type=int, default=64)
    parser.add_argument("--max-queued-datagrams", type=int, default=1024)
    parser.add_argument("--max-queued-bytes", type=int, default=2 * 1024 * 1024)
    parser.add_argument("--idle-seconds", type=float, default=900)
    parser.add_argument("--max-runtime-seconds", type=float, default=1800)
    args = parser.parse_args()
    for name in (
        "max_clients",
        "max_queued_datagrams",
        "max_queued_bytes",
        "idle_seconds",
        "max_runtime_seconds",
    ):
        value = getattr(args, name)
        if not math.isfinite(value) or value <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive and finite")
    if args.upstream[1] == 0:
        parser.error("--upstream port must be in 1..65535")
    proxy = Proxy(args)
    output = Output()
    commands: queue.Queue = queue.Queue(maxsize=64)
    threading.Thread(target=read_commands, args=(commands,), daemon=True).start()

    def stop(signum: int, _frame: object) -> None:
        proxy.stop_reason = f"signal_{signum}"

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    endpoint = proxy.listener.getsockname()
    try:
        output.emit(
            {
                "event": "ready",
                "protocol": 1,
                "pid": os.getpid(),
                "listen": {"host": endpoint[0], "port": endpoint[1]},
                "upstream": {"host": args.upstream[0], "port": args.upstream[1]},
                "seed": args.seed,
                "limits": {
                    key: getattr(args, key)
                    for key in (
                        "max_clients",
                        "max_queued_datagrams",
                        "max_queued_bytes",
                        "idle_seconds",
                        "max_runtime_seconds",
                    )
                },
                "status": proxy.status(),
            }
        )
        while not proxy.stop_reason:
            for _ in range(32):
                try:
                    command = commands.get_nowait()
                except queue.Empty:
                    break
                if command is STDIN_EOF:
                    proxy.stop_reason = "stdin_eof"
                    break
                if isinstance(command, ValueError):
                    output.emit(
                        {
                            "event": "reply",
                            "id": None,
                            "op": None,
                            "ok": False,
                            "error": str(command),
                        }
                    )
                else:
                    output.emit(proxy.command(command))
                if proxy.stop_reason:
                    break
            if time.monotonic() - proxy.started >= args.max_runtime_seconds:
                proxy.stop_reason = "runtime_limit"
            if proxy.stop_reason:
                break
            proxy.tick()
            for key, _ in proxy.selector.select(0.01):
                proxy.receive(key.fileobj, key.data)
    except BrokenPipeError:
        proxy.stop_reason = "stdout_closed"
    finally:
        proxy.close()
    try:
        output.emit(
            {"event": "stopped", "reason": proxy.stop_reason, "status": proxy.status()}
        )
    except BrokenPipeError:
        return 1
    finally:
        output.finish()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
