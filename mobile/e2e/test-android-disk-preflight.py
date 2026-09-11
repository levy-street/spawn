#!/usr/bin/env python3
"""Check hosted disk guards using temporary dummy tools, never local tooling."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "disk_preflight", Path(__file__).with_name("android-disk-preflight.py")
)
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)


class HostedDiskPreflight(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hosted-disk-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tools = tuple(self.root / name for name in ("dotnet", "haskell", "codeql", "swift"))
        for tool in self.tools:
            tool.mkdir()
            (tool / "dummy-tool").write_text("discard")
        self.sdk = self.root / "sdk"
        self.sdk.mkdir()
        (self.sdk / "required-tool").write_text("preserve")
        self.env = {
            "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
            "RUNNER_OS": "Linux", "ImageOS": "ubuntu24", "NATIVE_PLATFORM": "android",
            "RUNNER_TEMP": str(self.root), "GITHUB_WORKSPACE": str(self.root),
            "ANDROID_HOME": str(self.sdk),
        }
        self.enterContext(patch.dict(os.environ, self.env, clear=True))
        self.enterContext(patch.object(disk.platform, "system", return_value="Linux"))
        self.release = self.enterContext(patch.object(
            disk.platform, "freedesktop_os_release", return_value={"ID": "ubuntu", "VERSION_ID": "24.04"}
        ))
        # All destructive calls are intercepted; only dummy tool directories
        # can be removed by the test callback below.
        self.run = self.enterContext(patch.object(disk.subprocess, "run"))
        self.du = self.enterContext(patch.object(disk.subprocess, "check_output", return_value="4096 dummy\n"))
        self.enterContext(patch.object(disk, "UNUSED_TOOLS", self.tools))
        self.usage = self.enterContext(patch.object(disk.shutil, "disk_usage", return_value=SimpleNamespace(free=32 * disk.GIB)))
        self.output = self.enterContext(patch("builtins.print"))

    def test_refuses_local_self_hosted_and_other_platforms_before_mutation(self):
        for name, value in (
            ("GITHUB_ACTIONS", "false"), ("RUNNER_ENVIRONMENT", "self-hosted"),
            ("RUNNER_OS", "macOS"), ("ImageOS", "ubuntu22"), ("NATIVE_PLATFORM", "ios"),
        ):
            with self.subTest(name=name), patch.dict(os.environ, {name: value}):
                with self.assertRaisesRegex(RuntimeError, name):
                    disk.preflight("prepare")
        self.run.assert_not_called()
        self.du.assert_not_called()
        self.usage.assert_not_called()

    def test_refuses_wrong_actual_os_even_with_hosted_environment(self):
        self.release.return_value = {"ID": "ubuntu", "VERSION_ID": "22.04"}
        with self.assertRaisesRegex(RuntimeError, "Ubuntu 24.04"):
            disk.preflight("prepare")
        self.run.assert_not_called()

    def test_all_roots_are_checked_before_deleting_any(self):
        shutil.rmtree(self.tools[-1])
        self.tools[-1].symlink_to(self.sdk, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "redirected"):
            disk.preflight("prepare")
        self.run.assert_not_called()
        self.assertTrue((self.tools[0] / "dummy-tool").exists())
        self.assertEqual((self.sdk / "required-tool").read_text(), "preserve")

    def test_refuses_redirected_parent_directory(self):
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with patch.object(disk, "UNUSED_TOOLS", (alias / "dotnet",)):
            with self.assertRaisesRegex(RuntimeError, "redirected"):
                disk.preflight("prepare")
        self.run.assert_not_called()

    def test_refuses_mounted_tool_root(self):
        with patch.object(Path, "is_mount", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "mounted"):
                disk.preflight("prepare")
        self.run.assert_not_called()

    def test_reclaims_only_allowlisted_tools_and_logs_measured_headroom(self):
        def remove_dummy(command, **options):
            self.assertEqual(command[:3], ["sudo", "-n", "rm"])
            self.assertIn("--one-file-system", command)
            self.assertIn("--preserve-root=all", command)
            self.assertEqual(command[-2], "--")
            self.assertTrue(options["check"])
            self.assertLessEqual(options["timeout"], 90)
            target = Path(command[-1])
            self.assertIn(target, self.tools)
            shutil.rmtree(target)

        self.run.side_effect = remove_dummy
        disk.preflight("prepare")
        self.assertTrue(all(not tool.exists() for tool in self.tools))
        self.assertTrue((self.sdk / "required-tool").exists())
        reports = [json.loads(call.args[0]) for call in self.output.call_args_list]
        self.assertEqual([r["event"] for r in reports if "free_bytes" in r], ["before", "after"])
        self.assertEqual(reports[-1]["event"], "headroom_passed")

    def test_absent_allowlisted_tool_does_not_expand_cleanup_scope(self):
        for tool in self.tools:
            shutil.rmtree(tool)
        disk.preflight("prepare")
        self.run.assert_not_called()

    def test_build_and_emulator_checks_do_not_delete(self):
        for stage in ("build", "emulator"):
            with self.subTest(stage=stage):
                disk.preflight(stage)
        self.run.assert_not_called()
        self.du.assert_not_called()

    def test_headroom_failure_cannot_pass_even_after_cleanup(self):
        self.usage.return_value = SimpleNamespace(free=14 * disk.GIB)
        with self.assertRaisesRegex(RuntimeError, "at least 15 GiB"):
            disk.preflight("prepare")
        reports = [json.loads(call.args[0]) for call in self.output.call_args_list]
        self.assertNotIn("headroom_passed", [r["event"] for r in reports])

    def test_checks_sdk_filesystem_independently(self):
        self.usage.side_effect = lambda path: SimpleNamespace(free=(8 if path == self.sdk else 32) * disk.GIB)
        with self.assertRaisesRegex(RuntimeError, "at least 16 GiB"):
            disk.preflight("emulator")
        self.run.assert_not_called()

    def test_cleanup_failure_stops_before_other_roots(self):
        self.run.side_effect = subprocess.CalledProcessError(1, "mocked rm")
        with self.assertRaises(subprocess.CalledProcessError):
            disk.preflight("prepare")
        self.assertEqual(self.run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
