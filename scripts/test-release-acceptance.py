#!/usr/bin/env python3
"""Release evidence rejection tests with no production, GitHub, or native calls."""

from __future__ import annotations

import copy
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("check-release-acceptance.py")
SPEC = importlib.util.spec_from_file_location("release_acceptance", SCRIPT)
gate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gate
SPEC.loader.exec_module(gate)
CANDIDATE, BASELINE = "a" * 40, "b" * 40
REPOSITORY = "levy-street/spawn"


def report(name):
    kind = {
        "ios": "native_simulator",
        "android": "native_emulator",
        "canary": "isolated_canary",
    }[name]
    return {
        "schema_version": 1,
        "candidate_commit": CANDIDATE,
        "baseline_commit": BASELINE,
        "status": "passed",
        "evidence_kind": kind,
        "platform": name,
        "physical_device": False,
        "source_clean": True,
        "cleanup_passed": True,
        "cleanup_complete": True,
        "started_at": "2026-01-01T00:00:00+00:00",
        "completed_at": "2026-01-01T00:10:00+00:00",
        "cases": [
            {
                "id": case,
                "status": "passed",
                "metrics": {"soak_seconds": 120, "samples": 5},
            }
            for case in sorted(
                gate.CANARY_CASES if name == "canary" else gate.NATIVE_CASES
            )
        ],
    }


def run_record(**changes):
    return {
        "head_sha": CANDIDATE,
        "head_branch": "master",
        "event": "push",
        "head_repository": {"full_name": REPOSITORY},
        "run_number": 8,
        "run_attempt": 1,
        "status": "completed",
        "conclusion": "success",
        "html_url": "https://github.com/levy-street/spawn/actions/runs/1",
        **changes,
    }


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.directory = Path(self.scratch.name)
        for name in ("ios", "android", "canary"):
            self.write(name, report(name))

    def write(self, name, value):
        directory = self.directory / name
        directory.mkdir(exist_ok=True)
        (directory / "evidence.json").write_text(json.dumps(value))

    def verify(self):
        return gate.verify(self.directory, CANDIDATE, BASELINE)

    def test_complete_evidence_roundtrips_without_fixture_secrets_or_extras(self):
        value = report("ios")
        value["bootstrap"] = {"token": "DO-NOT-PROMOTE"}
        value["cases"][0]["metrics"]["credentials"] = "DO-NOT-PROMOTE"
        self.write("ios", value)
        result = self.verify()
        self.assertNotIn("DO-NOT-PROMOTE", json.dumps(result))
        self.assertEqual(set(result["reports"]), {"ios", "android", "canary"})
        self.assertEqual(gate.validate_aggregate(result, CANDIDATE, BASELINE), result)
        self.assertRegex(
            result["reports"]["ios"]["source_report_sha256"], r"^[a-f0-9]{64}$"
        )

    def test_missing_platform_and_duplicate_platform_refuse(self):
        (self.directory / "android" / "evidence.json").unlink()
        with self.assertRaisesRegex(ValueError, "absent"):
            self.verify()
        self.write("android", report("android"))
        self.write("extra", report("ios"))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.verify()

    def test_stale_candidates_and_baselines_refuse_for_every_runtime(self):
        for name in ("ios", "android", "canary"):
            for field in ("candidate_commit", "baseline_commit"):
                with self.subTest(name=name, field=field):
                    value = report(name)
                    value[field] = "c" * 40
                    with self.assertRaises(ValueError):
                        gate.validate_report(value, CANDIDATE, BASELINE)
        with self.assertRaises(ValueError):
            gate.verify(self.directory, CANDIDATE[:12], BASELINE)
        with self.assertRaises(ValueError):
            gate.verify(self.directory, CANDIDATE, CANDIDATE)

    def test_skipped_failed_incomplete_or_non_native_reports_refuse(self):
        changes = (
            {"status": "skipped"},
            {"status": "failed"},
            {"status": "running"},
            {"evidence_kind": "unit_tests"},
            {"evidence_kind": "web_chromium"},
            {"platform": "android"},
            {"physical_device": True},
            {"physical_device": None},
            {"schema_version": True},
            {"schema_version": 2},
            {"source_clean": False},
            {"source_clean": None},
            {"cleanup_passed": False},
            {"cleanup_passed": None},
        )
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                gate.validate_report(report("ios") | change, CANDIDATE, BASELINE)

    def test_missing_duplicate_unknown_malformed_or_failed_cases_refuse(self):
        value = report("ios")
        cases = value["cases"]
        invalid = [
            None,
            [],
            cases[:-1],
            cases + [cases[0]],
            cases + [{"id": "unknown", "status": "passed"}],
            [None] + cases[1:],
            [{"id": [], "status": "passed"}] + cases[1:],
            [cases[0] | {"status": "skipped"}] + cases[1:],
        ]
        for case_set in invalid:
            with self.subTest(cases=case_set), self.assertRaises(ValueError):
                gate.validate_report(value | {"cases": case_set}, CANDIDATE, BASELINE)

    def test_all_four_canary_cases_need_real_duration_and_repeated_samples(self):
        with self.assertRaises(ValueError):
            gate.validate_report(
                report("canary") | {"cleanup_complete": False}, CANDIDATE, BASELINE
            )
        for index in range(4):
            for duration, samples in (
                (59.999, 2),
                (True, 2),
                (float("nan"), 2),
                (float("inf"), 2),
                ("120", 2),
                (120, 1),
                (120, True),
                (120, 2.0),
                (120, None),
            ):
                value = report("canary")
                value["cases"][index]["metrics"] = {
                    "soak_seconds": duration,
                    "samples": samples,
                }
                with (
                    self.subTest(index=index, duration=duration, samples=samples),
                    self.assertRaises(ValueError),
                ):
                    gate.validate_report(value, CANDIDATE, BASELINE)

    def test_observation_window_must_be_completed_ordered_and_zoned(self):
        for change in (
            {"completed_at": None},
            {"completed_at": "not a timestamp"},
            {"completed_at": "2025-01-01T00:00:00+00:00"},
            {"completed_at": "2099-01-01T00:00:00+00:00"},
            {"started_at": "2026-01-01T00:00:00"},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                gate.validate_report(report("ios") | change, CANDIDATE, BASELINE)

    def test_aggregate_top_level_pass_cannot_hide_a_failed_nested_report(self):
        original = self.verify()
        for mutation in ("status", "candidate", "baseline", "missing", "label"):
            value = copy.deepcopy(original)
            if mutation == "status":
                value["reports"]["ios"]["cases"][0]["status"] = "failed"
            elif mutation == "candidate":
                value["reports"]["android"]["candidate_commit"] = BASELINE
            elif mutation == "baseline":
                value["reports"]["canary"]["baseline_commit"] = CANDIDATE
            elif mutation == "missing":
                del value["reports"]["canary"]
            else:
                value["reports"]["ios"], value["reports"]["android"] = (
                    value["reports"]["android"],
                    value["reports"]["ios"],
                )
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                gate.validate_aggregate(value, CANDIDATE, BASELINE)

    def test_json_duplicate_keys_and_non_object_reports_refuse(self):
        path = self.directory / "ios" / "evidence.json"
        path.write_text('{"status":"failed","status":"passed"}')
        with self.assertRaisesRegex(ValueError, "duplicate JSON"):
            self.verify()
        path.write_text("[]")
        with self.assertRaises(ValueError):
            self.verify()

    def test_cli_refuses_stale_aggregate_without_any_network_lookup(self):
        path = self.directory / "acceptance.json"
        path.write_text(json.dumps(self.verify()))
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--evidence",
                str(path),
                "--candidate",
                "c" * 40,
                "--baseline",
                BASELINE,
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("REFUSED", result.stderr)


class BaselineTests(unittest.TestCase):
    def test_missing_baseline_fetches_only_the_exact_commit_without_tags(self):
        missing = subprocess.CalledProcessError(1, ["git", "cat-file"])
        with patch.object(gate, "git", side_effect=[missing, "", ""]) as git:
            gate.ensure_baseline_commit(BASELINE)
        self.assertEqual(
            [call.args for call in git.call_args_list],
            [
                ("cat-file", "-e", f"{BASELINE}^{{commit}}"),
                ("fetch", "--no-tags", "origin", BASELINE),
                ("cat-file", "-e", f"{BASELINE}^{{commit}}"),
            ],
        )

    def test_present_baseline_does_not_fetch_and_unavailable_baseline_fails(self):
        with patch.object(gate, "git", return_value="") as git:
            gate.ensure_baseline_commit(BASELINE)
            git.assert_called_once_with("cat-file", "-e", f"{BASELINE}^{{commit}}")
        missing = subprocess.CalledProcessError(1, ["git", "cat-file"])
        with (
            patch.object(gate, "git", side_effect=missing),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            gate.ensure_baseline_commit(BASELINE)
        with patch.object(gate, "git") as git, self.assertRaises(ValueError):
            gate.ensure_baseline_commit("--all")
        git.assert_not_called()

    def test_public_identity_requires_full_clean_server_and_matching_daemon_tree(self):
        good = {
            "server": {"commit": BASELINE, "dirty": False},
            "daemon": {"tree": "d" * 40},
        }
        with (
            patch.object(
                gate.urllib.request,
                "urlopen",
                return_value=io.BytesIO(json.dumps(good).encode()),
            ),
            patch.object(gate, "git", return_value="d" * 40),
        ):
            self.assertEqual(gate.deployed_baseline("https://spawnd.dev"), BASELINE)
        for value in (
            [],
            {},
            good | {"server": None},
            good | {"daemon": None},
            good | {"server": {"commit": BASELINE[:12], "dirty": False}},
            good | {"server": {"commit": BASELINE, "dirty": True}},
            good | {"daemon": {"tree": "e" * 40}},
        ):
            with (
                self.subTest(value=value),
                patch.object(
                    gate.urllib.request,
                    "urlopen",
                    return_value=io.BytesIO(json.dumps(value).encode()),
                ),
                patch.object(gate, "git", return_value="d" * 40),
                self.assertRaises(ValueError),
            ):
                gate.deployed_baseline("https://spawnd.dev")

    def test_alternate_origin_is_not_a_release_baseline(self):
        with (
            patch.object(gate.urllib.request, "urlopen") as request,
            self.assertRaises(ValueError),
        ):
            gate.deployed_baseline("http://127.0.0.1:8000")
        request.assert_not_called()


class DeploymentTests(unittest.TestCase):
    baseline_tree = "c" * 40
    candidate_tree = "d" * 40

    def setUp(self):
        self.evidence = {
            "schema_version": 1,
            "candidate_commit": CANDIDATE,
            "baseline_commit": BASELINE,
            "status": "passed",
            "reports": {name: report(name) for name in ("ios", "android", "canary")},
        }
        git = patch.object(
            gate,
            "git",
            side_effect=lambda *args: {
                ("cat-file", "-e", f"{BASELINE}^{{commit}}"): "",
                ("rev-parse", f"{BASELINE}:daemon"): self.baseline_tree,
                ("rev-parse", f"{CANDIDATE}:daemon"): self.candidate_tree,
            }[args],
        )
        git.start()
        self.addCleanup(git.stop)

    def validate(self, commit, tree, *, resume=False, dirty=False):
        release = {
            "server": {"commit": commit, "dirty": dirty},
            "daemon": {"tree": tree},
        }
        with patch.object(
            gate.urllib.request,
            "urlopen",
            return_value=io.BytesIO(json.dumps(release).encode()),
        ):
            return gate.validate_deployment(
                self.evidence, CANDIDATE, "https://spawnd.dev", resume=resume
            )

    def test_initial_deployment_still_requires_original_baseline(self):
        for resume in (False, True):
            with self.subTest(resume=resume):
                self.assertEqual(
                    self.validate(BASELINE, self.baseline_tree, resume=resume),
                    self.evidence,
                )
        for tree in (self.baseline_tree, self.candidate_tree):
            with self.subTest(tree=tree), self.assertRaises(ValueError):
                self.validate(CANDIDATE, tree)

    def test_resume_after_service_or_manifest_publication_preserves_original_baseline(
        self,
    ):
        for tree in (self.baseline_tree, self.candidate_tree):
            with self.subTest(tree=tree):
                accepted = self.validate(CANDIDATE, tree, resume=True)
                self.assertEqual(accepted["baseline_commit"], BASELINE)
                self.assertEqual(accepted, self.evidence)

    def test_resume_rejects_other_releases_unknown_trees_and_dirty_servers(self):
        for commit, tree, dirty in (
            ("e" * 40, self.baseline_tree, False),
            ("e" * 40, self.candidate_tree, False),
            (BASELINE, self.candidate_tree, False),
            (CANDIDATE, "e" * 40, False),
            (CANDIDATE, None, False),
            (CANDIDATE, self.candidate_tree, True),
        ):
            with (
                self.subTest(commit=commit, tree=tree, dirty=dirty),
                self.assertRaises(ValueError),
            ):
                self.validate(commit, tree, resume=True, dirty=dirty)

    def test_resume_does_not_waive_any_platform_evidence(self):
        for kind in ("ios", "android", "canary"):
            with self.subTest(kind=kind):
                self.evidence["reports"][kind]["status"] = "failed"
                with (
                    patch.object(gate.urllib.request, "urlopen") as request,
                    self.assertRaises(ValueError),
                ):
                    gate.validate_deployment(
                        self.evidence, CANDIDATE, "https://spawnd.dev", resume=True
                    )
                request.assert_not_called()
                self.evidence["reports"][kind]["status"] = "passed"

    def test_resume_rechecks_production_and_refuses_if_another_release_advanced(self):
        self.validate(CANDIDATE, self.baseline_tree, resume=True)
        with self.assertRaises(ValueError):
            self.validate("e" * 40, "f" * 40, resume=True)

    def test_resume_cannot_override_public_identity_with_a_baseline_flag(self):
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--resume",
                "--evidence",
                "unused.json",
                "--candidate",
                CANDIDATE,
                "--baseline",
                BASELINE,
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("public production identity", result.stderr)


@unittest.skipIf(os.name == "nt", "deploy orchestration requires POSIX shell semantics")
class DeployScriptTests(unittest.TestCase):
    """Exercise the actual deploy orchestration with isolated Git and fake I/O."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.root = self.directory / "repo"
        self.root.mkdir()
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        scripts = self.root / "scripts"
        scripts.mkdir()
        for name in ("deploy-prod.sh", "release-lib.sh", "check-release-acceptance.py"):
            shutil.copy2(SCRIPT.with_name(name), scripts / name)
        (self.root / "daemon").mkdir()
        (self.root / "daemon" / "source").write_text("unchanged daemon")
        (self.root / "mobile").mkdir()
        (self.root / "mobile" / "source").write_text("old phone bundle")
        self.executable(
            scripts / "update-mobile-prod.sh",
            """
import os
from pathlib import Path
attempts = Path(os.environ['TEST_IO']) / 'ota-attempts'
previous = attempts.read_text() if attempts.exists() else ''
attempts.write_text(previous + 'publish\\n')
raise SystemExit(1 if not previous else 0)
""",
        )
        self.git("init", "--initial-branch=master")
        self.git("add", ".")
        self.git("commit", "-m", "baseline")
        self.baseline = self.git("rev-parse", "HEAD")
        (self.root / "mobile" / "source").write_text("new phone bundle")
        self.git("commit", "-am", "candidate")
        self.candidate = self.git("rev-parse", "HEAD")
        self.git("remote", "add", "origin", str(self.root))
        tree = self.git("rev-parse", "HEAD:daemon")
        release = {
            "server": {"commit": self.candidate, "dirty": False},
            "daemon": {"tree": tree},
        }
        (self.directory / "release.json").write_text(json.dumps(release))
        evidence = {
            "schema_version": 1,
            "status": "passed",
            "candidate_commit": self.candidate,
            "baseline_commit": self.baseline,
            "reports": {
                name: {
                    **report(name),
                    "candidate_commit": self.candidate,
                    "baseline_commit": self.baseline,
                }
                for name in ("ios", "android", "canary")
            },
        }
        (self.directory / "acceptance.json").write_text(json.dumps(evidence))
        # Inject only the public HTTP response; the production gate and all Git
        # comparisons run normally. Any unexpected network request fails.
        (self.directory / "sitecustomize.py").write_text("""
import io, os, urllib.request
from pathlib import Path
def release_response(url, **kwargs):
    assert url == 'https://spawnd.dev/api/release', url
    return io.BytesIO((Path(os.environ['TEST_IO']) / 'release.json').read_bytes())
urllib.request.urlopen = release_response
""")
        self.executable(
            self.bin / "ssh",
            """
import json, os, sys
from pathlib import Path
root = Path(os.environ['TEST_IO'])
release = json.loads((root / 'release.json').read_text())
with (root / 'ssh-calls').open('a') as calls:
    calls.write('ssh\\n')
command = sys.argv[-1]
if command == 'mktemp /tmp/spawn-remote-deploy.XXXXXX':
    print('/tmp/disposable-review-deploy')
elif command.startswith('cat > '):
    sys.stdin.read()
elif "bash '/tmp/disposable-review-deploy'" in command:
    pass
else:
    body = sys.stdin.read()
    if 'git rev-parse HEAD' in body:
        print(release['server']['commit'])
    elif 'manifest.json' in body:
        print(json.dumps(release['daemon']))
    elif '/api/release' in body:
        print(json.dumps(release))
    else:
        raise AssertionError((command, body))
""",
        )
        for name in ("uv", "scp", "curl"):
            self.executable(
                self.bin / name, "raise AssertionError('Unexpected external command')"
            )
        self.env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("SPAWN_", "GIT_", "PYTHON"))
        }
        self.env.update(
            PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
            PYTHONPATH=str(self.directory),
            TEST_IO=str(self.directory),
            SPAWN_DEPLOY_PREBUILTS="0",
            SPAWN_DEPLOY_MOBILE_CHANNEL="production",
        )

    def executable(self, path, source):
        path.write_text(f"#!{sys.executable}\n" + source)
        path.chmod(0o755)

    def git(self, *args):
        return subprocess.check_output(
            [
                "git",
                "-c",
                "user.name=Acceptance",
                "-c",
                "user.email=acceptance@example.com",
                *args,
            ],
            cwd=self.root,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()

    def deploy(self, *args):
        return subprocess.run(
            [
                "bash",
                "scripts/deploy-prod.sh",
                "fixture-only",
                "--acceptance-evidence",
                str(self.directory / "acceptance.json"),
                *args,
            ],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=15,
        )

    def test_an_advanced_server_requires_explicit_resume_before_any_ssh(self):
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("release acceptance evidence was refused", result.stderr)
        self.assertFalse((self.directory / "ssh-calls").exists())

    def test_resume_retries_failed_ota_even_when_remote_checkout_already_is_candidate(
        self,
    ):
        first = self.deploy("--resume")
        self.assertNotEqual(first.returncode, 0)
        self.assertIn("mobile OTA failed", first.stderr, first.stdout + first.stderr)
        second = self.deploy("--resume")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn("deploy-prod: complete", second.stdout)
        self.assertEqual(
            (self.directory / "ota-attempts").read_text(), "publish\npublish\n"
        )


class CITests(unittest.TestCase):
    def response(self, *runs):
        return json.dumps({"workflow_runs": runs})

    def test_exact_master_push_linux_and_windows_both_pass(self):
        with patch.object(
            gate.subprocess, "check_output", return_value=self.response(run_record())
        ) as call:
            gate.wait_ci(REPOSITORY, CANDIDATE, windows=True, timeout=0)
        self.assertEqual(call.call_count, 2)
        endpoints = [item.args[0][2] for item in call.call_args_list]
        self.assertTrue(any("test.yml" in item for item in endpoints))
        self.assertTrue(any("windows.yml" in item for item in endpoints))

    def test_baseline_pr_feature_branch_and_foreign_green_runs_do_not_count(self):
        for changes in (
            {"head_sha": BASELINE},
            {"event": "pull_request"},
            {"event": "workflow_dispatch"},
            {"head_branch": "transport/device-daemon"},
            {"head_repository": {"full_name": "other/spawn"}},
        ):
            with (
                self.subTest(changes=changes),
                patch.object(
                    gate.subprocess,
                    "check_output",
                    return_value=self.response(run_record(**changes)),
                ),
                self.assertRaises(TimeoutError),
            ):
                gate.wait_ci(REPOSITORY, CANDIDATE, windows=False, timeout=0)

    def test_newer_failure_or_rerun_cannot_be_hidden_by_earlier_success(self):
        for failed in (
            run_record(run_number=9, conclusion="failure"),
            run_record(run_attempt=2, conclusion="cancelled"),
        ):
            with (
                self.subTest(run=failed),
                patch.object(
                    gate.subprocess,
                    "check_output",
                    return_value=self.response(run_record(), failed),
                ),
                self.assertRaises(ValueError),
            ):
                gate.wait_ci(REPOSITORY, CANDIDATE, windows=False, timeout=0)

    def test_incomplete_or_missing_ci_times_out(self):
        for runs in ([], [run_record(status="in_progress", conclusion=None)]):
            with (
                self.subTest(runs=runs),
                patch.object(
                    gate.subprocess, "check_output", return_value=self.response(*runs)
                ),
                self.assertRaises(TimeoutError),
            ):
                gate.wait_ci(REPOSITORY, CANDIDATE, windows=False, timeout=0)

    def test_pending_ci_is_polled_until_this_commit_completes(self):
        with (
            patch.object(
                gate.subprocess,
                "check_output",
                side_effect=[
                    self.response(run_record(status="in_progress")),
                    self.response(run_record()),
                ],
            ),
            patch.object(gate.time, "sleep") as sleep,
        ):
            gate.wait_ci(REPOSITORY, CANDIDATE, windows=False, timeout=60)
        self.assertEqual(sleep.call_count, 1)

    def test_windows_decision_uses_real_changed_trees(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def git(*args):
                return subprocess.check_output(
                    [
                        "git",
                        "-c",
                        "user.name=Acceptance",
                        "-c",
                        "user.email=acceptance@example.com",
                        *args,
                    ],
                    cwd=root,
                    text=True,
                    stderr=subprocess.DEVNULL,
                ).strip()

            git("init", "--initial-branch=master")
            for directory in ("daemon", "desktop", "mobile"):
                (root / directory).mkdir()
                (root / directory / "source").write_text("baseline")
            git("add", ".")
            git("commit", "-m", "baseline")
            baseline = git("rev-parse", "HEAD")
            (root / "mobile" / "source").write_text("candidate")
            git("commit", "-am", "mobile only")
            with patch.object(gate, "ROOT", root):
                self.assertFalse(
                    gate.requires_windows(git("rev-parse", "HEAD"), baseline)
                )
                (root / "daemon" / "source").write_text("candidate")
                git("commit", "-am", "daemon")
                self.assertTrue(
                    gate.requires_windows(git("rev-parse", "HEAD"), baseline)
                )
                # The latest push can be mobile-only while Windows is still
                # owed for the daemon change since the deployed baseline.
                (root / "mobile" / "source").write_text("follow-up")
                git("commit", "-am", "mobile follow-up before daemon deployment")
                candidate = git("rev-parse", "HEAD")
                previous = git("rev-parse", "HEAD^")
                self.assertFalse(gate.requires_windows(candidate, previous))
                self.assertTrue(gate.requires_windows(candidate, baseline))


if __name__ == "__main__":
    unittest.main(verbosity=2)
