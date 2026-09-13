#!/usr/bin/env python3
"""Exercise the password handoff without creating accounts or reading a Keychain."""

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("mac_accounts", Path(__file__).with_name("prepare-macos-accounts.py"))
accounts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounts)
policy_spec = importlib.util.spec_from_file_location("mac_policy", Path(__file__).with_name("check-macos-runner.py"))
policy = importlib.util.module_from_spec(policy_spec)
policy_spec.loader.exec_module(policy)


@unittest.skipUnless(os.name == "posix", "PTY checks require a Unix host")
class PasswordPrompt(unittest.TestCase):
    def test_password_uses_private_prompt_and_echo_is_disabled(self):
        script = (
            "import sys,termios; "
            "assert not termios.tcgetattr(0)[3] & termios.ECHO; "
            "print('Enter password for new user: ',end='',flush=True); "
            "value=sys.stdin.readline().strip(); "
            "assert len(value)==48; "
            "assert value not in '\\0'.join(sys.argv)"
        )
        self.assertEqual(accounts.password_prompt([sys.executable, "-c", script], "x" * 48, 5), (0, True))

    def test_failed_command_does_not_claim_a_password_handoff(self):
        self.assertEqual(accounts.password_prompt([sys.executable, "-c", "raise SystemExit(7)"], "x" * 48, 5), (7, False))

    def test_a_missing_prompt_is_bounded(self):
        with self.assertRaisesRegex(RuntimeError, "inspect its state"):
            accounts.password_prompt([sys.executable, "-c", "import time; time.sleep(10)"], "x" * 48, 0.3)

    def test_timeout_also_stops_a_child_ignoring_termination(self):
        with self.assertRaisesRegex(RuntimeError, "inspect its state"):
            accounts.password_prompt([sys.executable, "-c",
                                      "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(10)"],
                                     "x" * 48, 0.3)

    def test_writable_hook_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            hook = Path(directory) / "hook.sh"
            marker = Path(directory) / "ran"
            hook.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
            with self.assertRaisesRegex(RuntimeError, "not protected"):
                policy.check_hook(hook)
            self.assertFalse(marker.exists())

    def test_symlink_hook_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target.sh"
            target.write_text("#!/bin/sh\nexit 0\n")
            hook = Path(directory) / "hook.sh"
            hook.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "regular protected"):
                policy.check_hook(hook)


if __name__ == "__main__":
    unittest.main()
