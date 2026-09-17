#!/usr/bin/env python3
"""Fixture boundary regressions; --integration also provisions a real API/daemon."""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import hashlib
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture_module = load("native-acceptance-fixture")
suite = load("native-acceptance-suite")


class FixtureBoundaries(unittest.IsolatedAsyncioTestCase):
    def test_lifecycle_interval_uses_retained_callbacks_after_the_case_start(self):
        before = {"launchId": "same-process", "lifecycleSequence": 3}
        after = {
            "launchId": "same-process", "lifecycleSequence": 6,
            "lifecycleTransitions": [
                {"sequence": 1, "state": "inactive", "nativeDateMs": 100},
                {"sequence": 2, "state": "background", "nativeDateMs": 200},
                {"sequence": 3, "state": "active", "nativeDateMs": 300},
                {"sequence": 4, "state": "inactive", "nativeDateMs": 1000},
                {"sequence": 5, "state": "background", "nativeDateMs": 1100},
                {"sequence": 6, "state": "active", "nativeDateMs": 1600},
            ],
        }
        self.assertEqual(suite.lifecycle_interval(before, after), (1100, 1600))
        after["lifecycleSequence"] = 3
        after["lifecycleTransitions"] = after["lifecycleTransitions"][:3]
        self.assertIsNone(suite.lifecycle_interval(before, after))

    def test_lifecycle_interval_waits_for_real_background_and_active_callbacks(self):
        before = {"launchId": "same-process", "lifecycleSequence": 0}
        after = {
            "launchId": "same-process", "lifecycleSequence": 1,
            "lifecycleTransitions": [{"sequence": 1, "state": "inactive", "nativeDateMs": 100}],
        }
        self.assertIsNone(suite.lifecycle_interval(before, after))
        after["lifecycleSequence"] = 2
        after["lifecycleTransitions"].append({"sequence": 2, "state": "active", "nativeDateMs": 200})
        self.assertIsNone(suite.lifecycle_interval(before, after))

    def test_lifecycle_interval_rejects_missing_or_replaced_evidence(self):
        before = {"launchId": "same-process", "lifecycleSequence": 0}
        after = {
            "launchId": "same-process", "lifecycleSequence": 2,
            "lifecycleTransitions": [
                {"sequence": 1, "state": "background", "nativeDateMs": 100},
                {"sequence": 2, "state": "active", "nativeDateMs": 200},
            ],
        }
        for mutate in (
            lambda value: value.update(launchId="new-process"),
            lambda value: value.update(lifecycleSequence=3),
            lambda value: value["lifecycleTransitions"].pop(0),
            lambda value: value["lifecycleTransitions"][1].update(nativeDateMs=50),
        ):
            with self.subTest(mutate=mutate):
                changed = json.loads(json.dumps(after))
                mutate(changed)
                with self.assertRaises(AssertionError):
                    suite.lifecycle_interval(before, changed)

    def setUp(self):
        self.output = tempfile.TemporaryDirectory(prefix="native-boundary-")
        self.fixture = fixture_module.Fixture(
            argparse.Namespace(
                output=Path(self.output.name),
                port=18100,
                client_host="127.0.0.1",
                transport="direct",
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

    async def test_preparation_copies_pair_without_live_provisioning(self):
        source = self.fixture.scratch / "source"
        source.mkdir()
        for name in ("spawnd", "spawn-worker"):
            binary = source / name
            binary.write_text(
                f"#!/bin/sh\nprintf '%s\\n' '{name} 0.1.0+g{self.fixture.candidate[:12]}'\n"
            )
            binary.chmod(0o700)
        self.fixture.args.daemon = source / "spawnd"
        await self.fixture.prepare_binaries()
        shutil.rmtree(source)  # Cargo cleanup cannot invalidate private copies.
        for name, identity in self.fixture.binary_identity.items():
            copied = self.fixture.binary_dir / name
            self.assertTrue(identity["candidate_match"])
            self.assertEqual(
                identity["sha256"], hashlib.sha256(copied.read_bytes()).hexdigest()
            )
        self.assertEqual(self.fixture.account_id, "")
        self.assertEqual(self.fixture.sessions, [])
        self.assertIsNone(self.fixture.daemon)
        self.assertIsNone(self.fixture.bootstrap)
        config = self.fixture.configuration()
        self.assertEqual(
            set(config),
            {"runId", "candidateCommit", "apiUrl", "iceServers", "forceRelay"},
        )
        self.assertNotIn(self.fixture.token, json.dumps(config))

    async def test_start_is_prompt_and_exactly_once_until_verified_ready(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def provision():
            entered.set()
            await release.wait()

        self.fixture.phase = "prepared"
        self.fixture.provision = AsyncMock(side_effect=provision)
        self.fixture.runtime_ready = AsyncMock(return_value=True)
        first = self.fixture.start_provisioning()
        task = self.fixture.provision_task
        await asyncio.wait_for(entered.wait(), 1)
        for _ in range(5):
            self.assertEqual(self.fixture.start_provisioning()["phase"], "starting")
            self.assertIs(self.fixture.provision_task, task)
        self.assertFalse(first["ready"])
        with self.assertRaisesRegex(ValueError, "not ready"):
            await self.fixture.bootstrap_state()
        release.set()
        await asyncio.wait_for(task, 1)
        self.assertEqual(self.fixture.start_provisioning()["phase"], "ready")
        self.fixture.provision.assert_awaited_once()
        self.fixture.runtime_ready.assert_awaited_once()

    async def test_provision_failure_is_permanent_and_redacted_before_boot(self):
        self.fixture.phase = "prepared"
        self.fixture.provision = AsyncMock(
            side_effect=ValueError("private-token-secret")
        )
        self.fixture.start_provisioning()
        await self.fixture.provision_task
        with self.assertRaisesRegex(RuntimeError, "provisioning failed"):
            self.fixture.start_provisioning()
        self.fixture.provision.assert_awaited_once()
        status = self.fixture.status()
        self.assertEqual(status["phase"], "failed")
        self.assertFalse(status["ready"])
        report = json.loads((self.fixture.output / "evidence.json").read_text())
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["cases"], [])
        self.assertEqual(
            report["failure_reason"], "fixture provisioning failed (ValueError)"
        )
        self.assertNotIn(
            "private-token",
            (self.fixture.output / "fixture-lifecycle.jsonl").read_text(),
        )

    async def test_pending_provisioning_has_a_fixed_failure_deadline(self):
        self.fixture.phase = "prepared"
        self.fixture.provision = AsyncMock(side_effect=asyncio.Event().wait)
        with patch.object(fixture_module, "PROVISION_TIMEOUT_SECONDS", 0.01):
            self.fixture.start_provisioning()
            await asyncio.wait_for(self.fixture.provision_task, 1)
        self.assertEqual(self.fixture.status()["phase"], "failed")
        self.assertEqual(
            self.fixture.failed, "fixture provisioning failed (TimeoutError)"
        )
        self.fixture.provision.assert_awaited_once()

    async def test_cleanup_cancels_pending_provisioning_and_joins_owned_child(self):
        entered = asyncio.Event()

        async def provision():
            await self.fixture.child(
                [sys.executable, "-c", "import time; time.sleep(30)"], "daemon"
            )
            entered.set()
            await asyncio.Event().wait()

        self.fixture.phase = "prepared"
        self.fixture.provision = AsyncMock(side_effect=provision)
        self.fixture.start_provisioning()
        await asyncio.wait_for(entered.wait(), 1)
        await asyncio.wait_for(self.fixture.close(), 2)
        self.assertTrue(self.fixture.provision_task.cancelled())
        self.assertIsNotNone(self.fixture.children[0].returncode)
        self.assertIsNone(self.fixture.failed)

    async def test_health_before_start_never_marks_fixture_ready_or_failed(self):
        self.fixture.phase = "prepared"
        with self.assertRaisesRegex(RuntimeError, "not ready"):
            await self.fixture.health()
        self.assertEqual(self.fixture.status()["phase"], "prepared")
        self.assertIsNone(self.fixture.failed)

    async def test_health_rechecks_api_and_permanently_fails_lost_readiness(self):
        self.fixture.phase = "ready"
        self.fixture.runtime_ready = AsyncMock(side_effect=[True, False])
        healthy = await self.fixture.health()
        self.assertEqual(healthy["runId"], self.fixture.run_id)
        self.assertEqual(healthy["candidateCommit"], self.fixture.candidate)
        self.assertTrue(healthy["ready"])
        with self.assertRaisesRegex(RuntimeError, "readiness was lost"):
            await self.fixture.health()
        with self.assertRaises(RuntimeError):
            await self.fixture.health()
        self.assertEqual(self.fixture.runtime_ready.await_count, 2)
        self.assertEqual(self.fixture.status()["phase"], "failed")

    async def test_exited_owned_child_fails_waiting_suite_without_native_cases(self):
        self.configure_suite()
        self.fixture.phase = "prepared"
        exercise = asyncio.create_task(suite.exercise(self.fixture))
        child = await self.fixture.child([sys.executable, "-c", "pass"], "daemon")
        await child.wait()
        with self.assertRaisesRegex(RuntimeError, "daemon exited unexpectedly"):
            await asyncio.wait_for(exercise, 2)
        report = json.loads((self.fixture.output / "evidence.json").read_text())
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["cases"], [])
        self.assertIn("daemon exited unexpectedly", report["failure_reason"])
        lifecycle = [
            json.loads(row)
            for row in (self.fixture.output / "fixture-lifecycle.jsonl")
            .read_text()
            .splitlines()
        ]
        self.assertEqual(len(lifecycle), 1)
        self.assertIn("at", lifecycle[0])
        await self.fixture.close()

    async def test_intentional_cleanup_does_not_report_unexpected_child_exit(self):
        await self.fixture.child(
            [sys.executable, "-c", "import time; time.sleep(30)"], "turn"
        )
        await self.fixture.close()
        self.assertIsNone(self.fixture.failed)
        self.assertTrue(self.fixture.closed.is_set())

    async def test_late_owned_child_exit_fails_previously_passing_evidence(self):
        path = self.fixture.output / "evidence.json"
        cases = [
            {"id": "shared_transport", "status": "passed", "metrics": {"live_peers": 1}}
        ]
        fixture_module.write_json(
            path,
            {
                "candidate_commit": self.fixture.candidate,
                "status": "passed",
                "cases": cases,
            },
        )
        self.fixture.phase = "ready"
        child = await self.fixture.child(
            [sys.executable, "-c", "raise SystemExit(7)"], "turn"
        )
        await child.wait()
        await asyncio.wait_for(self.fixture.failure_event.wait(), 1)
        self.fixture.fail("later failure must not replace the original reason")
        report = json.loads(path.read_text())
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["cases"], cases)
        self.assertEqual(report["candidate_commit"], self.fixture.candidate)
        self.assertEqual(
            report["failure_reason"], "fixture turn exited unexpectedly (code 7)"
        )
        self.assertFalse(self.fixture.status()["ready"])
        await self.fixture.close()

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

    def configure_suite(self):
        self.fixture.args.baseline = "a" * 40
        self.fixture.args.transport = "relay"
        self.fixture.args.timeout = 1
        self.fixture.binary_identity = {}
        self.fixture.command = AsyncMock(return_value={})

    def test_revocation_binds_the_observed_native_key_and_candidate(self):
        self.fixture.anchor = {"id": "anchor-device"}
        self.fixture.record(
            {
                "type": "identity",
                "details": {
                    "candidate_commit": self.fixture.candidate,
                    "values": {"deviceId": "native-device", "publicKey": "a" * 43},
                },
            }
        )
        self.fixture.record(
            {
                "type": "identity",
                "details": {
                    "candidate_commit": "wrong-candidate",
                    "values": {"deviceId": "native-device", "publicKey": "b" * 43},
                },
            }
        )
        self.assertEqual(
            suite.native_revocation_body(self.fixture, "native-device"),
            {
                "expected_public_key": "a" * 43,
                "revoked_by_device_id": "anchor-device",
            },
        )
        with self.assertRaisesRegex(AssertionError, "identity was not observed"):
            suite.native_revocation_body(self.fixture, "another-device")

    async def test_runner_setup_error_keeps_reason_without_passing_native_cases(self):
        self.configure_suite()
        self.fixture.record(
            {
                "type": "native-command",
                "status": "failed",
                "details": {
                    "candidate_commit": self.fixture.candidate,
                    "values": {
                        "action": "runner-error",
                        "result": {"error": "simctl install exceeded its deadline"},
                    },
                },
            }
        )
        with self.assertRaisesRegex(RuntimeError, "simctl install exceeded"):
            await suite.exercise(self.fixture)
        report = json.loads((self.fixture.output / "evidence.json").read_text())
        self.assertEqual(report["status"], "failed")
        self.assertIn("simctl install exceeded", report["failure_reason"])
        self.assertEqual(report["cases"], [])
        self.fixture.command.assert_any_await(
            "finish",
            {"status": "failed", "reason": report["failure_reason"]},
            native=True,
            timeout=10,
        )

    async def test_interrupted_setup_never_leaves_an_empty_failure_reason(self):
        self.configure_suite()
        task = asyncio.create_task(suite.exercise(self.fixture))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        report = json.loads((self.fixture.output / "evidence.json").read_text())
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["cases"], [])
        self.assertEqual(
            report["failure_reason"], "native acceptance interrupted before completion"
        )

    async def test_missing_app_boot_uses_its_own_budget_after_fixture_readiness(self):
        self.configure_suite()
        self.fixture.args.timeout = 60
        self.fixture.phase = "ready"
        self.fixture.health = AsyncMock(return_value={"ready": True})
        with patch.object(suite, "NATIVE_BOOT_TIMEOUT_SECONDS", 0.01, create=True):
            with self.assertRaisesRegex(AssertionError, "native app never booted"):
                await asyncio.wait_for(suite.exercise(self.fixture), 0.5)
        report = json.loads((self.fixture.output / "evidence.json").read_text())
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["cases"], [])
        self.assertIn("native app never booted", report["failure_reason"])
        self.fixture.command.assert_any_await(
            "finish",
            {"status": "failed", "reason": report["failure_reason"]},
            native=True,
            timeout=10,
        )

    async def test_http_trace_is_bounded_and_excludes_request_secrets(self):
        messages = []

        async def app(scope, _receive, send):
            scope["route"] = SimpleNamespace(path="/api/hosts/{host_id}")
            await send({"type": "http.response.start", "status": 401})
            await send({"type": "http.response.body", "body": b"private response"})

        async def send(message):
            messages.append(message)

        path = self.fixture.output / "api-requests.jsonl"
        trace = fixture_module.ApiRequestTrace(app, path)
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/api/hosts/private-host",
            "query_string": b"token=private-query",
            "headers": [
                (b"authorization", b"Bearer private-bearer"),
                (b"cookie", b"private-cookie"),
                (b"x-spawn-client", b"private-client"),
            ],
        }
        await trace(scope, None, send)
        entry = json.loads(path.read_text())
        self.assertEqual(entry["route"], "/api/hosts/{host_id}")
        self.assertEqual(entry["status"], 401)
        self.assertTrue(entry["has_bearer"])
        self.assertTrue(entry["has_client_id"])
        self.assertNotIn("private", path.read_text())
        trace.count = fixture_module.MAX_EVENTS
        await trace(scope, None, send)
        self.assertEqual(len(path.read_text().splitlines()), 1)
        self.assertEqual(len(messages), 4)

    async def test_control_failures_are_observable_without_tokens_or_unknown_paths(
        self,
    ):
        async def app(scope, _receive, send):
            scope["route"] = SimpleNamespace(path="/__acceptance/{path}")
            await send({"type": "http.response.start", "status": 403})
            await send({"type": "http.response.body", "body": b"private response"})

        send = AsyncMock()
        path = self.fixture.output / "api-requests.jsonl"
        trace = fixture_module.ApiRequestTrace(app, path)
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/__acceptance/private-path",
            "path_params": {"path": "bootstrap"},
            "query_string": b"private-query",
            "headers": [(b"x-acceptance-token", b"private-control-token")],
        }
        await trace(scope, None, send)
        self.assertTrue(
            path.exists(), "failed controller bootstrap had no HTTP diagnostic"
        )
        entry = json.loads(path.read_text())
        self.assertEqual(entry["control"], "bootstrap")
        self.assertEqual(entry["status"], 403)
        self.assertTrue(entry["has_control_token"])
        self.assertNotIn("private", path.read_text())
        scope["path_params"]["path"] = "private-unknown-control"
        await trace(scope, None, send)
        self.assertEqual(len(path.read_text().splitlines()), 1)
        scope["path_params"]["path"] = "event"
        trace.count = fixture_module.MAX_EVENTS
        await trace(scope, None, send)
        self.assertEqual(len(path.read_text().splitlines()), 1)
        self.assertEqual(send.await_count, 6)


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
                    return error.code, json.load(error)

            assert request("/__acceptance/bootstrap")[0] == 403
            assert request("/__acceptance/bootstrap", control="wrong")[0] == 403
            for path in ("config", "status", "health", "start"):
                assert (
                    request(
                        f"/__acceptance/{path}", body={} if path == "start" else None
                    )[0]
                    == 403
                )
            status, config = request(
                "/__acceptance/config", control=configuration["token"]
            )
            assert status == 200 and config["runId"] == configuration["runId"]
            assert set(config) == {
                "runId",
                "candidateCommit",
                "apiUrl",
                "iceServers",
                "forceRelay",
            }
            assert configuration["token"] not in json.dumps(config)
            status, prepared = request(
                "/__acceptance/status", control=configuration["token"]
            )
            assert (
                status == 200
                and prepared["phase"] == "prepared"
                and not prepared["ready"]
            )
            assert prepared["children"] == [], (
                "pre-build direct fixture started a daemon"
            )
            pair = json.loads((directory / "evidence/native-binaries.json").read_text())
            assert set(pair) == {"spawnd", "spawn-worker"}
            assert all(len(item["sha256"]) == 64 for item in pair.values())
            assert (
                request("/__acceptance/health", control=configuration["token"])[0]
                == 503
            )
            assert (
                request("/__acceptance/bootstrap", control=configuration["token"])[0]
                == 503
            )
            began = time.monotonic()
            status, starting = request(
                "/__acceptance/start", control=configuration["token"], body={}
            )
            assert time.monotonic() - began < 5, "start blocked on provisioning"
            assert status == 200 and starting["phase"] == "starting"
            assert not starting["ready"]
            assert (
                request("/__acceptance/start", control=configuration["token"], body={})[
                    0
                ]
                == 200
            )
            deadline = time.monotonic() + 90
            while True:
                status, state = request(
                    "/__acceptance/status", control=configuration["token"]
                )
                assert status == 200 and state["phase"] != "failed", state
                if state["ready"]:
                    break
                assert time.monotonic() < deadline, "live fixture readiness timed out"
                time.sleep(0.1)
            status, health = request(
                "/__acceptance/health", control=configuration["token"]
            )
            assert status == 200 and health["phase"] == "ready" and health["ready"]
            assert (
                health["runId"] == config["runId"]
                and health["candidateCommit"] == config["candidateCommit"]
            )
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
            assert request("/api/me")[0] == 401
            trace = (directory / "evidence/api-requests.jsonl").read_text()
            assert first not in trace and second not in trace
            records = [json.loads(line) for line in trace.splitlines()]
            assert any(
                row["route"] == "/api/me" and row["status"] == 200 and row["has_bearer"]
                for row in records
            )
            assert any(
                row["route"] == "/api/me"
                and row["status"] == 401
                and not row["has_bearer"]
                for row in records
            )
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
            # Exercise the native suite's exact revocation payload against the
            # real API. This extra device belongs only to this disposable user.
            from cryptography.hazmat.primitives.asymmetric.ed25519 import (
                Ed25519PrivateKey,
            )

            sys.path.insert(0, str(ROOT / "server"))
            from spawn_server.browser_registration import (
                encode_browser_registration_transcript,
            )

            anchor = request("/api/browser-devices", bearer=first)[1][0]
            key = Ed25519PrivateKey.generate()
            public = key.public_key().public_bytes_raw()
            public_key = fixture_module.encoded(public)
            transcript = encode_browser_registration_transcript(
                bootstrap["accountId"], public, is_root=False
            )
            status, device = request(
                "/api/browser-devices/register",
                bearer=first,
                body={
                    "key_algorithm": "ed25519",
                    "public_key": public_key,
                    "signature": fixture_module.encoded(key.sign(transcript)),
                },
            )
            assert status == 200
            assert (
                request(
                    "/__acceptance/device",
                    control=configuration["token"],
                    body={
                        "deviceId": device["id"],
                        "publicKey": public_key,
                    },
                )[0]
                == 200
            )
            identity = {
                "type": "identity",
                "details": {
                    "candidate_commit": config["candidateCommit"],
                    "values": {"deviceId": device["id"], "publicKey": public_key},
                },
            }
            observed = SimpleNamespace(
                candidate=config["candidateCommit"], anchor=anchor, events=[identity]
            )
            revoke_path = f"/api/browser-devices/{device['id']}/revoke"
            assert (
                request(
                    revoke_path,
                    bearer=first,
                    body={"revoked_by_device_id": anchor["id"]},
                )[0]
                == 422
            )
            status, revoked = request(
                revoke_path,
                bearer=first,
                body=suite.native_revocation_body(observed, device["id"]),
            )
            assert status == 200 and revoked["revoked_at"] is not None
            assert (
                revoked["public_key"] == public_key
                and revoked["revoked_by_device_id"] == anchor["id"]
            )
            denylist = request("/api/browser-devices/revoked-keys", bearer=first)[1]
            assert any(row["public_key"] == public_key for row in denylist)
            print(
                "Native revocation payload: old request422; observed-key request200 and permanent deny-list verified"
            )
            owned = [row for row in health["children"] if row["name"] == "daemon"]
            assert len(owned) == 1 and owned[0]["returncode"] is None
            os.kill(owned[0]["pid"], signal.SIGTERM)
            deadline = time.monotonic() + 5
            while True:
                status, unhealthy = request(
                    "/__acceptance/health", control=configuration["token"]
                )
                if status == 503:
                    break
                assert time.monotonic() < deadline, "dead daemon remained healthy"
                time.sleep(0.05)
            assert unhealthy["phase"] == "failed" and not unhealthy["ready"]
            assert "daemon exited unexpectedly" in unhealthy["failure_reason"]
            assert (
                request("/__acceptance/start", control=configuration["token"], body={})[
                    0
                ]
                == 503
            )
            process.wait(timeout=40)
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=40)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise AssertionError(
                    "fixture did not shut down its children promptly"
                ) from None
        assert process.returncode != 0, "unexpected daemon death must fail the fixture"
        assert scratch is not None and not scratch.exists(), (
            "disposable fixture directory was not cleaned"
        )
        report = json.loads((directory / "evidence/evidence.json").read_text())
        assert report["status"] == "failed" and report["cases"] == []
        assert report["cleanup_passed"] is True
        assert "daemon exited unexpectedly" in report["failure_reason"]
        trace_path = directory / "evidence/api-requests.jsonl"
        traced = [json.loads(row) for row in trace_path.read_text().splitlines()]
        refused_bootstrap = [
            row
            for row in traced
            if row.get("control") == "bootstrap" and row["status"] == 403
        ]
        assert {row["has_control_token"] for row in refused_bootstrap} == {True, False}
        assert configuration["token"] not in trace_path.read_text()
        lifecycle = [
            json.loads(row)
            for row in (directory / "evidence/fixture-lifecycle.jsonl")
            .read_text()
            .splitlines()
        ]
        assert [row["event"] for row in lifecycle].count("starting") == 1
        assert [row["event"] for row in lifecycle].count("ready") == 1
        assert lifecycle[-1]["event"] == "failed"
        print(
            "Real API/daemon prepared/start/health, account isolation, daemon-kill failure and cleanup passed (orchestration only; no native candidate claim)"
        )


if __name__ == "__main__":
    run_integration = "--integration" in sys.argv
    if run_integration:
        sys.argv.remove("--integration")
    result = unittest.main(exit=False).result
    if not result.wasSuccessful():
        raise SystemExit(1)
    if run_integration:
        integration()
