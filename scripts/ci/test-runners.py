#!/usr/bin/env python3
"""Regress runner isolation, cleanup ownership and hosted-fallback refusals."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


pool = module("runner_pool", "runner-pool.py")
guard = module("runner_guard", "check-self-hosted.py")
keychain = module("runner_keychain", "macos-keychain.py")


class RunnerIsolation(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(Path(__file__).with_name("pools.json").read_text())
        self.android = next(p for p in self.config["pools"] if p.get("kvm"))
        self.name = "spawnd-ci-" + "a" * 24

    def test_checked_in_configuration_is_bounded(self):
        pool.validate_config(self.config)
        for field, bad in [("host", "minivac; touch /tmp/unwanted"), ("count", 0),
                           ("memory_gib", 256), ("home_gib", 56), ("tmp_gib", 9)]:
            changed = copy.deepcopy(self.config)
            changed["pools"][1][field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                pool.validate_config(changed)

    def test_job_has_no_host_credentials_or_docker_socket(self):
        command = pool.container_command(self.config, self.android, self.name, 108)
        self.assertIn("--tmpfs", command)
        self.assertIn("/dev/kvm", command)
        for forbidden in ("--privileged", "--volume", "--mount", "/var/run/docker.sock", "--network=host"):
            self.assertNotIn(forbidden, command)
        self.assertEqual(command[-1], self.config["image"])

    def test_android_without_verified_kvm_gid_is_refused(self):
        with self.assertRaises(ValueError):
            pool.container_command(self.config, self.android, self.name)

    def test_cleanup_rejects_unowned_names_without_contacting_host(self):
        with patch.object(pool, "remote") as remote:
            with self.assertRaises(ValueError):
                pool.cleanup_container("multivac", "users-running-database", Path("/tmp"))
            remote.assert_not_called()

    def test_cleanup_checks_the_container_label_before_stopping_anything(self):
        with patch.object(pool, "remote", return_value=subprocess.CompletedProcess([], 0, "false\n")) as remote:
            with self.assertRaisesRegex(RuntimeError, "ownership label"):
                pool.cleanup_container("multivac", self.name, Path("/tmp"))
            self.assertEqual(remote.call_count, 1)

    def test_missing_container_requires_a_healthy_docker_daemon(self):
        failure = subprocess.CalledProcessError(1, "docker info")
        with patch.object(pool, "remote", side_effect=[subprocess.CompletedProcess([], 1, ""), failure]):
            with self.assertRaises(subprocess.CalledProcessError):
                pool.cleanup_container("multivac", self.name, Path("/tmp"))

    def test_registration_cleanup_cannot_delete_an_unrelated_runner(self):
        with patch.object(pool, "gh", return_value={"runners": [{"id": 12, "name": "other-runner"}]}) as gh:
            with self.assertRaisesRegex(RuntimeError, "unrelated"):
                pool.remove_registration("levy-street/spawn", 12, self.name)
            self.assertEqual(gh.call_count, 1)

    def test_self_deregistered_runner_does_not_need_a_delete(self):
        with patch.object(pool, "gh", return_value={"runners": []}) as gh:
            pool.remove_registration("levy-street/spawn", 12, self.name)
            self.assertEqual(gh.call_count, 1)

    def test_recovery_refuses_state_for_a_different_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "active-test.json").write_text(json.dumps({"repository": "other/repo"}))
            with patch.object(pool, "cleanup_container") as cleanup:
                with self.assertRaises(RuntimeError):
                    pool.recover(self.config, state)
                cleanup.assert_not_called()


class WorkflowRouting(unittest.TestCase):
    def test_hosted_literal_and_expression_are_refused(self):
        for value in ("ubuntu-latest", "windows-latest", "macos-15", "${{ vars.RUNNER }}"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                guard.validate_workflow("    runs-on: " + value)

    def test_hosted_matrix_fallback_is_refused(self):
        with self.assertRaises(ValueError):
            guard.validate_workflow("    runs-on: ${{ fromJSON(matrix.runner) }}\n            runner: '\"ubuntu-latest\"'")

    def test_missing_self_hosted_label_and_wrong_architecture_are_refused(self):
        for labels in (["Linux", "X64", "spawn-linux-build"],
                       ["self-hosted", "Windows", "ARM64", "spawn-windows-build"]):
            with self.assertRaises(ValueError):
                guard.validate_labels(labels)

    def test_all_checked_in_jobs_have_valid_routing(self):
        root = Path(__file__).resolve().parents[2]
        counts = [guard.validate_workflow(path.read_text()) for path in (root / ".github/workflows").glob("*.yml")]
        self.assertEqual(len(counts), 7)
        self.assertEqual(sum(counts), 21)


class SigningCleanup(unittest.TestCase):
    def test_restore_preserves_existing_keychains_and_deletes_only_the_job_keychain(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RUNNER_TEMP": directory}):
            prior = ["/Users/release/Library/Keychains/login.keychain-db", "/Users/release/Library/Keychains/another.keychain-db"]
            with patch.object(keychain.subprocess, "check_output", return_value='\n'.join(json.dumps(p) for p in prior)):
                keychain.save()
            owned = Path(directory) / "spawnd-signing.keychain-db"
            owned.touch()
            with patch.object(keychain.subprocess, "run") as run:
                keychain.restore()
            self.assertEqual(run.call_args_list[0].args[0], ["security", "delete-keychain", str(owned)])
            self.assertEqual(run.call_args_list[1].args[0], ["security", "list-keychains", "-d", "user", "-s", *prior])

    def test_failed_keychain_deletion_still_restores_search_list_and_fails(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RUNNER_TEMP": directory}):
            (Path(directory) / "spawnd-keychain-search-list.json").write_text('["/Users/release/login.keychain-db"]')
            (Path(directory) / "spawnd-signing.keychain-db").touch()
            with patch.object(keychain.subprocess, "run", side_effect=[subprocess.CalledProcessError(1, "security"), None]) as run:
                with self.assertRaises(subprocess.CalledProcessError):
                    keychain.restore()
            self.assertEqual(run.call_count, 2)

    def test_redirected_keychain_is_refused_before_any_security_command(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RUNNER_TEMP": directory}):
            (Path(directory) / "spawnd-signing.keychain-db").symlink_to('/Users/oem/Library/Keychains/login.keychain-db')
            with patch.object(keychain.subprocess, "run") as run:
                with self.assertRaises(ValueError):
                    keychain.restore()
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
