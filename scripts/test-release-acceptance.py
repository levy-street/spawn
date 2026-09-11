#!/usr/bin/env python3
"""Release evidence rejection tests with no production, GitHub, or native calls."""

from __future__ import annotations

import copy
import importlib.util
import io
import json
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
