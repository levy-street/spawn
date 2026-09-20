#!/usr/bin/env python3
"""Bind store recovery to a completed, accepted, still-deployed master release."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "levy-street/spawn"
spec = importlib.util.spec_from_file_location("acceptance", ROOT / "scripts/check-release-acceptance.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, stderr=subprocess.PIPE)


def api(path):
    return json.loads(run("gh", "api", f"repos/{REPOSITORY}/{path}"))


def read_plan_log(job_id):
    # Newer gh versions reject ANSI in raw responses even when stdout is a
    # pipe. Permit it only for this captured log: never echo it or the CLI's
    # response/error bodies. The parser below accepts only uncoloured JSON.
    flags = ["--allow-escape-sequences"] if "--allow-escape-sequences" in run("gh", "api", "--help") else []
    try:
        return run("gh", "api", f"repos/{REPOSITORY}/actions/jobs/{job_id}/logs", *flags)
    except subprocess.CalledProcessError:
        raise ValueError("Could not download the original release plan log; no store operation allowed") from None


def validate_run(release):
    require(release.get("repository", {}).get("full_name") == REPOSITORY,
            "Release belongs to another repository")
    require(release.get("path") == ".github/workflows/release.yml" and
            release.get("head_branch") == "master" and
            release.get("event") in {"push", "workflow_dispatch"},
            "Recovery requires the original master release workflow")
    require(release.get("status") == "completed" and gate.full_sha(release.get("head_sha")),
            "The original release must have completed with an exact candidate")
    return release["head_sha"]


def required_job(jobs, name):
    matches = [job for job in jobs if job.get("name") == name]
    require(len(matches) == 1 and matches[0].get("conclusion") == "success",
            f"Original release prerequisite did not succeed: {name}")
    return matches[0]


def plan_from_log(log, candidate):
    # Old releases kept the authenticated plan in their job log, not an artifact.
    # Only decode complete, uncoloured JSON blocks; never print the raw log.
    lines = [re.sub(r"^\d{4}-\d\d-\d\dT\S+ ", "", line) for line in log.splitlines()]
    plans = []
    for index, line in enumerate(lines):
        if line != "{":
            continue
        try:
            value, _ = json.JSONDecoder().raw_decode("\n".join(lines[index:]))
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and "mobile_native_build" in value:
            plans.append(value)
    require(len(plans) == 1, "Expected one unambiguous original release plan")
    plan = plans[0]
    require(plan.get("to") == candidate and gate.full_sha(plan.get("from")) and
            plan["from"] != candidate and plan.get("mobile_native_build") == "yes",
            "The original plan did not owe a native build for this candidate")
    return plan


def validate_identity(candidate, baseline, evidence, deployed, daemon_tree, expected_tree):
    gate.validate_aggregate(evidence, candidate, baseline)
    require(deployed == candidate and daemon_tree == expected_tree,
            "Production no longer serves the fully deployed original candidate")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_run")
    args = parser.parse_args()
    require(re.fullmatch(r"[1-9][0-9]{0,19}", args.release_run), "Invalid release run ID")
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and
            os.environ.get("GITHUB_REF") == "refs/heads/master" and
            os.environ.get("GITHUB_ACTIONS") == "true",
            "Recovery only runs in the protected master workflow")
    release = api(f"actions/runs/{args.release_run}")
    candidate = validate_run(release)
    attempt = release["run_attempt"]
    jobs = api(f"actions/runs/{args.release_run}/attempts/{attempt}/jobs?per_page=100")
    require(jobs["total_count"] <= 100, "Unexpected release job count")
    plan_job = required_job(jobs["jobs"], "what does this owe")
    for name in (
        "validate native connections and isolated canaries / complete release acceptance",
        "require exact master push test results",
        "server, web, daemon manifest and the phone",
    ):
        required_job(jobs["jobs"], name)
    log = read_plan_log(plan_job["id"])
    plan = plan_from_log(log, candidate)
    run("git", "merge-base", "--is-ancestor", candidate, "HEAD")
    with tempfile.TemporaryDirectory() as directory:
        run("gh", "run", "download", args.release_run, "--repo", REPOSITORY,
            "--name", "release-acceptance", "--dir", directory)
        evidence = gate.read_json(Path(directory) / "acceptance.json")
        deployed, daemon_tree = gate.production_identity("https://spawnd.dev")
        expected_tree = run("git", "rev-parse", f"{candidate}:daemon").strip()
        validate_identity(candidate, plan["from"], evidence, deployed, daemon_tree, expected_tree)
    # Recheck exact-source CI instead of trusting only a completed waiting job.
    gate.wait_ci(REPOSITORY, candidate,
                 windows=gate.requires_windows(candidate, plan["from"]), timeout=30)
    report = {"candidate": candidate, "baseline": plan["from"], "release_run": args.release_run}
    print(json.dumps(report))
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"candidate={candidate}\n")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        # CLI stderr may include private service details; fixed failures suffice.
        raise SystemExit(str(error) if isinstance(error, ValueError)
                         else "Recovery prerequisite command failed; no store operation allowed")
