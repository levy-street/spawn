#!/usr/bin/env python3
"""Fixture boundary regressions; --integration also provisions a real API/daemon."""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture_module = load("native-acceptance-fixture")
suite = load("native-acceptance-suite")


class FixtureBoundaries(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.output = tempfile.TemporaryDirectory(prefix="native-boundary-")
        self.fixture = fixture_module.Fixture(
            argparse.Namespace(
                output=Path(self.output.name), port=18100, client_host="127.0.0.1"
            )
        )

    def tearDown(self):
        shutil.rmtree(self.fixture.scratch)
        self.output.cleanup()

    def test_events_reject_non_objects_and_missing_type(self):
        for invalid in ([], None, "event", {}, {"type": []}):
            with self.assertRaises(ValueError):
                self.fixture.record(invalid)
        self.assertEqual(self.fixture.events, [])

    def test_events_are_bounded_before_writing(self):
        with self.assertRaises(ValueError):
            self.fixture.record({"type": "transport", "details": "x" * 65536})
        self.fixture.events = [{}] * fixture_module.MAX_EVENTS
        with self.assertRaises(ValueError):
            self.fixture.record({"type": "transport"})
        self.assertFalse((self.fixture.output / "events.jsonl").exists())

    async def answer(self, details, status="passed"):
        while not self.fixture.commands:
            await asyncio.sleep(0)
        command = self.fixture.commands.popleft()
        self.fixture.record(
            {
                "type": "command",
                "commandId": command["id"],
                "status": status,
                "details": details,
            }
        )

    async def test_wrong_candidate_cannot_acknowledge_command(self):
        reply = asyncio.create_task(
            self.answer(
                {"candidate_commit": "0" * 40, "values": {"result": {"ready": True}}}
            )
        )
        with self.assertRaisesRegex(RuntimeError, "wrong candidate"):
            await self.fixture.command("snapshot", timeout=1)
        await reply

    async def test_failed_native_action_cannot_pass(self):
        reply = asyncio.create_task(
            self.answer({"candidate_commit": self.fixture.candidate}, "failed")
        )
        with self.assertRaisesRegex(RuntimeError, "failed"):
            await self.fixture.command("snapshot", timeout=1)
        await reply

    async def test_command_without_app_times_out(self):
        with self.assertRaises(TimeoutError):
            await self.fixture.command("snapshot", timeout=0.01)

    def test_private_ready_file_is_not_world_readable(self):
        path = self.fixture.output / "ready.json"
        fixture_module.write_json(path, {"token": "disposable"}, private=True)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_stun_does_not_count_as_relay_application_data(self):
        status = {
            "totals": {
                direction: {
                    "classes": {
                        "stun": {"forwarded": 99},
                        "turn_channel_data": {
                            "received": 7,
                            "forwarded": 3,
                            "dropped": 4,
                        },
                    },
                    "dropped": {"packets": 4},
                }
                for direction in ("c2s", "s2c")
            }
        }
        self.assertEqual(suite.data_packets(status, "data"), 6)
        self.assertEqual(suite.data_packets(status, "dropped_packets"), 8)
        self.assertEqual(suite.data_packets(status, "dropped_data"), 8)


def integration():
    """Test actual HTTP authorization and process cleanup using our own fixture."""
    with tempfile.TemporaryDirectory(prefix="native-api-test-") as temporary:
        directory = Path(temporary)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        ready = directory / "ready.json"
        origin = f"http://127.0.0.1:{port}"
        log_path = directory / "fixture.log"
        with log_path.open("w") as log:
            process = subprocess.Popen(
                [
                    str(ROOT / "server/.venv/bin/python"),
                    str(ROOT / "scripts/native-acceptance-fixture.py"),
                    "--port",
                    str(port),
                    "--output",
                    str(directory / "evidence"),
                    "--ready-file",
                    str(ready),
                    "--transport",
                    "direct",
                    "--timeout",
                    "120",
                ],
                cwd=ROOT,
                stdout=log,
                stderr=log,
            )
        scratch = None
        try:
            deadline = time.monotonic() + 60
            while not ready.exists():
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise AssertionError(
                        "fixture did not provision: " + log_path.read_text()
                    )
                time.sleep(0.1)
            configuration = json.loads(ready.read_text())

            def request(path, *, bearer=None, control=None, body=None):
                headers = {}
                if bearer:
                    headers["Authorization"] = f"Bearer {bearer}"
                if control:
                    headers["X-Acceptance-Token"] = control
                data = None if body is None else json.dumps(body).encode()
                if data is not None:
                    headers["Content-Type"] = "application/json"
                req = urllib.request.Request(origin + path, data=data, headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=10) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, None

            assert request("/__acceptance/bootstrap")[0] == 403
            assert request("/__acceptance/bootstrap", control="wrong")[0] == 403
            status, bootstrap = request(
                "/__acceptance/bootstrap", control=configuration["token"]
            )
            assert status == 200
            scratch = Path(bootstrap["cwd"]).parent
            first, second = (
                bootstrap["bearerToken"],
                bootstrap["secondAccount"]["bearerToken"],
            )
            assert (
                request("/api/me", bearer=first)[1]["user"]["id"]
                == bootstrap["accountId"]
            )
            assert (
                request("/api/me", bearer=second)[1]["user"]["id"]
                == bootstrap["secondAccount"]["accountId"]
            )
            assert request("/api/hosts", bearer=second) == (200, [])
            assert (
                request("/api/sessions/" + bootstrap["sessionA"], bearer=second)[0]
                == 404
            )
            assert (
                request(
                    "/__acceptance/device",
                    control=configuration["token"],
                    body={"deviceId": "unregistered", "publicKey": "wrong"},
                )[0]
                == 400
            )
            assert (
                request("/__acceptance/event", control=configuration["token"], body=[])[
                    0
                ]
                == 400
            )
            assert not (directory / "evidence/evidence.json").exists(), (
                "API provisioning is not native evidence"
            )
        finally:
            process.terminate()
            try:
                process.wait(timeout=40)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise AssertionError(
                    "fixture did not shut down its children promptly"
                ) from None
        assert process.returncode == 0, log_path.read_text()
        assert scratch is not None and not scratch.exists(), (
            "disposable fixture directory was not cleaned"
        )
        assert "Traceback" not in log_path.read_text(), log_path.read_text()
        print("Real API/daemon fixture boundaries and shutdown passed")


if __name__ == "__main__":
    run_integration = "--integration" in sys.argv
    if run_integration:
        sys.argv.remove("--integration")
    result = unittest.main(exit=False).result
    if not result.wasSuccessful():
        raise SystemExit(1)
    if run_integration:
        integration()
