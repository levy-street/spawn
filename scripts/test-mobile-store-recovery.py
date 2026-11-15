#!/usr/bin/env python3
"""Regression coverage for the release's store-build rule, skipped ancestors
and original-release identity.

A push never starts a store build. The release plan owes one only when a
platform's native fingerprint differs from its last production build; a
JavaScript, docs or test change owes none, and an unanswered check withholds
the phone update and stops loudly instead of guessing either way.
"""
import copy
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("recovery", ROOT / "scripts/check-mobile-store-recovery.py")
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
SHA = "a" * 40
BASE = "b" * 40


# Every key of release-plan.sh's JSON that release.yml passes on as a plan output.
PLAN_KEYS = {"deploy", "daemon_prebuilts", "mobile_ota", "desktop_publish",
             "mobile_native_build", "mobile_native_ios", "mobile_native_android",
             "mobile_native_reason", "mobile_runtime", "mobile_native_ios_runtime",
             "mobile_native_android_runtime"}


def release_workflow():
    return yaml.load((ROOT / ".github/workflows/release.yml").read_text(), Loader=yaml.BaseLoader)


def evaluate(expression, needs, cancelled=False, ancestors_success=False):
    """Model a GitHub job condition: absent a status function, implicit
    success() means an intentionally skipped ancestor suppresses the job."""
    expression = expression.strip()
    if expression.startswith("${{") and expression.endswith("}}"):
        expression = expression[3:-2]
    if not re.search(r"\b(always|cancelled|success|failure)\(\)", expression):
        if not ancestors_success:
            return False
    expression = expression.replace("!cancelled()", repr(not cancelled))
    expression = expression.replace("always()", "True")
    expression = re.sub(r"needs\.([\w-]+)\.outputs\.([\w_]+)",
                        lambda m: repr(needs[m[1]]["outputs"].get(m[2], "")), expression)
    expression = re.sub(r"needs\.([\w-]+)\.result",
                        lambda m: repr(needs[m[1]]["result"]), expression)
    return eval(expression.replace("&&", " and ").replace("||", " or "), {"__builtins__": {}}, {})


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

    def test_new_and_old_cli_capture_logs_without_printing_private_ansi(self):
        plan = {"from": BASE, "to": SHA, "mobile_native_build": "yes"}
        log = "\x1b[31mprivate command output\x1b[0m\n" + json.dumps(plan, indent=2)
        for modern in (True, False):
            with self.subTest(modern=modern):
                def cli(*args):
                    if args == ("gh", "api", "--help"):
                        return "--allow-escape-sequences" if modern else "old CLI help"
                    self.assertEqual(args[:3], ("gh", "api", "repos/levy-street/spawn/actions/jobs/123/logs"))
                    if ("--allow-escape-sequences" in args) != modern:
                        raise subprocess.CalledProcessError(1, args, stderr="private CLI response")
                    return log
                output = io.StringIO()
                with patch.object(recovery, "run", side_effect=cli), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    actual = recovery.plan_from_log(recovery.read_plan_log(123), SHA)
                self.assertEqual(actual, plan)
                self.assertEqual(output.getvalue(), "")

    def test_log_download_failure_names_stage_without_exposing_response(self):
        error = subprocess.CalledProcessError(1, ["gh"], output="private raw log", stderr="private signed URL")
        with patch.object(recovery, "run", side_effect=["--allow-escape-sequences", error]):
            with self.assertRaises(ValueError) as raised:
                recovery.read_plan_log(123)
        self.assertEqual(str(raised.exception), "Could not download the original release plan log; no store operation allowed")

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

    def test_desktop_survives_skipped_ancestor_but_requires_success(self):
        workflow = release_workflow()
        expression = workflow["jobs"]["desktop-publish"]["if"]
        needs = {"plan": {"result": "success", "outputs": {"desktop_publish": "true"}},
                 "deploy": {"result": "success"}}
        # The intentionally skipped await_prebuilts ancestor must not suppress it.
        self.assertTrue(evaluate(expression, needs))
        self.assertTrue(evaluate(expression, needs, ancestors_success=True))
        self.assertFalse(evaluate(expression, needs, cancelled=True))
        for dependency in needs:
            for result in ("failure", "cancelled", "skipped"):
                changed = copy.deepcopy(needs)
                changed[dependency]["result"] = result
                self.assertFalse(evaluate(expression, changed))
        needs["plan"]["outputs"]["desktop_publish"] = "false"
        self.assertFalse(evaluate(expression, needs))

    def test_recovery_keeps_protected_environment_and_serializes_with_release(self):
        workflow = yaml.load((ROOT / ".github/workflows/mobile-store-recovery.yml").read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(set(workflow["on"]), {"workflow_dispatch"})
        self.assertEqual(workflow["concurrency"], {"group": "release", "cancel-in-progress": "false"})
        self.assertEqual(workflow["jobs"]["recover"]["environment"], "production")
        self.assertEqual(workflow["jobs"]["recover"]["if"], "github.ref == 'refs/heads/master'")


class ReleaseWorkflowStoreRule(unittest.TestCase):
    """release.yml never builds a store app, and holds the phone back loudly."""

    def setUp(self):
        self.workflow = release_workflow()

    def test_no_release_job_starts_an_eas_build_submit_or_update(self):
        eas = re.compile(r"(\beas|eas-cli)\s+(build|submit|update)\b|--auto-submit")
        for name, job in self.workflow["jobs"].items():
            for step in job.get("steps", []):
                with self.subTest(job=name, step=step.get("name") or step.get("uses")):
                    self.assertNotRegex(step.get("run", ""), eas)
                    self.assertNotIn("expo", step.get("uses", "").lower())
        self.assertNotIn("mobile-store-build", self.workflow["jobs"])

    def test_phone_update_only_when_the_native_shell_is_proven_to_fit(self):
        steps = self.workflow["jobs"]["deploy"]["steps"]
        [deploy] = [step for step in steps if "scripts/deploy-prod.sh spawnd-prod" in step.get("run", "")]
        expression = deploy["env"]["SPAWN_DEPLOY_MOBILE"]
        for verdict, publish in (("no", "1"), ("yes", "0"), ("unknown", "0"), ("", "0")):
            with self.subTest(verdict=verdict):
                needs = {"plan": {"result": "success", "outputs": {"mobile_native_build": verdict}}}
                self.assertEqual(evaluate(expression, needs, ancestors_success=True), publish)

    def test_withheld_phone_update_stops_the_release_whatever_the_deploy_did(self):
        job = self.workflow["jobs"]["store-build-owed"]
        self.assertEqual(job["name"], "require the owed store builds")
        self.assertNotIn("environment", job)  # it holds no credentials
        for verdict, ota, runs in (("yes", "true", True), ("unknown", "true", True),
                                   ("no", "true", False), ("no", "false", False)):
            for deploy in ("success", "failure", "skipped", "cancelled"):
                with self.subTest(verdict=verdict, ota=ota, deploy=deploy):
                    needs = {"plan": {"result": "success", "outputs": {
                                 "mobile_native_build": verdict, "mobile_ota": ota}},
                             "deploy": {"result": deploy}}
                    self.assertEqual(evaluate(job["if"], needs), runs)
        failed_plan = {"plan": {"result": "failure", "outputs": {}}, "deploy": {"result": "skipped"}}
        self.assertFalse(evaluate(job["if"], failed_plan))
        owed = {"plan": {"result": "success", "outputs": {"mobile_native_build": "yes", "mobile_ota": "true"}},
                "deploy": {"result": "cancelled"}}
        self.assertFalse(evaluate(job["if"], owed, cancelled=True))

    def stop(self, **env):
        job = self.workflow["jobs"]["store-build-owed"]
        [step] = job["steps"]
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / "summary.md"
            values = {"BASELINE": BASE, "CANDIDATE": SHA, "RELEASE_RUN": "123456",
                      "DEPLOY_RESULT": "success", "RUNTIME": "1.0.0", "IOS_RUNTIME": "1.0.0",
                      "ANDROID_RUNTIME": "1.0.0",
                      "REASON": "the reason", "GITHUB_STEP_SUMMARY": str(summary),
                      "PATH": os.environ["PATH"], **env}
            result = subprocess.run(["bash", "-e", "-c", step["run"]], env=values,
                                    capture_output=True, text=True, timeout=15)
            return result, summary.read_text()

    def test_native_change_names_only_the_owed_platforms_and_the_deliberate_step(self):
        for ios, android, owed in (("no", "yes", ["android"]), ("yes", "no", ["ios"]),
                                   ("yes", "yes", ["ios", "android"]),
                                   ("yes", "unknown", ["ios"])):
            with self.subTest(ios=ios, android=android):
                result, summary = self.stop(VERDICT="yes", IOS=ios, ANDROID=android)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("::error", result.stdout)
                self.assertIn("a store build is owed", summary)
                self.assertIn("mobile-store-recovery.yml --ref master -f release_run=123456 -f operation=inspect", summary)
                for platform in ("ios", "android"):
                    self.assertEqual(f"operation=build-{platform}" in summary, platform in owed)
                # Dispatches share the release concurrency group: one at a time.
                self.assertIn("one at a time", summary)
                self.assertIn("left unbuilt stays at yes", summary)

    def test_native_change_on_the_installed_runtime_warns_before_any_build(self):
        same = "do not build from this run"
        for runtimes, warned, phrase in (
            ({"RUNTIME": "1.0.0", "IOS_RUNTIME": "1.0.0", "ANDROID_RUNTIME": "1.0.0"}, True, "keeps runtime `1.0.0`"),
            # One owed platform on the installed runtime is enough to warn.
            ({"RUNTIME": "1.0.0", "IOS_RUNTIME": "unknown", "ANDROID_RUNTIME": "1.0.0"}, True, "keeps runtime"),
            ({"RUNTIME": "1.1.0", "IOS_RUNTIME": "1.0.0", "ANDROID_RUNTIME": "1.0.0"}, False, "runtime differs"),
            ({"RUNTIME": "unknown", "IOS_RUNTIME": "1.0.0", "ANDROID_RUNTIME": "1.0.0"}, False, "could not be compared"),
            ({"RUNTIME": "1.0.0", "IOS_RUNTIME": "", "ANDROID_RUNTIME": ""}, False, "could not be compared"),
        ):
            with self.subTest(**runtimes):
                result, summary = self.stop(VERDICT="yes", IOS="yes", ANDROID="yes", **runtimes)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(same in summary, warned)
                self.assertEqual("bump `expo.version`" in summary, warned)
                self.assertIn(phrase, summary)
                self.assertIn(f"carry runtime `{runtimes['RUNTIME'] or 'unknown'}`", summary)

    def test_unknown_withholds_and_asks_for_exactly_this_commit_never_a_build(self):
        result, summary = self.stop(VERDICT="unknown", IOS="unknown", ANDROID="no")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not answer", summary)
        # Pinned to the run: master's tip may be newer than the deployed server,
        # and a stale install can hide a new native module from the fingerprint.
        self.assertIn(f"git fetch origin && git checkout --detach {SHA}", summary)
        self.assertIn("(cd mobile && npm ci)", summary)
        self.assertIn(f"scripts/release-plan.sh --from {BASE} --to {SHA}", summary)
        self.assertNotIn("--to HEAD", summary)
        self.assertIn("scripts/update-mobile-prod.sh", summary)
        self.assertNotIn("operation=build-", summary)

    def test_every_stop_warns_off_rerun_all_and_explains_verify_release(self):
        for verdict in ("yes", "unknown"):
            with self.subTest(verdict=verdict):
                _, summary = self.stop(VERDICT=verdict, IOS="yes", ANDROID="unknown")
                self.assertIn("Do not use **Re-run all jobs**", summary)
                self.assertIn("**Re-run failed jobs** is fine", summary)
                self.assertIn("`scripts/verify-release.sh` reports `mobile.tree`", summary)

    def test_every_plan_output_the_release_reads_is_declared_and_produced(self):
        text = (ROOT / ".github/workflows/release.yml").read_text()
        read = set(re.findall(r"needs\.plan\.outputs\.(\w+)", text))
        declared = set(self.workflow["jobs"]["plan"]["outputs"])
        self.assertLessEqual(read, declared)
        [step] = [step for step in self.workflow["jobs"]["plan"]["steps"] if step.get("id") == "plan"]
        for name in declared - {"baseline"}:
            with self.subTest(output=name):
                self.assertIn(f'"{name}"', step["run"])
        self.assertLessEqual(declared - {"baseline"}, PLAN_KEYS)


# A stand-in for eas-cli that behaves like Expo where it matters: the
# fingerprint hashes the platform's native inputs *and* the evaluated config's
# `extra`, which app.config.ts fills from EXPO_PUBLIC_API_URL and the mobile
# tree stamp. A build's stored fingerprint used its own commit's tree and its
# profile's env. It refuses every subcommand that could cost money or reach
# phones, and logs each call.
FAKE_EAS = textwrap.dedent("""\
    #!/usr/bin/env python3
    import hashlib, json, os, subprocess, sys
    args = sys.argv[1:]
    with open(os.environ["FAKE_EAS_LOG"], "a") as log:
        log.write(json.dumps(args) + "\\n")
    def git(*a):
        return subprocess.check_output(["git", *a], text=True).strip()
    def option(name):
        return args[args.index(name) + 1]
    def fingerprint(native, api_url, tree, platform):
        extra = {"mobileTree": tree, **({"apiUrl": api_url} if api_url else {})}
        sources = [{"type": "file", "filePath": f"native-{platform}.txt",
                    "hash": hashlib.sha1(native.encode()).hexdigest()},
                   {"type": "contents", "id": "expoConfig",
                    "contents": json.dumps({"extra": extra}, sort_keys=True)}]
        return {"hash": hashlib.sha1(json.dumps(sources).encode()).hexdigest(), "sources": sources}
    builds = json.loads(os.environ.get("FAKE_EAS_BUILDS", "{}"))
    if args[0] == "build:list":
        mode = os.environ.get("FAKE_EAS_LIST", "ok")
        if mode == "fail":
            sys.exit(1)
        build = builds.get(option("--platform"))  # carries runtime.version, as EAS does
        print(json.dumps([] if mode == "empty" or not build else [build]))
    elif args[0] == "fingerprint:compare":
        if os.environ.get("FAKE_EAS_COMPARE") == "fail":
            sys.exit(1)
        [(platform, build)] = [(p, b) for p, b in builds.items() if b["id"] == option("--build-id")]
        commit = build["gitCommitHash"]
        profile = json.loads(git("show", f"{commit}:mobile/eas.json"))["build"]["production"]
        stored = fingerprint(git("show", f"{commit}:mobile/native-{platform}.txt"),
                             profile.get("env", {}).get("EXPO_PUBLIC_API_URL"),
                             git("rev-parse", f"{commit}:mobile"), platform)
        local = fingerprint(open(f"native-{platform}.txt").read().strip(),
                            os.environ.get("EXPO_PUBLIC_API_URL"),
                            os.environ.get("EXPO_PUBLIC_SPAWN_MOBILE_TREE") or git("rev-parse", "HEAD:mobile"),
                            platform)
        print(json.dumps({"fingerprint1": stored, "fingerprint2": local}))
    else:
        sys.exit(f"fake eas refuses {args[0]}")
""")


class ReleasePlanTests(unittest.TestCase):
    """scripts/release-plan.sh, run for real against a throwaway repository."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name) / "repo"
        bin_dir = Path(self.directory.name) / "bin"
        (self.repo / "scripts").mkdir(parents=True)
        bin_dir.mkdir()
        shutil.copy(ROOT / "scripts/release-plan.sh", self.repo / "scripts/release-plan.sh")
        (bin_dir / "eas").write_text(FAKE_EAS)
        # If the plan ever fell back to the real CLI, fail instead of reaching EAS.
        (bin_dir / "npx").write_text("#!/bin/sh\nexit 97\n")
        for tool in ("eas", "npx"):
            (bin_dir / tool).chmod(0o755)
        self.log = Path(self.directory.name) / "eas.log"
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("EXPO_", "GIT_"))}
        self.env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", FAKE_EAS_LOG=str(self.log),
                        GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@example.invalid",
                        GIT_COMMITTER_NAME="test", GIT_COMMITTER_EMAIL="test@example.invalid")
        self.git("init", "-q")
        for piece in ("server", "web", "daemon", "desktop"):
            self.write(f"{piece}/README", piece)
        self.write("mobile/app.json", json.dumps({"expo": {
            "version": "1.2.3", "runtimeVersion": {"policy": "appVersion"}}}))
        self.write("mobile/eas.json", json.dumps({"build": {
            "base": {"channel": "base"},
            "production": {"extends": "base", "env": {"EXPO_PUBLIC_API_URL": "https://example.invalid"}}}}))
        self.write("mobile/native-ios.txt", "ios shell 1")
        self.write("mobile/native-android.txt", "android shell 1")
        self.write("mobile/app.ts", "export const screen = 1;")
        self.built = self.commit("the commit both production builds were made from")
        self.builds = {"ios": {"id": "11111111-1111-4111-8111-111111111111", "gitCommitHash": self.built,
                               "runtime": {"version": "1.2.3"}},
                       "android": {"id": "22222222-2222-4222-8222-222222222222", "gitCommitHash": self.built,
                                   "runtime": {"version": "1.2.3"}}}

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, env=self.env, text=True).strip()

    def write(self, path, text):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text + "\n")

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def plan(self, *args, **env):
        self.log.unlink(missing_ok=True)
        values = {**self.env, "FAKE_EAS_BUILDS": json.dumps(self.builds), **env}
        result = subprocess.run(["bash", "scripts/release-plan.sh", "--json", *args], cwd=self.repo,
                                env=values, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line)[0] for line in self.log.read_text().splitlines()] if self.log.exists() else []
        self.assertTrue(set(calls) <= {"build:list", "fingerprint:compare"}, calls)
        return json.loads(result.stdout), calls

    def test_javascript_docs_and_test_change_owes_no_store_build(self):
        self.write("mobile/app.ts", "export const screen = 2;")
        self.write("mobile/tests/screen.test.ts", "test")
        self.write("mobile/CLAUDE.md", "notes")
        candidate = self.commit("JavaScript, a test and a doc")
        # An inherited shell value is not what any build had, so it is ignored.
        plan, calls = self.plan("--from", self.built, "--to", candidate,
                                EXPO_PUBLIC_API_URL="http://localhost:3000")
        self.assertTrue(plan["mobile_ota"])
        self.assertEqual((plan["mobile_native_build"], plan["mobile_native_ios"],
                          plan["mobile_native_android"]), ("no", "no", "no"))
        self.assertIn(self.builds["ios"]["id"], plan["mobile_native_ios_reason"])
        self.assertEqual(calls.count("fingerprint:compare"), 2)

    def test_native_change_owes_a_build_for_that_platform_only(self):
        self.write("mobile/native-android.txt", "android shell 2")
        self.write("mobile/app.ts", "export const screen = 2;")
        candidate = self.commit("an Android-only native change")
        plan, _ = self.plan("--from", self.built, "--to", candidate)
        self.assertEqual((plan["mobile_native_build"], plan["mobile_native_ios"],
                          plan["mobile_native_android"]), ("yes", "no", "yes"))
        self.assertIn(self.builds["android"]["id"], plan["mobile_native_android_reason"])
        self.assertIn("native-android.txt", plan["mobile_native_android_reason"])
        self.assertNotIn("expoConfig", plan["mobile_native_android_reason"])

    def test_each_platform_compares_with_its_own_last_build(self):
        self.write("mobile/native-ios.txt", "ios shell 2")
        ios_built = self.commit("a native iOS change, already built for iOS")
        self.builds["ios"]["gitCommitHash"] = ios_built
        self.write("mobile/app.ts", "export const screen = 2;")
        candidate = self.commit("JavaScript")
        plan, _ = self.plan("--from", ios_built, "--to", candidate)
        self.assertEqual((plan["mobile_native_ios"], plan["mobile_native_android"]), ("no", "no"))

    def test_a_build_of_this_very_tree_needs_no_comparison(self):
        self.write("mobile/native-ios.txt", "ios shell 2")
        candidate = self.commit("native, then built")
        self.builds = {platform: {**build, "gitCommitHash": candidate} for platform, build in self.builds.items()}
        self.write("server/README", "server 2")
        later = self.commit("server only")
        plan, calls = self.plan("--from", self.built, "--to", later)
        self.assertEqual(plan["mobile_native_build"], "no")
        self.assertIn("was made from this mobile tree", plan["mobile_native_ios_reason"])
        self.assertNotIn("fingerprint:compare", calls)

    def test_unchanged_mobile_tree_asks_nothing(self):
        self.write("server/README", "server 2")
        candidate = self.commit("server only")
        plan, calls = self.plan("--from", self.built, "--to", candidate)
        self.assertEqual((plan["deploy"], plan["mobile_ota"], plan["mobile_native_build"]), (True, False, "no"))
        self.assertEqual(calls, [])

    def test_an_unanswered_check_is_unknown_never_no(self):
        self.write("mobile/app.ts", "export const screen = 2;")
        candidate = self.commit("JavaScript")
        stranger = self.builds["ios"] | {"gitCommitHash": "c" * 40}
        cases = [
            (["--no-fingerprint"], {}, None, "the fingerprint check was skipped"),
            ([], {"FAKE_EAS_LIST": "fail"}, None, "no finished production ios build"),
            ([], {"FAKE_EAS_LIST": "empty"}, None, "no finished production android build"),
            ([], {"FAKE_EAS_COMPARE": "fail"}, None, "did not answer"),
            ([], {}, {"ios": stranger, "android": self.builds["android"]}, "names no commit"),
        ]
        for extra, env, builds, reason in cases:
            with self.subTest(reason=reason):
                original, self.builds = self.builds, builds or self.builds
                try:
                    plan, _ = self.plan("--from", self.built, "--to", candidate, *extra, **env)
                finally:
                    self.builds = original
                self.assertTrue(plan["mobile_ota"])
                self.assertEqual(plan["mobile_native_build"], "unknown")
                self.assertIn(reason, plan["mobile_native_reason"])

    def test_the_candidate_must_be_the_checkout(self):
        self.write("mobile/app.ts", "export const screen = 2;")
        candidate = self.commit("JavaScript")
        self.git("checkout", "-q", self.built)
        plan, calls = self.plan("--from", self.built, "--to", candidate)
        self.assertEqual(plan["mobile_native_build"], "unknown")
        self.assertIn("not a clean", plan["mobile_native_reason"])
        self.assertEqual(calls, [])
        self.git("checkout", "-q", candidate)
        self.write("mobile/native-ios.txt", "uncommitted native change")
        plan, _ = self.plan("--from", self.built, "--to", candidate)
        self.assertEqual(plan["mobile_native_build"], "unknown")

    def test_an_inherited_value_no_build_had_is_never_hashed(self):
        # The build's profile set no API URL, so its config had none. A shell
        # value would put one into this tree's config and read as native.
        self.write("mobile/eas.json", json.dumps({"build": {"production": {"channel": "production"}}}))
        built = self.commit("built from a profile without env")
        self.builds = {platform: {**build, "gitCommitHash": built} for platform, build in self.builds.items()}
        self.write("mobile/app.ts", "export const screen = 2;")
        candidate = self.commit("JavaScript")
        plan, _ = self.plan("--from", built, "--to", candidate, EXPO_PUBLIC_API_URL="http://localhost:3000")
        self.assertEqual(plan["mobile_native_build"], "no", plan["mobile_native_reason"])

    def test_a_check_that_falls_over_is_unknown_never_no(self):
        # A build whose commit has no mobile/ tree makes the per-platform check
        # die without a verdict; the plan must not read that silence as "no".
        empty_tree = self.git("hash-object", "-t", "tree", "/dev/null")
        rootless = self.git("commit-tree", empty_tree, "-m", "a commit without mobile/")
        self.builds["ios"]["gitCommitHash"] = rootless
        self.write("mobile/app.ts", "export const screen = 2;")
        candidate = self.commit("JavaScript")
        plan, _ = self.plan("--from", self.built, "--to", candidate)
        self.assertEqual(plan["mobile_native_ios"], "unknown")
        self.assertIn("ios fingerprint check failed", plan["mobile_native_ios_reason"])
        self.assertEqual(plan["mobile_native_android"], "no")
        self.assertEqual(plan["mobile_native_build"], "unknown")

    def test_runtime_of_this_tree_and_of_each_last_build_is_reported(self):
        self.write("mobile/native-ios.txt", "ios shell 2")
        candidate = self.commit("native iOS change on the installed runtime")
        plan, _ = self.plan("--from", self.built, "--to", candidate)
        self.assertEqual((plan["mobile_runtime"], plan["mobile_native_ios_runtime"],
                          plan["mobile_native_android_runtime"]), ("1.2.3", "1.2.3", "1.2.3"))
        self.write("mobile/app.json", json.dumps({"expo": {
            "version": "1.3.0", "runtimeVersion": {"policy": "appVersion"}}}))
        bumped = self.commit("version bump")
        plan, _ = self.plan("--from", self.built, "--to", bumped)
        self.assertEqual((plan["mobile_runtime"], plan["mobile_native_ios_runtime"]), ("1.3.0", "1.2.3"))
        self.write("mobile/app.json", json.dumps({"expo": {
            "version": "1.3.0", "runtimeVersion": {"policy": "fingerprint"}}}))
        other = self.commit("a runtime policy the plan does not compute")
        plan, _ = self.plan("--from", self.built, "--to", other)
        self.assertEqual(plan["mobile_runtime"], "unknown")
        del self.builds["android"]["runtime"]
        plan, _ = self.plan("--from", self.built, "--to", other)
        self.assertEqual(plan["mobile_native_android_runtime"], "unknown")

    def test_plan_reports_every_key_the_release_reads(self):
        self.write("mobile/app.ts", "export const screen = 2;")
        candidate = self.commit("JavaScript")
        plan, _ = self.plan("--from", self.built, "--to", candidate)
        self.assertLessEqual(PLAN_KEYS, set(plan))

    def test_plan_log_stays_readable_by_store_recovery(self):
        self.write("mobile/native-ios.txt", "ios shell 2")
        candidate = self.commit("native iOS change")
        plan, _ = self.plan("--from", self.built, "--to", candidate)
        log = "\n".join("2026-11-15T18:34:01.4775952Z " + line
                        for line in json.dumps(plan, indent=2).splitlines())
        self.assertEqual(recovery.plan_from_log(log, candidate)["mobile_native_ios"], "yes")


if __name__ == "__main__":
    unittest.main()
