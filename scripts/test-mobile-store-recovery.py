#!/usr/bin/env python3
"""Regression coverage for skipped ancestors and original-release identity."""
import copy
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("recovery", ROOT / "scripts/check-mobile-store-recovery.py")
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
SHA = "a" * 40
BASE = "b" * 40


class RecoveryTests(unittest.TestCase):
    def test_original_master_run_required(self):
        original = {"repository": {"full_name": "levy-street/spawn"},
                    "path": ".github/workflows/release.yml", "head_branch": "master",
                    "event": "push", "status": "completed", "head_sha": SHA}
        self.assertEqual(recovery.validate_run(original), SHA)
        for key, value in (("path", ".github/workflows/test.yml"), ("head_branch", "feature"),
                           ("event", "pull_request"), ("status", "in_progress"),
                           ("head_sha", "abc"), ("repository", {"full_name": "other/spawn"})):
            with self.subTest(key=key), self.assertRaises(ValueError):
                recovery.validate_run({**original, key: value})

    def test_missing_skipped_failed_or_duplicate_prerequisites_refused(self):
        for jobs in ([], [{"name": "deploy", "conclusion": "skipped"}],
                     [{"name": "deploy", "conclusion": "failure"}],
                     [{"name": "deploy", "conclusion": "success"}] * 2):
            with self.assertRaises(ValueError):
                recovery.required_job(jobs, "deploy")

    def test_timestamped_native_plan_is_bound_to_original_candidate(self):
        plan = {"from": BASE, "to": SHA, "mobile_native_build": "yes"}
        def log(value):
            return "unrelated private log omitted\n" + "\n".join(
                "2026-09-20T13:46:22.0567893Z " + line
                for line in json.dumps(value, indent=2).splitlines())
        self.assertEqual(recovery.plan_from_log(log(plan), SHA), plan)
        for change in ({"to": BASE}, {"from": SHA}, {"from": "short"},
                       {"mobile_native_build": "no"}, {"mobile_native_build": "unknown"}):
            with self.assertRaises(ValueError):
                recovery.plan_from_log(log({**plan, **change}), SHA)
        with self.assertRaises(ValueError):
            recovery.plan_from_log(log(plan) + "\n" + log(plan), SHA)

    def test_current_deployment_must_match_and_acceptance_remains_required(self):
        with patch.object(recovery.gate, "validate_aggregate") as validate:
            recovery.validate_identity(SHA, BASE, {}, SHA, "tree", "tree")
            validate.assert_called_once_with({}, SHA, BASE)
            for deployed, tree in ((BASE, "tree"), (SHA, "other")):
                with self.assertRaises(ValueError):
                    recovery.validate_identity(SHA, BASE, {}, deployed, tree, "tree")
            validate.side_effect = ValueError("failed native acceptance")
            with self.assertRaisesRegex(ValueError, "failed native"):
                recovery.validate_identity(SHA, BASE, {}, SHA, "tree", "tree")

    def test_store_and_desktop_survive_skipped_ancestor_but_require_success(self):
        workflow = yaml.load((ROOT / ".github/workflows/release.yml").read_text(), Loader=yaml.BaseLoader)
        # Model GitHub's implicit success(): absent a status function, the
        # intentionally skipped await_prebuilts ancestor suppresses the job.
        def evaluate(expression, needs, cancelled=False, ancestors_success=False):
            if not re.search(r"\b(always|cancelled|success|failure)\(\)", expression):
                if not ancestors_success:
                    return False
            expression = expression.replace("!cancelled()", repr(not cancelled))
            expression = re.sub(r"needs\.([\w-]+)\.outputs\.([\w_]+)",
                                lambda m: repr(needs[m[1]]["outputs"][m[2]]), expression)
            expression = re.sub(r"needs\.([\w-]+)\.result",
                                lambda m: repr(needs[m[1]]["result"]), expression)
            return eval(expression.replace("&&", " and ").replace("||", " or "), {"__builtins__": {}}, {})
        for job, output, owed in (("mobile-store-build", "mobile_native_build", "yes"),
                                 ("desktop-publish", "desktop_publish", "true")):
            expression = workflow["jobs"][job]["if"]
            needs = {"plan": {"result": "success", "outputs": {output: owed}},
                     "deploy": {"result": "success"}}
            self.assertTrue(evaluate(expression, needs))
            self.assertTrue(evaluate(expression, needs, ancestors_success=True))
            self.assertFalse(evaluate(expression, needs, cancelled=True))
            for dependency in needs:
                for result in ("failure", "cancelled", "skipped"):
                    changed = copy.deepcopy(needs)
                    changed[dependency]["result"] = result
                    self.assertFalse(evaluate(expression, changed))
            needs["plan"]["outputs"][output] = "no"
            self.assertFalse(evaluate(expression, needs))

    def test_recovery_keeps_protected_environment_and_serializes_with_release(self):
        workflow = yaml.load((ROOT / ".github/workflows/mobile-store-recovery.yml").read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(set(workflow["on"]), {"workflow_dispatch"})
        self.assertEqual(workflow["concurrency"], {"group": "release", "cancel-in-progress": "false"})
        self.assertEqual(workflow["jobs"]["recover"]["environment"], "production")
        self.assertEqual(workflow["jobs"]["recover"]["if"], "github.ref == 'refs/heads/master'")

    def test_owed_store_completion_check_rejects_skips_and_failures(self):
        workflow = yaml.load((ROOT / ".github/workflows/release.yml").read_text(), Loader=yaml.BaseLoader)
        job = workflow["jobs"]["verify-mobile-store-build"]
        self.assertIn("always()", job["if"])
        command = job["steps"][0]["run"]
        for result in ("success", "failure", "skipped", "cancelled", ""):
            actual = subprocess.run(["/bin/bash", "-c", command], env={"STORE_RESULT": result})
            self.assertEqual(actual.returncode == 0, result == "success")


if __name__ == "__main__":
    unittest.main()
