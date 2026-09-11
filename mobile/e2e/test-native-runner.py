#!/usr/bin/env python3
"""Native runner setup regressions without SDKs or a simulated acceptance pass."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "native_runner", Path(__file__).with_name("run-native-acceptance.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-2"
DEVICE = "simulator-fixture-uuid"


class NativeRunnerSetup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-runner-test-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        build = root / "build"
        build.mkdir()
        self.artifact = build / "SPAWND.app"
        self.artifact.mkdir()
        (build / "native-artifact.txt").write_text(str(self.artifact))
        (build / "acceptance-build.json").write_text(
            json.dumps(
                {
                    "candidate_commit": "candidate",
                    "source_clean": True,
                    "platform": "ios",
                    "app_id": module.APP_ID,
                    "schema_kind": "native_simulator",
                }
            )
        )
        ready = root / "ready.json"
        ready.write_text(
            json.dumps({"candidateCommit": "candidate", "token": "fixture-secret"})
        )
        self.runner = module.Runner(
            argparse.Namespace(
                build=build,
                output=root / "evidence",
                ready_file=ready,
                platform="ios",
                fixture_url="http://127.0.0.1:18100",
                device=None,
                timeout=60,
            )
        )
        self.runner.control = Mock(
            return_value={
                "bearerToken": "first-account-secret",
                "secondAccount": {"bearerToken": "second-account-secret"},
            }
        )
        self.runner.launch = Mock()
        self.runner.event = Mock()
        self.runner.collect_logs = Mock()

    def completed(self, command, **kwargs):
        if command[:4] == ("xcrun", "simctl", "list", "devices"):
            stdout = json.dumps(
                {
                    "devices": {
                        RUNTIME: [
                            {
                                "name": "iPhone fixture",
                                "state": "Shutdown",
                                "udid": DEVICE,
                            },
                        ]
                    }
                }
            )
        elif command[0] == "xcodebuild":
            stdout = "Xcode 16.4\nBuild version 16F6"
        else:
            stdout = "completed"
        return subprocess.CompletedProcess(command, 0, stdout, "diagnostic stderr")

    def test_selected_platform_exists_before_install_and_cold_install_has_bounded_budget(
        self,
    ):
        calls = []

        def subprocess_run(command, **kwargs):
            calls.append((command, kwargs))
            if command[:3] == ("xcrun", "simctl", "install"):
                info = json.loads(
                    (self.runner.args.output / "native-platform.json").read_text()
                )
                self.assertEqual(info["device"], DEVICE)
                self.assertEqual(info["runtime"], RUNTIME)
                self.assertEqual(info["phase"], "installing")
                self.assertGreater(info["disk_free_bytes"], 0)
                self.assertEqual(kwargs["timeout"], 600)
            return self.completed(command, **kwargs)

        with patch.object(module.subprocess, "run", side_effect=subprocess_run):
            self.runner.install()
        self.assertEqual(
            sum(command[:3] == ("xcrun", "simctl", "install") for command, _ in calls),
            1,
        )
        self.runner.launch.assert_called_once()
        self.runner.event.assert_called_once()

    def test_failed_setup_is_reported_without_launching_or_retrying(self):
        install_calls = 0

        def subprocess_run(command, **kwargs):
            nonlocal install_calls
            if command[:3] == ("xcrun", "simctl", "install"):
                install_calls += 1
                raise subprocess.TimeoutExpired(
                    command,
                    kwargs["timeout"],
                    output=b"first-account-secret installer started",
                    stderr=b"second-account-secret install service busy",
                )
            return self.completed(command, **kwargs)

        with patch.object(module.subprocess, "run", side_effect=subprocess_run):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.runner.execute()
        self.assertEqual(install_calls, 1)
        self.runner.launch.assert_not_called()
        self.runner.collect_logs.assert_called_once()
        self.runner.event.assert_called_once_with(
            "runner-error", {"error": unittest.mock.ANY}, status="failed"
        )
        records = [
            json.loads(line)
            for line in (self.runner.args.output / "native-runner.jsonl")
            .read_text()
            .splitlines()
        ]
        failure = records[-1]
        self.assertEqual(failure["status"], "failed")
        self.assertEqual(failure["error_type"], "TimeoutExpired")
        self.assertIn("installer started", failure["stdout"])
        self.assertIn("install service busy", failure["stderr"])
        self.assertNotIn("account-secret", json.dumps(records))
        self.assertGreaterEqual(failure["elapsed_seconds"], 0)
        self.assertGreater(failure["disk_free_bytes"], 0)

    def test_nonzero_command_retains_both_streams_and_exit_status(self):
        error = subprocess.CalledProcessError(
            7,
            ("xcrun", "simctl", "boot"),
            output="boot stdout",
            stderr="boot stderr fixture-secret",
        )
        with patch.object(module.subprocess, "run", side_effect=error):
            with self.assertRaises(subprocess.CalledProcessError):
                self.runner.command("xcrun", "simctl", "boot", DEVICE)
        record = json.loads(
            (self.runner.args.output / "native-runner.jsonl")
            .read_text()
            .splitlines()[-1]
        )
        self.assertEqual(record["returncode"], 7)
        self.assertEqual(record["stdout"], "boot stdout")
        self.assertEqual(record["stderr"], "boot stderr [REDACTED]")

    def test_real_timed_out_child_keeps_partial_stdout_and_stderr(self):
        script = (
            "import sys, time; "
            "print('installer stdout fixture-secret', flush=True); "
            "print('installer stderr', file=sys.stderr, flush=True); "
            "time.sleep(60)"
        )
        with self.assertRaises(subprocess.TimeoutExpired):
            self.runner.command(sys.executable, "-c", script, timeout=1)
        record = json.loads(
            (self.runner.args.output / "native-runner.jsonl")
            .read_text()
            .splitlines()[-1]
        )
        self.assertIn("installer stdout [REDACTED]", record["stdout"])
        self.assertIn("installer stderr", record["stderr"])
        self.assertEqual(record["timeout_seconds"], 1)
        self.assertEqual(record["error_type"], "TimeoutExpired")

    def test_failure_reporting_cannot_replace_the_original_setup_error(self):
        error = RuntimeError("native setup failed")
        self.runner.install = Mock(side_effect=error)
        self.runner.event.side_effect = ConnectionError("fixture unavailable")
        with self.assertRaisesRegex(RuntimeError, "native setup failed"):
            self.runner.execute()


if __name__ == "__main__":
    unittest.main()
