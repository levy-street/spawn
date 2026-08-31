#!/usr/bin/env python3
"""Small localhost HTTP/WebSocket fault proxy for updater integration tests.

WebSocket upgrades are always tunneled byte-for-byte. HTTP faults are scoped to
``--match-path`` (an exact path, or a prefix when it ends in ``*``), which lets
the daemon use one origin for control, manifests, and binary downloads without
destroying the control connection before an update can be requested.
"""

from __future__ import annotations

import argparse
import select
import signal
import socket
import socketserver
import threading
import time
from collections.abc import Iterable

HEADER_LIMIT = 64 * 1024
BUFFER_SIZE = 64 * 1024


def split_address(value: str) -> tuple[str, int]:
    host, separator, port = value.rpartition(":")
    if not separator or not host or not port.isdecimal():
        raise argparse.ArgumentTypeError("address must be HOST:PORT")
    parsed_port = int(port)
    if not 0 < parsed_port < 65536:
        raise argparse.ArgumentTypeError("port must be in 1..65535")
    return host, parsed_port


def path_matches(path: str, selector: str) -> bool:
    if selector.endswith("*"):
        return path.startswith(selector[:-1])
    return path == selector


def read_headers(stream: socket.socket) -> tuple[bytes, bytes]:
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = stream.recv(BUFFER_SIZE)
        if not chunk:
            raise ConnectionError("connection closed before headers")
        data.extend(chunk)
        if len(data) > HEADER_LIMIT:
            raise ConnectionError("headers exceed 64 KiB")
    boundary = data.index(b"\r\n\r\n") + 4
    return bytes(data[:boundary]), bytes(data[boundary:])


def request_path(headers: bytes) -> str:
    first = headers.split(b"\r\n", 1)[0]
    parts = first.split(b" ")
    if len(parts) != 3:
        raise ConnectionError("malformed HTTP request line")
    return parts[1].split(b"?", 1)[0].decode("ascii", "strict")


def is_websocket(headers: bytes) -> bool:
    lowered = headers.lower()
    return b"\r\nupgrade: websocket\r\n" in lowered


def force_connection_close(headers: bytes) -> bytes:
    lines = headers[:-4].split(b"\r\n")
    kept = [line for line in lines if not line.lower().startswith(b"connection:")]
    kept.append(b"Connection: close")
    return b"\r\n".join(kept) + b"\r\n\r\n"


def rewrite_content_length(headers: bytes, length: int) -> bytes:
    lines = headers[:-4].split(b"\r\n")
    rewritten: list[bytes] = []
    found = False
    for line in lines:
        lowered = line.lower()
        if lowered.startswith(b"content-length:"):
            rewritten.append(f"Content-Length: {length}".encode())
            found = True
        elif lowered.startswith(b"transfer-encoding:"):
            continue
        else:
            rewritten.append(line)
    if not found:
        rewritten.append(f"Content-Length: {length}".encode())
    return b"\r\n".join(rewritten) + b"\r\n\r\n"


def content_length(headers: bytes) -> int | None:
    for line in headers.split(b"\r\n"):
        name, separator, value = line.partition(b":")
        if separator and name.lower() == b"content-length":
            stripped = value.strip()
            return int(stripped) if stripped.isdigit() else None
    return None


def flip_chunk(chunk: bytes, *, start: int, at: int) -> bytes:
    if at < start or at >= start + len(chunk):
        return chunk
    changed = bytearray(chunk)
    changed[at - start] ^= 0x01
    return bytes(changed)


def tunnel(left: socket.socket, right: socket.socket) -> None:
    sockets = [left, right]
    while True:
        readable, _, _ = select.select(sockets, [], [], 1.0)
        if not readable:
            continue
        for source in readable:
            target = right if source is left else left
            chunk = source.recv(BUFFER_SIZE)
            if not chunk:
                return
            target.sendall(chunk)


class FaultProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], args: argparse.Namespace):
        self.args = args
        super().__init__(address, FaultHandler)


class FaultHandler(socketserver.BaseRequestHandler):
    server: FaultProxy

    def handle(self) -> None:
        client: socket.socket = self.request
        client.settimeout(10)
        try:
            headers, remainder = read_headers(client)
            path = request_path(headers)
            matches = path_matches(path, self.server.args.match_path)
            if matches and self.server.args.mode == "hang":
                client.settimeout(None)
                while not self.server._BaseServer__is_shut_down.is_set():
                    time.sleep(0.1)
                return

            with socket.create_connection(self.server.args.upstream, timeout=10) as upstream:
                if is_websocket(headers):
                    upstream.sendall(headers + remainder)
                    client.settimeout(None)
                    upstream.settimeout(None)
                    tunnel(client, upstream)
                    return

                upstream.sendall(force_connection_close(headers) + remainder)
                response_headers, response_remainder = read_headers(upstream)
                mode = self.server.args.mode if matches else "plain"
                if mode == "latency":
                    time.sleep(self.server.args.ms / 1000)

                expected = content_length(response_headers)
                if mode == "truncate":
                    limit = self.server.args.bytes
                    if expected is not None:
                        limit = min(limit, expected)
                    client.sendall(rewrite_content_length(response_headers, limit))
                else:
                    client.sendall(response_headers)

                sent = 0
                chunks: Iterable[bytes] = _body_chunks(upstream, response_remainder, expected)
                for chunk in chunks:
                    if mode == "truncate":
                        remaining = self.server.args.bytes - sent
                        if remaining <= 0:
                            break
                        chunk = chunk[:remaining]
                    elif mode == "flip":
                        chunk = flip_chunk(chunk, start=sent, at=self.server.args.at)

                    if not chunk:
                        break
                    if mode == "trickle":
                        _send_trickled(client, chunk, self.server.args.rate)
                    else:
                        client.sendall(chunk)
                    sent += len(chunk)
                    if mode == "truncate" and sent >= self.server.args.bytes:
                        break
        except (BrokenPipeError, ConnectionError, OSError, TimeoutError):
            return


def _body_chunks(
    upstream: socket.socket, first: bytes, expected: int | None
) -> Iterable[bytes]:
    read = 0
    if first:
        selected = first if expected is None else first[:expected]
        read += len(selected)
        yield selected
    while expected is None or read < expected:
        chunk = upstream.recv(BUFFER_SIZE if expected is None else min(BUFFER_SIZE, expected - read))
        if not chunk:
            return
        read += len(chunk)
        yield chunk


def _send_trickled(client: socket.socket, chunk: bytes, rate: int) -> None:
    quantum = max(1, min(len(chunk), rate // 20 or 1))
    interval = quantum / rate
    for offset in range(0, len(chunk), quantum):
        started = time.monotonic()
        client.sendall(chunk[offset : offset + quantum])
        remaining = interval - (time.monotonic() - started)
        if remaining > 0:
            time.sleep(remaining)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--listen", type=split_address, default=("127.0.0.1", 0))
    root.add_argument("--upstream", type=split_address)
    root.add_argument("--match-path", default="/api/install/spawnd/*")
    root.add_argument("--self-test", action="store_true")
    subparsers = root.add_subparsers(dest="mode")
    subparsers.add_parser("hang")
    truncate = subparsers.add_parser("truncate")
    truncate.add_argument("--bytes", type=int, required=True)
    flip = subparsers.add_parser("flip")
    flip.add_argument("--at", type=int, required=True)
    trickle = subparsers.add_parser("trickle")
    trickle.add_argument("--rate", type=int, required=True, metavar="B/S")
    latency = subparsers.add_parser("latency")
    latency.add_argument("--ms", type=int, required=True)
    return root


def validate(args: argparse.Namespace) -> None:
    if args.self_test:
        return
    if args.upstream is None or args.mode is None:
        raise SystemExit("--upstream and a fault mode are required")
    for name in ("bytes", "rate"):
        value = getattr(args, name, None)
        if value is not None and value <= 0:
            raise SystemExit(f"--{name} must be positive")
    for name in ("at", "ms"):
        value = getattr(args, name, None)
        if value is not None and value < 0:
            raise SystemExit(f"--{name} must be non-negative")
    listen_host, _ = args.listen
    upstream_host, _ = args.upstream
    if listen_host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("refusing a non-local listen address")
    if upstream_host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("refusing a non-local upstream address")


def self_test() -> None:
    assert split_address("127.0.0.1:1234") == ("127.0.0.1", 1234)
    assert path_matches("/api/install/spawnd/x", "/api/install/spawnd/*")
    assert not path_matches("/ws/daemon", "/api/install/spawnd/*")
    assert flip_chunk(b"abcd", start=10, at=12) == b"abbd"
    original = b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n"
    rewritten = rewrite_content_length(original, 3)
    assert content_length(rewritten) == 3
    assert b"Connection: close" in force_connection_close(original)
    print("fault-proxy: self-test ok")


def main() -> None:
    args = parser().parse_args()
    validate(args)
    if args.self_test:
        self_test()
        return
    server = FaultProxy(args.listen, args)
    host, port = server.server_address[:2]
    print(f"fault-proxy: listening on {host}:{port}", flush=True)

    def stop(_signum: int, _frame: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
