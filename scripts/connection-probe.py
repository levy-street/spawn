#!/usr/bin/env python3
"""Dependency-free WebSocket and TURN reachability probes for production checks."""

from __future__ import annotations

import base64
import hashlib
import os
import socket
import ssl
import struct
import sys
from collections.abc import Iterable
from urllib.parse import parse_qs, urlsplit

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_WS_PROTOCOL = "spawn.alerts.v1"
_STUN_COOKIE = 0x2112A442


class ProbeError(RuntimeError):
    """The endpoint was reachable enough to probe, but failed its contract."""


def _websocket_url(origin: str) -> str:
    parsed = urlsplit(origin)
    if parsed.scheme not in {"http", "https", "ws", "wss"}:
        raise ProbeError("public origin must use http, https, ws, or wss")
    if not parsed.hostname or parsed.username or parsed.password:
        raise ProbeError("public origin must contain only a host and optional port")
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise ProbeError("public origin must not contain a path, query, or fragment")
    scheme = {"http": "ws", "https": "wss"}.get(parsed.scheme, parsed.scheme)
    return f"{scheme}://{parsed.netloc}/ws/alerts"


def _recv_exact(sock: socket.socket, buffered: bytearray, size: int) -> bytes:
    while len(buffered) < size:
        chunk = sock.recv(max(4096, size - len(buffered)))
        if not chunk:
            raise ProbeError("WebSocket closed before sending its policy close frame")
        buffered.extend(chunk)
    value = bytes(buffered[:size])
    del buffered[:size]
    return value


def _recv_headers(sock: socket.socket) -> tuple[bytes, bytearray]:
    buffered = bytearray()
    marker = b"\r\n\r\n"
    while marker not in buffered:
        chunk = sock.recv(4096)
        if not chunk:
            raise ProbeError("connection closed before the WebSocket upgrade response")
        buffered.extend(chunk)
        if len(buffered) > 64 * 1024:
            raise ProbeError("WebSocket upgrade headers exceeded 64 KiB")
    head, rest = bytes(buffered).split(marker, 1)
    return head, bytearray(rest)


def _parse_headers(raw: bytes) -> tuple[int, dict[str, str]]:
    try:
        lines = raw.decode("iso-8859-1").split("\r\n")
        status = int(lines[0].split(None, 2)[1])
    except (IndexError, UnicodeDecodeError, ValueError) as exc:
        raise ProbeError("invalid HTTP response to WebSocket upgrade") from exc
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" not in line:
            raise ProbeError("malformed header in WebSocket upgrade response")
        name, value = line.split(":", 1)
        headers[name.strip().lower()] = value.strip()
    return status, headers


def _recv_frame(sock: socket.socket, buffered: bytearray) -> tuple[int, bytes]:
    first, second = _recv_exact(sock, buffered, 2)
    if first & 0x70:
        raise ProbeError("WebSocket close response used reserved frame bits")
    opcode = first & 0x0F
    if second & 0x80:
        raise ProbeError("server WebSocket frames must not be masked")
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", _recv_exact(sock, buffered, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _recv_exact(sock, buffered, 8))[0]
    if length > 64 * 1024:
        raise ProbeError("unexpectedly large WebSocket frame during probe")
    return opcode, _recv_exact(sock, buffered, length)


def probe_websocket(origin: str, timeout: float = 10.0) -> str:
    url = _websocket_url(origin)
    parsed = urlsplit(url)
    assert parsed.hostname is not None
    secure = parsed.scheme == "wss"
    port = parsed.port or (443 if secure else 80)
    host_header = parsed.netloc
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    expected_accept = base64.b64encode(
        hashlib.sha1(f"{key}{_WS_GUID}".encode("ascii")).digest()
    ).decode("ascii")
    http_origin = f"{'https' if secure else 'http'}://{host_header}"
    request = (
        f"GET {parsed.path} HTTP/1.1\r\n"
        f"Host: {host_header}\r\n"
        "Connection: Upgrade\r\n"
        "Upgrade: websocket\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Protocol: {_WS_PROTOCOL}\r\n"
        f"Origin: {http_origin}\r\n"
        "\r\n"
    ).encode("ascii")

    with socket.create_connection((parsed.hostname, port), timeout=timeout) as plain:
        plain.settimeout(timeout)
        if secure:
            context = ssl.create_default_context()
            connected: socket.socket = context.wrap_socket(
                plain, server_hostname=parsed.hostname
            )
        else:
            connected = plain
        with connected:
            connected.sendall(request)
            raw_headers, buffered = _recv_headers(connected)
            status, headers = _parse_headers(raw_headers)
            if status != 101:
                raise ProbeError(f"WebSocket upgrade returned HTTP {status}, expected 101")
            if headers.get("upgrade", "").lower() != "websocket":
                raise ProbeError("WebSocket upgrade response omitted Upgrade: websocket")
            connection_tokens = {
                item.strip().lower() for item in headers.get("connection", "").split(",")
            }
            if "upgrade" not in connection_tokens:
                raise ProbeError("WebSocket upgrade response omitted Connection: upgrade")
            if headers.get("sec-websocket-accept") != expected_accept:
                raise ProbeError("WebSocket upgrade response has the wrong accept key")
            if headers.get("sec-websocket-protocol") != _WS_PROTOCOL:
                raise ProbeError(f"server did not select {_WS_PROTOCOL}")

            # No credentials were sent. A valid SPAWN D alerts endpoint upgrades
            # first, then expresses that policy decision as WebSocket close 1008.
            for _ in range(8):
                opcode, payload = _recv_frame(connected, buffered)
                if opcode != 0x8:
                    continue
                if len(payload) < 2:
                    raise ProbeError("WebSocket close frame omitted its close code")
                code = struct.unpack("!H", payload[:2])[0]
                if code != 1008:
                    raise ProbeError(f"WebSocket closed with {code}, expected 1008")
                return f"websocket {url} upgraded (101) and rejected anonymous auth (1008)"
            raise ProbeError("WebSocket did not send close 1008 after its upgrade")


def _udp_turn_endpoints(turn_urls: str) -> Iterable[tuple[str, int]]:
    for raw_url in turn_urls.split(","):
        raw_url = raw_url.strip()
        if not raw_url:
            continue
        parsed = urlsplit(raw_url)
        if parsed.scheme != "turn":
            continue
        transport = parse_qs(parsed.query).get("transport", ["udp"])
        if len(transport) != 1 or transport[0].lower() != "udp":
            continue
        authority = parsed.path.removeprefix("//")
        try:
            endpoint = urlsplit(f"//{authority}")
            host = endpoint.hostname
            port = endpoint.port or 3478
        except ValueError as exc:
            raise ProbeError(f"invalid TURN URL {raw_url!r}: {exc}") from exc
        if not host or endpoint.username or endpoint.password:
            raise ProbeError(f"invalid TURN URL {raw_url!r}")
        yield host, port


def _validate_stun_response(payload: bytes, transaction_id: bytes) -> None:
    if len(payload) < 20:
        raise ProbeError("short STUN response")
    message_type, length, cookie = struct.unpack("!HHI", payload[:8])
    if message_type != 0x0101:
        raise ProbeError(f"STUN Binding returned message type 0x{message_type:04x}")
    if cookie != _STUN_COOKIE or payload[8:20] != transaction_id:
        raise ProbeError("STUN Binding response transaction did not match")
    if length != len(payload) - 20:
        raise ProbeError("STUN Binding response length did not match")


def probe_stun(turn_urls: str, timeout: float = 5.0) -> str:
    endpoints = list(dict.fromkeys(_udp_turn_endpoints(turn_urls)))
    if not endpoints:
        raise ProbeError(
            "SPAWN_TURN_URLS has no UDP turn: endpoint; daemons require one"
        )
    errors: list[str] = []
    for host, port in endpoints:
        try:
            addresses = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)
        except OSError as exc:
            errors.append(f"{host}:{port}: {exc}")
            continue
        for family, socktype, proto, _canonname, sockaddr in addresses:
            transaction_id = os.urandom(12)
            request = struct.pack("!HHI12s", 0x0001, 0, _STUN_COOKIE, transaction_id)
            try:
                with socket.socket(family, socktype, proto) as udp:
                    udp.settimeout(timeout)
                    udp.sendto(request, sockaddr)
                    payload, _peer = udp.recvfrom(64 * 1024)
                _validate_stun_response(payload, transaction_id)
                return f"stun {host}:{port}/udp answered a Binding request"
            except (OSError, ProbeError) as exc:
                errors.append(f"{host}:{port}: {exc}")
    raise ProbeError("no configured UDP TURN endpoint answered STUN Binding: " + "; ".join(errors))


def _self_test() -> None:
    assert _websocket_url("https://spawnd.dev") == "wss://spawnd.dev/ws/alerts"
    assert _websocket_url("http://127.0.0.1:3001/") == "ws://127.0.0.1:3001/ws/alerts"
    assert list(
        _udp_turn_endpoints(
            "turn:98.83.222.112:3478?transport=udp,"
            "turn:98.83.222.112:3478?transport=tcp,turns:turn.spawnd.dev:443"
        )
    ) == [("98.83.222.112", 3478)]
    transaction_id = b"0123456789ab"
    _validate_stun_response(
        struct.pack("!HHI12s", 0x0101, 0, _STUN_COOKIE, transaction_id),
        transaction_id,
    )
    key = "dGhlIHNhbXBsZSBub25jZQ=="
    accept = base64.b64encode(
        hashlib.sha1(f"{key}{_WS_GUID}".encode("ascii")).digest()
    ).decode("ascii")
    assert accept == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="


def main() -> int:
    try:
        if sys.argv[1:] == ["--self-test"]:
            _self_test()
            print("connection-probe: self-test ok")
            return 0
        if len(sys.argv) != 3 or sys.argv[1] not in {"websocket", "stun"}:
            print(
                "usage: connection-probe.py --self-test | websocket ORIGIN | stun TURN_URLS",
                file=sys.stderr,
            )
            return 2
        if sys.argv[1] == "websocket":
            print(probe_websocket(sys.argv[2]))
        else:
            print(probe_stun(sys.argv[2]))
        return 0
    except (OSError, ProbeError, ssl.SSLError) as exc:
        print(f"connection-probe: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
