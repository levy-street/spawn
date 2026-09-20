#!/usr/bin/env python3
"""Real loopback UDP and subprocess regressions; no TURN install or privileges.

These prove the injector, not native WebRTC acceptance. The native fixture must
add selected ICE candidate evidence and application exchanges across coturn.
"""

from __future__ import annotations

import json
import queue
import socket
import struct
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

PROXY = Path(__file__).with_name("udp-chaos-proxy.py")
CHANNEL_DATA = struct.pack("!HH", 0x4000, 9) + b"encrypted"
STUN = struct.pack("!HHI", 0x0001, 0, 0x2112A442) + b"transaction!"
TURN_SEND = struct.pack("!HHI", 0x0016, 0, 0x2112A442) + b"transaction!"
TURN_DATA = struct.pack("!HHI", 0x0017, 0, 0x2112A442) + b"transaction!"


class Echo:
    def __init__(self):
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.socket.bind(("127.0.0.1", 0))
        self.socket.settimeout(0.05)
        self.endpoint = self.socket.getsockname()
        self.seen: list[tuple[bytes, tuple]] = []
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        while not self.done.is_set():
            try:
                data, endpoint = self.socket.recvfrom(65536)
                self.seen.append((data, endpoint))
                self.socket.sendto(data, endpoint)
            except TimeoutError:
                pass
            except OSError:
                return

    def close(self):
        self.done.set()
        self.thread.join(timeout=1)
        self.socket.close()


class Child:
    def __init__(self, upstream, *args):
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(PROXY),
                "--upstream",
                f"{upstream[0]}:{upstream[1]}",
                *args,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.events: queue.Queue = queue.Queue()
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.ready = self.event()
        if self.ready.get("event") != "ready":
            raise AssertionError(self.ready)
        self.endpoint = (self.ready["listen"]["host"], self.ready["listen"]["port"])
        self.next_id = 0

    def read(self):
        for line in self.process.stdout:
            self.events.put(json.loads(line))

    def event(self):
        return self.events.get(timeout=3)

    def raw(self, command):
        self.process.stdin.write(command + "\n")
        self.process.stdin.flush()
        return self.event()

    def command(self, op="status", **fields):
        self.next_id += 1
        response = self.raw(json.dumps({"id": self.next_id, "op": op, **fields}))
        if response.get("id") != self.next_id or not response.get("ok"):
            raise AssertionError(response)
        return response["status"]

    def wait_status(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status = self.command()
            if predicate(status):
                return status
            time.sleep(0.01)
        raise AssertionError(f"status predicate timed out: {status}")

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        if not self.process.stdin.closed:
            self.process.stdin.close()
        self.reader.join(timeout=1)
        self.process.stdout.close()
        self.process.stderr.close()


class UDPChaosTests(unittest.TestCase):
    def setUp(self):
        self.echo = Echo()
        self.addCleanup(self.echo.close)

    def proxy(self, *args):
        child = Child(self.echo.endpoint, *args)
        self.addCleanup(child.close)
        return child

    def client(self, endpoint):
        client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        client.connect(endpoint)
        client.settimeout(1)
        self.addCleanup(client.close)
        return client

    def test_actual_udp_preserves_client_tuples_payloads_and_class_counters(self):
        proxy = self.proxy()
        first, second = self.client(proxy.endpoint), self.client(proxy.endpoint)
        frames = (CHANNEL_DATA, STUN, TURN_SEND, TURN_DATA, b"opaque", b"")
        for client in (first, second):
            for frame in frames:
                client.send(frame)
                self.assertEqual(client.recv(65536), frame)
        status = proxy.wait_status(
            lambda s: s["totals"]["s2c"]["forwarded"]["packets"] == 12
        )
        self.assertEqual(status["mappings"], 2)
        sources = [endpoint for _, endpoint in self.echo.seen]
        self.assertEqual(len(set(sources[:6])), 1)
        self.assertEqual(len(set(sources[6:])), 1)
        self.assertNotEqual(sources[0], sources[6])
        for direction in ("c2s", "s2c"):
            counts = status["totals"][direction]
            self.assertEqual(counts["forwarded"]["bytes"], 2 * sum(map(len, frames)))
            self.assertEqual(counts["dropped"]["packets"], 0)
            for name in ("turn_channel_data", "stun", "turn_send", "turn_data"):
                self.assertEqual(counts["classes"][name]["forwarded"], 2)

    def test_directional_loss_reaches_only_the_expected_side_and_recovers(self):
        proxy = self.proxy()
        client = self.client(proxy.endpoint)
        proxy.command("set", c2s={"loss": 1})
        client.send(CHANNEL_DATA)
        status = proxy.wait_status(
            lambda s: s["epoch_totals"]["c2s"]["dropped"]["packets"] == 1
        )
        self.assertEqual(
            status["epoch_totals"]["c2s"]["classes"]["turn_channel_data"]["dropped"], 1
        )
        self.assertEqual(self.echo.seen, [])
        proxy.command("set", c2s={"loss": 0}, s2c={"loss": 1})
        client.send(CHANNEL_DATA)
        status = proxy.wait_status(
            lambda s: s["epoch_totals"]["s2c"]["dropped"]["packets"] == 1
        )
        self.assertEqual(len(self.echo.seen), 1)
        self.assertEqual(
            status["epoch_totals"]["s2c"]["classes"]["turn_channel_data"]["dropped"], 1
        )
        client.settimeout(0.1)
        with self.assertRaises(TimeoutError):
            client.recv(65536)
        proxy.command("set", s2c={"loss": 0})
        client.settimeout(1)
        client.send(b"recovered")
        self.assertEqual(client.recv(65536), b"recovered")

    def test_latency_is_measured_on_udp_in_both_directions(self):
        proxy = self.proxy()
        client = self.client(proxy.endpoint)
        proxy.command("set", c2s={"delay_ms": 100}, s2c={"delay_ms": 100})
        before = time.monotonic()
        client.send(CHANNEL_DATA)
        self.assertEqual(client.recv(65536), CHANNEL_DATA)
        self.assertGreaterEqual(time.monotonic() - before, 0.19)

    def test_seeded_partial_loss_is_repeatable_on_real_datagrams(self):
        traces = []
        for _ in range(2):
            proxy = self.proxy("--seed", "42")
            client = self.client(proxy.endpoint)
            proxy.command("set", c2s={"loss": 0.35})
            before = len(self.echo.seen)
            for number in range(80):
                client.send(str(number).encode())
            status = proxy.wait_status(
                lambda s: (
                    s["epoch_totals"]["c2s"]["received"]["packets"] == 80
                    and s["epoch_totals"]["s2c"]["received"]["packets"]
                    == s["epoch_totals"]["c2s"]["forwarded"]["packets"]
                )
            )
            dropped = status["epoch_totals"]["c2s"]["dropped"]["packets"]
            self.assertGreater(dropped, 0)
            self.assertLess(dropped, 80)
            traces.append([data for data, _ in self.echo.seen[before:]])
        self.assertEqual(traces[0], traces[1])

    def test_outage_also_discards_a_delayed_server_reply(self):
        proxy = self.proxy()
        client = self.client(proxy.endpoint)
        proxy.command("set", s2c={"delay_ms": 400})
        client.send(CHANNEL_DATA)
        proxy.wait_status(lambda s: s["queued_datagrams"] == 1)
        status = proxy.command("set", c2s={"outage": True}, s2c={"outage": True})
        self.assertEqual(status["last_transition_dropped"], 1)
        self.assertEqual(
            status["totals"]["s2c"]["classes"]["turn_channel_data"]["dropped"], 1
        )
        proxy.command(
            "set", c2s={"outage": False}, s2c={"outage": False, "delay_ms": 0}
        )
        client.send(b"fresh reply")
        self.assertEqual(client.recv(65536), b"fresh reply")
        client.settimeout(0.5)
        with self.assertRaises(TimeoutError):
            client.recv(65536)

    def test_outage_discards_queued_data_without_replay_after_recovery(self):
        proxy = self.proxy()
        client = self.client(proxy.endpoint)
        proxy.command("set", c2s={"delay_ms": 500}, s2c={"delay_ms": 500})
        client.send(b"stale")
        proxy.wait_status(lambda s: s["queued_datagrams"] == 1)
        status = proxy.command("set", c2s={"outage": True}, s2c={"outage": True})
        self.assertEqual(status["last_transition_dropped"], 1)
        self.assertEqual(status["queued_bytes"], 0)
        client.send(CHANNEL_DATA)
        status = proxy.wait_status(
            lambda s: s["epoch_totals"]["c2s"]["dropped"]["packets"] == 1
        )
        self.assertEqual(status["epoch_totals"]["c2s"]["drop_reasons"], {"outage": 1})
        proxy.command(
            "set",
            c2s={"outage": False, "delay_ms": 0},
            s2c={"outage": False, "delay_ms": 0},
        )
        client.send(b"fresh")
        self.assertEqual(client.recv(65536), b"fresh")
        client.settimeout(0.6)
        with self.assertRaises(TimeoutError):
            client.recv(65536)
        self.assertEqual([data for data, _ in self.echo.seen], [b"fresh"])

    def test_limits_bound_queues_and_client_sockets_and_expire_mappings(self):
        proxy = self.proxy(
            "--max-clients",
            "1",
            "--max-queued-datagrams",
            "2",
            "--max-queued-bytes",
            "6",
            "--idle-seconds",
            "0.3",
        )
        first, second = self.client(proxy.endpoint), self.client(proxy.endpoint)
        proxy.command("set", c2s={"delay_ms": 1000})
        first.send(b"abc")
        first.send(b"def")
        first.send(b"ghi")
        second.send(b"other")
        status = proxy.wait_status(
            lambda s: s["totals"]["c2s"]["received"]["packets"] == 4
        )
        self.assertEqual(status["queued_datagrams"], 2)
        self.assertEqual(status["queued_bytes"], 6)
        self.assertEqual(status["mappings"], 1)
        self.assertEqual(
            status["totals"]["c2s"]["drop_reasons"],
            {"queue_limit": 1, "mapping_limit_or_error": 1},
        )
        proxy.wait_status(lambda s: s["mappings"] == 0)
        proxy.command("set", c2s={"delay_ms": 0})
        second.send(b"new tuple")
        self.assertEqual(second.recv(65536), b"new tuple")

    def test_invalid_controls_are_atomic_and_do_not_stop_or_change_epoch(self):
        proxy = self.proxy()
        for command in (
            "null",
            "[]",
            "not json",
            '{"op":"set","c2s":{"loss":NaN}}',
            '{"op":"set","c2s":{"loss":0.5},"s2c":{"outage":1}}',
            '{"op":"set","c2s":{"loss":true}}',
            '{"op":"set","extra":1}',
            '{"op":"set","c2s":{"delay_ms":-1}}',
            '{"op":"set","c2s":{"loss":' + "9" * 400 + "}}",
            '{"op":"unknown"}',
            "x" * 17000,
        ):
            with self.subTest(command=command[:100]):
                response = proxy.raw(command)
                self.assertFalse(response["ok"])
                status = proxy.command()
                self.assertEqual(status["epoch"], 0)
                self.assertEqual(status["faults"]["c2s"]["loss"], 0)

    def test_rejects_non_loopback_or_ambiguous_endpoints_before_listening(self):
        for flag, endpoint in (
            ("--listen", "0.0.0.0:0"),
            ("--listen", "192.168.1.2:0"),
            ("--upstream", "8.8.8.8:3478"),
            ("--upstream", "localhost:3478"),
            ("--upstream", "127.0.0.1:0"),
            ("--upstream", "[::ffff:8.8.8.8]:3478"),
        ):
            with self.subTest(endpoint=endpoint):
                result = subprocess.run(
                    [
                        sys.executable,
                        str(PROXY),
                        "--upstream",
                        "127.0.0.1:9",
                        flag,
                        endpoint,
                    ],
                    capture_output=True,
                    timeout=3,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")

    def test_stop_eof_and_runtime_limit_release_sockets_and_pending_data(self):
        for mode in ("stop", "eof", "timeout", "signal"):
            with self.subTest(mode=mode):
                proxy = self.proxy(
                    "--max-runtime-seconds", "0.4" if mode == "timeout" else "10"
                )
                client = self.client(proxy.endpoint)
                proxy.command("set", c2s={"delay_ms": 1000})
                client.send(b"pending")
                proxy.wait_status(lambda s: s["queued_datagrams"] == 1)
                if mode == "stop":
                    proxy.command("stop")
                elif mode == "eof":
                    proxy.process.stdin.close()
                elif mode == "signal":
                    if sys.platform == "win32":
                        continue  # Windows terminate is forceful; EOF/stop are portable.
                    proxy.process.terminate()
                event = proxy.event()
                self.assertEqual(event["event"], "stopped")
                self.assertEqual(event["status"]["queued_datagrams"], 0)
                self.assertEqual(event["status"]["mappings"], 0)
                proxy.process.wait(timeout=3)
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reused:
                    reused.bind(proxy.endpoint)

    def test_stalled_stdout_cannot_prevent_bounded_shutdown(self):
        process = subprocess.Popen(
            [
                sys.executable,
                str(PROXY),
                "--upstream",
                f"127.0.0.1:{self.echo.endpoint[1]}",
                "--max-runtime-seconds",
                "0.2",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            process.stdin.write((b'{"op":"status"}\n') * 100)
            process.stdin.flush()
            process.wait(timeout=3)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
