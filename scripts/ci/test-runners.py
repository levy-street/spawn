#!/usr/bin/env python3
"""Regress runner isolation, cleanup ownership and standard hosted workflow routing."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


pool = module("runner_pool", "runner-pool.py")
guard = module("runner_guard", "check-hosted-runners.py")
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
        self.assertNotIn("--tmpfs", command)  # Minivac uses disposable disk storage.
        self.assertIn("/dev/kvm", command)
        for forbidden in ("--privileged", "--volume", "--mount", "/var/run/docker.sock", "--network=host"):
            self.assertNotIn(forbidden, command)
        self.assertEqual(command[-1], self.config["image"])

    def test_android_without_verified_kvm_gid_is_refused(self):
        with self.assertRaises(ValueError):
            pool.container_command(self.config, self.android, self.name)

    def test_minivac_placement_cannot_be_assigned_to_another_host(self):
        changed = copy.deepcopy(self.config)
        changed["pools"][0]["host"] = "multivac"
        with self.assertRaisesRegex(ValueError, "all Linux pools"):
            pool.validate_config(changed)

    def test_minivac_builders_cannot_omit_the_placement_label(self):
        changed = copy.deepcopy(self.config)
        changed["pools"][0].pop("extra_labels")
        with self.assertRaisesRegex(ValueError, "explicitly placed"):
            pool.validate_config(changed)

    def test_coordination_pool_cannot_move_off_minivac(self):
        changed = copy.deepcopy(self.config)
        changed["pools"][2]["host"] = "minimac"
        with self.assertRaisesRegex(ValueError, "all Linux pools"):
            pool.validate_config(changed)

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


class ControllerOperatorBoundary(unittest.TestCase):
    def test_local_mode_refuses_another_machine_or_root(self):
        with patch.object(pool.sys, "platform", "linux"), patch.object(pool.socket, "gethostname", return_value="multivac"):
            with self.assertRaisesRegex(ValueError, "Minivac Linux host"):
                pool.configure_execution("minivac", "git-credential")
        with patch.object(pool.sys, "platform", "linux"), patch.object(pool.socket, "gethostname", return_value="minivac"), patch.object(pool.os, "geteuid", return_value=0):
            with self.assertRaisesRegex(ValueError, "not root"):
                pool.configure_execution("minivac", "git-credential")

    def test_local_mode_pins_docker_to_the_local_socket(self):
        with patch.object(pool, "LOCAL_HOST", None), patch.object(pool, "AUTH_SOURCE", "gh"), patch.dict(os.environ, {"DOCKER_HOST": "ssh://another-host", "DOCKER_CONTEXT": "remote-context"}):
            with patch.object(pool.sys, "platform", "linux"), patch.object(pool.socket, "gethostname", return_value="minivac"), patch.object(pool.os, "geteuid", return_value=1000):
                pool.configure_execution("minivac", "git-credential")
            self.assertEqual(os.environ["DOCKER_HOST"], "unix:///var/run/docker.sock")
            self.assertNotIn("DOCKER_CONTEXT", os.environ)
            self.assertEqual(pool.ssh_command("minivac", ["docker", "info"]), ["docker", "info"])

    def test_credential_and_api_failure_details_cannot_reach_pool_logs(self):
        fake_secret = "fake-private-test-value"
        for code in (0, 1):
            result = subprocess.CompletedProcess([], code, "password=" + fake_secret, fake_secret)
            failure = urllib.error.HTTPError("https://api.github.com", 403, fake_secret, {}, None)
            with patch.object(pool.subprocess, "run", return_value=result) as run, patch.object(pool.urllib.request, "urlopen", side_effect=failure):
                with self.assertRaises(RuntimeError) as raised:
                    pool.git_credential_api("levy-street/spawn", "/generate-jitconfig", method="POST", body={})
                self.assertNotIn(fake_secret, str(raised.exception))
                self.assertNotIn(fake_secret, repr(run.call_args.args))
                self.assertNotIn(fake_secret, run.call_args.kwargs["input"])
                self.assertTrue(all(value != fake_secret for value in run.call_args.kwargs["env"].values()))
                self.assertEqual(run.call_args.kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")


class WorkflowRouting(unittest.TestCase):
    def workflow(self, job):
        return "jobs:\n  check:\n" + job

    def test_standard_hosted_runners_are_accepted(self):
        for value in guard.STANDARD_RUNNERS:
            self.assertEqual(guard.validate_workflow(self.workflow("    runs-on: " + value)), 1)

    def test_paid_self_hosted_and_dynamic_runners_are_refused(self):
        for value in ("macos-15-large", "macos-15-xlarge", "ubuntu-latest-8-cores",
                      "self-hosted", "[self-hosted, Linux, X64, spawn-linux-build]",
                      "${{ vars.RUNNER }}", "${{ inputs.runner }}", "{group: paid}"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                guard.validate_workflow(self.workflow("    runs-on: " + value))

    def test_matrix_rejects_any_unapproved_runner(self):
        source = self.workflow("    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - runner: macos-15\n          - runner: ")
        self.assertEqual(guard.validate_workflow(source + "ubuntu-24.04"), 2)
        for value in ("macos-15-large", "self-hosted", "${{ vars.RUNNER }}"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                guard.validate_workflow(source + value)
        with self.assertRaises(ValueError):
            guard.validate_workflow(self.workflow("    runs-on: ${{ matrix.runner }}"))

    def test_quoted_keys_aliases_and_duplicate_keys_cannot_hide_paid_runners(self):
        self.assertEqual(guard.validate_workflow(self.workflow("    'runs-on': 'ubuntu-22.04' # floor")), 1)
        for source in (
            self.workflow('    "runs-on": "macos-15-large"'),
            "runner: &paid macos-15-large\n" + self.workflow("    runs-on: *paid"),
            self.workflow("    runs-on: ubuntu-latest\n    runs-on: macos-15-large"),
            self.workflow("    uses: external/workflows/.github/workflows/paid.yml@main"),
        ):
            with self.subTest(source=source), self.assertRaises(ValueError):
                guard.validate_workflow(source)

    def test_all_checked_in_jobs_have_valid_routing(self):
        root = Path(__file__).resolve().parents[2]
        counts = [guard.validate_workflow(path.read_text()) for path in (root / ".github/workflows").glob("*.yml")]
        self.assertEqual(len(counts), 7)
        self.assertEqual(sum(counts), 22)


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
