#!/usr/bin/env python3
"""Execute release hooks against allowed jobs and branch/PR counterexamples."""

import os
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parent


class ReleaseHooks(unittest.TestCase):
    def check_hook(self, command):
        valid = {
            "GITHUB_REPOSITORY": "levy-street/spawn",
            "GITHUB_REF": "refs/heads/master",
            "GITHUB_EVENT_NAME": "push",
            "GITHUB_WORKFLOW_REF": "levy-street/spawn/.github/workflows/prebuilt.yml@refs/heads/master",
        }
        cases = [({}, True), ({"GITHUB_EVENT_NAME": "workflow_dispatch"}, True),
                 ({"GITHUB_WORKFLOW_REF": "levy-street/spawn/.github/workflows/desktop.yml@refs/heads/master"}, True),
                 ({"GITHUB_REPOSITORY": "attacker/spawn"}, False),
                 ({"GITHUB_REF": "refs/heads/feature"}, False),
                 ({"GITHUB_EVENT_NAME": "pull_request_target"}, False),
                 ({"GITHUB_EVENT_NAME": "pull_request"}, False),
                 ({"GITHUB_WORKFLOW_REF": "levy-street/spawn/.github/workflows/prebuilt.yml@refs/heads/feature"}, False),
                 ({"GITHUB_WORKFLOW_REF": "levy-street/spawn/.github/workflows/arbitrary.yml@refs/heads/master"}, False),
                 ({"GITHUB_WORKFLOW_REF": ""}, False)]
        for changes, allowed in cases:
            with self.subTest(changes=changes):
                result = subprocess.run(command, env={**os.environ, **valid, **changes},
                                        text=True, capture_output=True, timeout=15)
                self.assertEqual(result.returncode == 0, allowed, result.stderr)

    @unittest.skipUnless(shutil.which("bash"), "bash is unavailable on this platform")
    def test_macos_hook(self):
        self.check_hook(["bash", str(ROOT / "release-job-hook.sh")])

    @unittest.skipUnless(os.environ.get("SPAWN_TEST_PWSH") or shutil.which("pwsh"), "PowerShell is unavailable on this platform")
    def test_windows_hook(self):
        self.check_hook([os.environ.get("SPAWN_TEST_PWSH") or shutil.which("pwsh"),
                         "-NoProfile", "-File", str(ROOT / "release-job-hook.ps1")])


if __name__ == "__main__":
    unittest.main()
