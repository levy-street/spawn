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
            json.dumps({"candidateCommit": "candidate", "runId": "fixture-run", "token": "fixture-secret"})
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
        self.ready_status = {
            "runId": "fixture-run", "candidateCommit": "candidate", "phase": "ready", "ready": True,
        }
        self.bootstrap = {
                **self.ready_status,
                "bearerToken": "first-account-secret",
                "secondAccount": {"bearerToken": "second-account-secret"},
        }
        self.runner.control = Mock(
            side_effect=lambda path, body=None: self.bootstrap if path == "bootstrap" else self.ready_status
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
                    output=b"fixture-secret installer started",
                    stderr=b"fixture-secret install service busy",
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
        failure = next(record for record in records
            if record.get("status") == "failed"
            and record.get("command", [])[:3] == ["xcrun", "simctl", "install"])
        self.assertEqual(failure["status"], "failed")
        self.assertEqual(failure["error_type"], "TimeoutExpired")
        self.assertIn("installer started", failure["stdout"])
        self.assertIn("install service busy", failure["stderr"])
        self.assertNotIn("account-secret", json.dumps(records))
        self.assertNotIn("fixture-secret", json.dumps(records))
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

    def configure_android_capture(self):
        self.runner.args.platform = "android"
        self.runner.device = "emulator-5554"
        self.runner.validated_device = self.runner.device

    def test_android_failure_captures_screen_and_redacted_hierarchy_before_logs(self):
        self.configure_android_capture()
        failure = RuntimeError("original controller startup failure")
        self.runner.install = Mock(side_effect=failure)
        order, commands = [], []
        self.runner.collect_logs.side_effect = lambda: order.append("logs")
        raw = b'<hierarchy><node text="Controller: fixture-secret Bearer private-token" /></hierarchy>'

        def run(command, **kwargs):
            commands.append((list(command), kwargs))
            self.assertEqual(list(command)[:3], ["adb", "-s", "emulator-5554"])
            self.assertLessEqual(kwargs["timeout"], 30)
            if command[3:5] == ["exec-out", "screencap"]:
                order.append("screenshot")
                kwargs["stdout"].write(b"isolated-screenshot-fixture")
            elif list(command)[3:6] == ["shell", "uiautomator", "dump"]:
                order.append("dump")
            elif command[3:5] == ["exec-out", "head"]:
                order.append("read")
                return subprocess.CompletedProcess(command, 0, raw, b"")
            elif list(command)[3:6] == ["shell", "rm", "-f"]:
                order.append("cleanup")
            else:
                self.fail(f"unexpected native diagnostic command: {command}")
            return subprocess.CompletedProcess(command, 0, "completed", "")

        with patch.object(module.subprocess, "run", side_effect=run):
            with self.assertRaises(RuntimeError) as error:
                self.runner.execute()
        self.assertIs(error.exception, failure)
        self.assertEqual(order, ["screenshot", "dump", "read", "cleanup", "logs"])
        self.assertTrue((self.runner.args.output / "runner-failure.png").is_file())
        xml = (self.runner.args.output / "runner-failure-ui.xml").read_text()
        self.assertIn("Controller:", xml)
        self.assertNotIn("fixture-secret", xml)
        self.assertNotIn("private-token", xml)
        remote = commands[1][0][-1]
        self.assertRegex(remote, r"^/data/local/tmp/spawnd-acceptance-[0-9a-f]{32}\.xml$")
        self.assertEqual(commands[2][0][-1], remote)
        self.assertEqual(commands[3][0][-1], remote)
        self.assertEqual(commands[2][0][-2], str(module.ACCESSIBILITY_DUMP_LIMIT + 1))
        trace = (self.runner.args.output / "native-runner.jsonl").read_text()
        self.assertNotIn("fixture-secret", trace)
        self.assertNotIn("private-token", trace)

    def test_capture_errors_and_full_output_disk_preserve_original_exception(self):
        self.configure_android_capture()
        failure = TimeoutError("original native deadline")
        self.runner.install = Mock(side_effect=failure)
        self.runner.screenshot = Mock(side_effect=OSError("screenshot fixture-secret"))
        self.runner.accessibility_dump = Mock(side_effect=OSError("dump fixture-secret"))
        self.runner.diagnostic = Mock(side_effect=OSError("disk full"))
        self.runner.event.side_effect = ConnectionError("fixture offline")
        self.runner.collect_logs.side_effect = OSError("logs disk full")
        with self.assertRaises(TimeoutError) as error:
            self.runner.execute()
        self.assertIs(error.exception, failure)
        self.runner.screenshot.assert_called_once_with("runner-failure", timeout=30)
        self.runner.accessibility_dump.assert_called_once()
        self.runner.collect_logs.assert_called_once()

    def test_passed_finish_with_log_collection_failure_fails_the_job(self):
        self.configure_android_capture()
        failure = OSError("required log output could not be written")
        self.runner.install = Mock()
        self.runner.control = Mock(return_value={"id": "fixture-command", "action": "finish"})
        self.runner.perform = Mock(return_value={"status": "passed"})
        self.runner.collect_logs.side_effect = failure
        with self.assertRaises(OSError) as error:
            self.runner.execute()
        self.assertIs(error.exception, failure)

    def test_failed_finish_captures_best_effort_and_preserves_failure_exit(self):
        self.configure_android_capture()
        self.runner.install = Mock()
        self.runner.control = Mock(return_value={"id": "fixture-command", "action": "finish"})
        self.runner.perform = Mock(return_value={"status": "failed"})
        order = []

        def screenshot(*args, **kwargs):
            order.append("screenshot")
            raise OSError("screenshot failed")

        def dump():
            order.append("accessibility")
            raise OSError("accessibility failed")

        self.runner.screenshot = Mock(side_effect=screenshot)
        self.runner.accessibility_dump = Mock(side_effect=dump)
        self.runner.collect_logs.side_effect = lambda: order.append("logs")
        self.assertEqual(self.runner.execute(), 1)
        self.assertEqual(order, ["screenshot", "accessibility", "logs"])
        self.runner.screenshot.assert_called_once_with("runner-failure", timeout=30)
        self.runner.accessibility_dump.assert_called_once()
        self.runner.event.assert_called_once_with("finish", {"status": "failed"}, "fixture-command")

    def test_failed_action_reporting_cannot_replace_original_runtime_error(self):
        self.configure_android_capture()
        failure = RuntimeError("original native action failed")
        self.runner.install = Mock()
        self.runner.control = Mock(return_value={"id": "fixture-command", "action": "background"})
        self.runner.perform = Mock(side_effect=failure)
        self.runner.event.side_effect = ConnectionError("fixture offline")
        self.runner.capture_failure = Mock()
        with self.assertRaises(RuntimeError) as error:
            self.runner.execute()
        self.assertIs(error.exception, failure)
        self.runner.capture_failure.assert_called_once()
        self.runner.collect_logs.assert_called_once()

    def test_failed_android_dump_still_removes_only_its_own_remote_file(self):
        self.configure_android_capture()
        failure = subprocess.TimeoutExpired("uiautomator", 10)
        calls = []

        def command(*args, **kwargs):
            calls.append((args, kwargs))
            if args[3:6] == ("shell", "uiautomator", "dump"):
                raise failure
            return "removed"

        self.runner.command = Mock(side_effect=command)
        with self.assertRaises(subprocess.TimeoutExpired) as error:
            self.runner.accessibility_dump()
        self.assertIs(error.exception, failure)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][0][:6], ("adb", "-s", "emulator-5554", "shell", "rm", "-f"))
        self.assertEqual(calls[0][0][-1], calls[1][0][-1])
        self.assertEqual(calls[1][1]["timeout"], 10)

    def test_oversized_hierarchy_is_not_written_or_logged_raw(self):
        self.configure_android_capture()
        self.runner.command = Mock(return_value="completed")
        raw = b"fixture-secret" + b"x" * module.ACCESSIBILITY_DUMP_LIMIT
        with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, raw, b"")):
            with self.assertRaisesRegex(ValueError, "diagnostic limit"):
                self.runner.accessibility_dump()
        self.assertFalse((self.runner.args.output / "runner-failure-ui.xml").exists())
        self.assertEqual(self.runner.command.call_args.args[3:6], ("shell", "rm", "-f"))

    def test_rejected_physical_device_receives_no_failure_captures_or_logs(self):
        self.runner.args.platform = "android"
        self.runner.device = "physical-device-serial"
        self.runner.command = Mock(return_value="0")
        self.runner.screenshot = Mock()
        self.runner.accessibility_dump = Mock()
        with self.assertRaisesRegex(RuntimeError, "refuses physical Android"):
            self.runner.execute()
        self.assertEqual(self.runner.command.call_args_list, [unittest.mock.call(
            "adb", "-s", "physical-device-serial", "shell", "getprop", "ro.kernel.qemu")])
        self.runner.screenshot.assert_not_called()
        self.runner.accessibility_dump.assert_not_called()
        self.runner.collect_logs.assert_not_called()

    def test_device_changed_after_validation_is_not_captured(self):
        self.configure_android_capture()
        self.runner.device = "emulator-5556"
        self.runner.screenshot = Mock()
        self.runner.accessibility_dump = Mock()
        self.runner.capture_failure()
        self.runner.screenshot.assert_not_called()
        self.runner.accessibility_dump.assert_not_called()

    def test_live_fixture_starts_only_after_native_install_and_health_precedes_launch(self):
        order = []
        original_control = self.runner.control.side_effect

        def control(path, body=None):
            order.append(path)
            return original_control(path, body)

        def native(command, **kwargs):
            if command[:3] == ("xcrun", "simctl", "install"):
                order.append("installed")
            return self.completed(command, **kwargs)

        self.runner.control.side_effect = control
        self.runner.launch.side_effect = lambda: order.append("launched")
        with patch.object(module.subprocess, "run", side_effect=native):
            self.runner.install()
        self.assertEqual(order, ["installed", "start", "status", "health", "bootstrap", "launched"])

    def test_fixture_failure_prevents_native_launch_and_is_never_restarted(self):
        self.runner.control.side_effect = lambda path, body=None: {
            **self.bootstrap, "phase": "failed", "ready": False,
            "failure_reason": "owned daemon exited with status 1",
        }
        with patch.object(module.subprocess, "run", side_effect=self.completed):
            with self.assertRaisesRegex(RuntimeError, "owned daemon exited with status 1"):
                self.runner.install()
        self.runner.launch.assert_not_called()
        self.assertEqual(sum(call.args[0] == "start" for call in self.runner.control.call_args_list), 1)

    def test_dead_daemon_after_ready_prevents_launch(self):
        def control(path, body=None):
            if path == "health":
                raise RuntimeError("owned daemon exited before launch")
            return self.bootstrap

        self.runner.control.side_effect = control
        with patch.object(module.subprocess, "run", side_effect=self.completed):
            with self.assertRaisesRegex(RuntimeError, "exited before launch"):
                self.runner.install()
        self.runner.launch.assert_not_called()

    def test_ready_status_from_replacement_fixture_is_rejected(self):
        self.runner.control.side_effect = lambda path, body=None: {**self.bootstrap, "runId": "other-run"}
        with patch.object(module.subprocess, "run", side_effect=self.completed):
            with self.assertRaisesRegex(ValueError, "fixture run"):
                self.runner.install()
        self.runner.launch.assert_not_called()

    def test_provisioning_has_one_bounded_attempt(self):
        self.runner.control.side_effect = lambda path, body=None: {
            **self.ready_status, "phase": "starting", "ready": False,
        }
        with patch.object(module.time, "monotonic", side_effect=[0, 0, 90]), patch.object(module.time, "sleep"):
            with self.assertRaisesRegex(TimeoutError, "startup budget"):
                self.runner.start_fixture()
        self.assertEqual([call.args[0] for call in self.runner.control.call_args_list], ["start", "status"])
        self.runner.launch.assert_not_called()

    def test_bootstrap_from_replacement_fixture_is_rejected(self):
        self.runner.control.side_effect = lambda path, body=None: (
            {**self.bootstrap, "runId": "other-run"} if path == "bootstrap" else self.ready_status
        )
        with self.assertRaisesRegex(ValueError, "fixture run"):
            self.runner.start_fixture()
        self.assertNotIn("first-account-secret", self.runner.secrets)


if __name__ == "__main__":
    unittest.main()
