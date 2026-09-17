#!/usr/bin/env python3
"""Verify commit-bound native/canary evidence before release promotion."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r"[0-9a-f]{40}\Z")
NATIVE_CASES = {
    "shared_transport",
    "background_short",
    "background_retire",
    "process_restart",
    "relay_udp_outage",
    "relay_udp_loss",
    "upload_interruption",
    "identity_retirement",
}
CANARY_CASES = {
    "baseline_holdback",
    "candidate_soak",
    "update_recovery",
    "startup_rollback",
}


def git(*arguments: str) -> str:
    return subprocess.check_output(
        ["git", *arguments], cwd=ROOT, text=True, stderr=subprocess.PIPE
    ).strip()


def ensure_baseline_commit(commit: str) -> None:
    if not full_sha(commit):
        raise ValueError("baseline must be a full commit ID")
    try:
        git("cat-file", "-e", f"{commit}^{{commit}}")
    except subprocess.CalledProcessError:
        # A history rewrite leaves production on its original content identity.
        # Fetch that exact object without restoring any old branch or tag.
        git("fetch", "--no-tags", "origin", commit)
        git("cat-file", "-e", f"{commit}^{{commit}}")


def full_sha(value: Any) -> bool:
    return isinstance(value, str) and SHA.fullmatch(value) is not None


def read_json(path: Path) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("acceptance evidence is absent or exceeds 8 MiB")
    return json.loads(path.read_text(), object_pairs_hook=pairs)


def observation_window(report: dict[str, Any]) -> None:
    dates = []
    for key in ("started_at", "completed_at"):
        value = report.get(key)
        if not isinstance(value, str):
            raise ValueError("acceptance evidence has no completed observation window")
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None:
            raise ValueError(
                "acceptance observation timestamps must include a timezone"
            )
        dates.append(date)
    if dates[1] < dates[0] or dates[1].timestamp() > time.time() + 300:
        raise ValueError("acceptance observation window is reversed or in the future")


def deployed_baseline(origin: str) -> str:
    if origin != "https://spawnd.dev":
        raise ValueError(
            "release baseline must come from the configured production origin"
        )
    with urllib.request.urlopen(origin + "/api/release", timeout=20) as response:
        release = json.load(response)
    if (
        not isinstance(release, dict)
        or not isinstance(release.get("server"), dict)
        or not isinstance(release.get("daemon"), dict)
    ):
        raise ValueError("production release must identify both server and daemon")
    commit = release.get("server", {}).get("commit")
    if not full_sha(commit):
        raise ValueError("production did not provide a complete server commit")
    if release.get("server", {}).get("dirty") is not False:
        raise ValueError("production reports a dirty server identity")
    ensure_baseline_commit(commit)
    tree = git("rev-parse", f"{commit}:daemon")
    if release.get("daemon", {}).get("tree") != tree:
        raise ValueError(
            "production daemon source differs from the proposed compatibility baseline"
        )
    return commit


def validate_report(report: dict[str, Any], candidate: str, baseline: str) -> str:
    if (
        not isinstance(report, dict)
        or type(report.get("schema_version")) is not int
        or report["schema_version"] != 1
    ):
        raise ValueError("unsupported acceptance evidence schema")
    if report.get("candidate_commit") != candidate:
        raise ValueError("acceptance evidence belongs to a different candidate")
    if report.get("baseline_commit") != baseline:
        raise ValueError("acceptance evidence belongs to a different deployed baseline")
    if report.get("status") != "passed":
        raise ValueError("acceptance evidence is incomplete or failed")
    kind = report.get("evidence_kind")
    if kind == "isolated_canary":
        if report.get("cleanup_complete") is not True:
            raise ValueError("canary acceptance did not finish fixture cleanup")
        if report.get("baseline_commit") != baseline:
            raise ValueError("canary evidence belongs to a different deployed baseline")
        required, name = CANARY_CASES, "canary"
    elif kind in ("native_simulator", "native_emulator"):
        if report.get("cleanup_passed") is not True:
            raise ValueError("native acceptance did not finish fixture cleanup")
        if report.get("source_clean") is not True:
            raise ValueError(
                "native acceptance did not exercise clean committed source"
            )
        platform = report.get("platform")
        if (kind, platform) not in (
            ("native_simulator", "ios"),
            ("native_emulator", "android"),
        ):
            raise ValueError("native runtime/platform evidence does not agree")
        required, name = NATIVE_CASES, platform
    else:
        raise ValueError(
            "unit tests, bundling and unknown runtimes are not native/canary evidence"
        )
    cases = report.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("acceptance report has no measured cases")
    ids = [case.get("id") for case in cases if isinstance(case, dict)]
    if (
        len(ids) != len(cases)
        or not all(isinstance(item, str) for item in ids)
        or len(set(ids)) != len(ids)
        or set(ids) != required
    ):
        raise ValueError("acceptance report has missing or duplicate required cases")
    if any(case.get("status") != "passed" for case in cases):
        raise ValueError("failed/skipped acceptance case blocks promotion")
    if kind == "isolated_canary":
        for case in cases:
            metrics = case.get("metrics", {})
            if not isinstance(metrics, dict):
                raise ValueError("canary metrics must be measured numbers")
            duration, samples = metrics.get("soak_seconds"), metrics.get("samples")
            if (
                type(duration) not in (int, float)
                or not 60 <= duration <= 7200
                or not math.isfinite(duration)
            ):
                raise ValueError(
                    "canary observation is shorter than the required 60 seconds"
                )
            if not isinstance(samples, int) or isinstance(samples, bool) or samples < 2:
                raise ValueError("canary case has no repeated observations")
    if report.get("physical_device") is not False:
        raise ValueError(
            "these automated suites must identify their physical-device limitation"
        )
    observation_window(report)
    return name


def summary(report: dict[str, Any]) -> dict[str, Any]:
    # The promotion artifact carries only the validated contract. Raw logs,
    # bootstrap tokens, credentials, snapshots and arbitrary extra fields never
    # get copied from a fixture report into a production job.
    result = {
        key: report[key]
        for key in (
            "schema_version",
            "candidate_commit",
            "baseline_commit",
            "status",
            "evidence_kind",
            "physical_device",
            "started_at",
            "completed_at",
        )
    }
    if report["evidence_kind"] != "isolated_canary":
        result["platform"] = report["platform"]
        result["source_clean"] = report["source_clean"]
        result["cleanup_passed"] = report["cleanup_passed"]
    else:
        result["cleanup_complete"] = report["cleanup_complete"]
    result["cases"] = []
    for case in report["cases"]:
        row = {"id": case["id"], "status": case["status"]}
        if report["evidence_kind"] == "isolated_canary":
            row["metrics"] = {
                key: case["metrics"][key] for key in ("soak_seconds", "samples")
            }
        result["cases"].append(row)
    return result


def validate_aggregate(report: Any, candidate: str, baseline: str) -> dict[str, Any]:
    if not full_sha(candidate) or not full_sha(baseline) or candidate == baseline:
        raise ValueError("candidate and baseline must be distinct full commit IDs")
    if (
        not isinstance(report, dict)
        or type(report.get("schema_version")) is not int
        or report["schema_version"] != 1
    ):
        raise ValueError("unsupported acceptance aggregate schema")
    if (
        report.get("status") != "passed"
        or report.get("candidate_commit") != candidate
        or report.get("baseline_commit") != baseline
    ):
        raise ValueError(
            "acceptance aggregate failed or belongs to a different candidate/baseline"
        )
    reports = report.get("reports")
    if not isinstance(reports, dict) or set(reports) != {"ios", "android", "canary"}:
        raise ValueError(
            "acceptance aggregate requires exactly iOS, Android and canary reports"
        )
    for name, item in reports.items():
        if validate_report(item, candidate, baseline) != name:
            raise ValueError("acceptance report label does not match its runtime")
    return report


def verify(directory: Path, candidate: str, baseline: str) -> dict[str, Any]:
    if not full_sha(candidate) or not full_sha(baseline) or candidate == baseline:
        raise ValueError("candidate and baseline must be distinct full commit IDs")
    reports: dict[str, dict[str, Any]] = {}
    for path in sorted(directory.glob("**/evidence.json")):
        report = read_json(path)
        name = validate_report(report, candidate, baseline)
        if name in reports:
            raise ValueError(f"duplicate {name} evidence")
        reports[name] = summary(report)
        reports[name]["source_report_sha256"] = hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
    missing = {"ios", "android", "canary"} - reports.keys()
    if missing:
        raise ValueError(
            f"required acceptance reports absent: {', '.join(sorted(missing))}"
        )
    return {
        "schema_version": 1,
        "candidate_commit": candidate,
        "baseline_commit": baseline,
        "status": "passed",
        "verified_at": datetime.now(UTC).isoformat(),
        "reports": reports,
        "limitations": [
            "No physical device or real Wi-Fi/cellular handover was tested.",
            "Canary hosts are isolated fixtures, not production customer devices.",
        ],
    }


def requires_windows(candidate: str, baseline: str) -> bool:
    if not full_sha(candidate) or not full_sha(baseline):
        raise ValueError("Windows comparison needs full commit IDs")
    return bool(
        git(
            "diff",
            "--name-only",
            baseline,
            candidate,
            "--",
            "daemon",
            "desktop",
            ".github/workflows/windows.yml",
        )
    )


def wait_ci(repository: str, candidate: str, *, windows: bool, timeout: int) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("invalid GitHub repository")
    workflows = ["test.yml"] + (["windows.yml"] if windows else [])
    deadline = time.monotonic() + timeout
    while True:
        pending = []
        for workflow in workflows:
            endpoint = (
                f"repos/{repository}/actions/workflows/{workflow}/runs"
                f"?head_sha={candidate}&event=push&per_page=30"
            )
            data = json.loads(
                subprocess.check_output(["gh", "api", endpoint], text=True)
            )
            runs = [
                run
                for run in data["workflow_runs"]
                if run.get("head_sha") == candidate
                and run.get("event") == "push"
                and run.get("head_branch") == "master"
                and run.get("head_repository", {}).get("full_name") == repository
            ]
            runs.sort(
                key=lambda run: (run["run_number"], run.get("run_attempt", 1)),
                reverse=True,
            )
            if not runs or runs[0]["status"] != "completed":
                pending.append(workflow)
            elif runs[0]["conclusion"] != "success":
                raise ValueError(
                    f"{workflow} did not pass at {candidate}: {runs[0]['html_url']}"
                )
        if not pending:
            return
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"required CI is missing or incomplete: {', '.join(pending)}"
            )
        print(
            f"acceptance: waiting for {', '.join(pending)} at {candidate[:12]}",
            flush=True,
        )
        time.sleep(min(45, max(0, deadline - time.monotonic())))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resolve-baseline", action="store_true")
    parser.add_argument("--origin", default="https://spawnd.dev")
    parser.add_argument("--directory", type=Path)
    parser.add_argument(
        "--evidence",
        type=Path,
        help="revalidate a downloaded acceptance.json aggregate",
    )
    parser.add_argument("--candidate")
    parser.add_argument("--baseline")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--wait-ci", metavar="OWNER/REPO")
    parser.add_argument("--require-windows", action="store_true")
    parser.add_argument(
        "--requires-windows",
        action="store_true",
        help="print whether baseline/candidate changes need Windows CI",
    )
    parser.add_argument("--timeout", type=int, default=5400)
    args = parser.parse_args()
    try:
        if args.resolve_baseline:
            print(deployed_baseline(args.origin))
            return
        if not args.candidate or not SHA.fullmatch(args.candidate):
            parser.error("--candidate must be a full commit ID")
        if args.requires_windows:
            print(str(requires_windows(args.candidate, args.baseline)).lower())
            return
        if args.directory and args.evidence:
            parser.error("choose --directory or --evidence")
        if args.wait_ci:
            if not 0 <= args.timeout <= 10800:
                parser.error("invalid CI wait timeout")
            wait_ci(
                args.wait_ci,
                args.candidate,
                windows=args.require_windows,
                timeout=args.timeout,
            )
        if args.directory or args.evidence:
            baseline = args.baseline or deployed_baseline(args.origin)
            report = (
                verify(args.directory, args.candidate, baseline)
                if args.directory
                else validate_aggregate(
                    read_json(args.evidence), args.candidate, baseline
                )
            )
            if args.output:
                args.output.write_text(json.dumps(report, indent=2) + "\n")
            print(
                f"acceptance: iOS, Android and isolated canary passed for {args.candidate}"
            )
        elif not args.wait_ci:
            parser.error("--directory, --evidence or --wait-ci is required")
    except (
        ValueError,
        KeyError,
        OSError,
        TimeoutError,
        subprocess.CalledProcessError,
    ) as error:
        print(f"acceptance: REFUSED: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
