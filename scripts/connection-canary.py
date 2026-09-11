#!/usr/bin/env python3
"""Local canary measurement/evidence primitives; no external service access."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import socket
import struct
import sys
import threading
import time
import uuid


CASES = {
    "baseline_holdback": {"held_back"},
    "candidate_soak": {"candidate_running"},
    "update_recovery": {
        "update_applied", "same_daemon_pid", "previous_release_preserved",
        "probation_cleared", "server_restart_recovered", "daemon_restart_recovered",
    },
    "startup_rollback": {
        "probation_observed", "rollback_applied", "no_retry_loop", "probation_cleared",
    },
}
COMMON_CHECKS = {
    "worker_alive", "identity_preserved", "session_running", "selected_pair",
    "daemon_readopted", "adoption_log_verified", "cleanup_complete",
}
MIN_ADOPTIONS = {"baseline_holdback": 2, "candidate_soak": 2,
                 "update_recovery": 4, "startup_rollback": 3}
MAX_FRAME = 1024 * 1024  # This fixture never requests replay/history.


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def load(path):
    return json.loads(Path(path).read_text())


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def receive_exact(connection, length, deadline):
    result = bytearray()
    while len(result) < length:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("worker IPC absolute response deadline exceeded")
        connection.settimeout(remaining)
        chunk = connection.recv(length - len(result))
        if not chunk:
            raise RuntimeError("worker IPC closed before a complete frame")
        result.extend(chunk)
    return bytes(result)


def receive_frame(connection, deadline):
    length, kind = struct.unpack("<IB", receive_exact(connection, 5, deadline))
    if length > MAX_FRAME:
        raise ValueError(f"worker frame exceeds fixture limit: {length}")
    return kind, receive_exact(connection, length, deadline)


def percentile(samples, fraction):
    ordered = sorted(samples)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def ipc_checkpoint(args):
    """The caller must stop its fixture daemon first: IPC has one supervisor."""
    samples = []
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(args.timeout)
        connection.connect(args.socket)
        kind, payload = receive_frame(connection, time.monotonic() + args.timeout)
        if kind != 1:
            raise ValueError("worker did not send Hello")
        hello = json.loads(payload)
        if (hello.get("session_id", hello.get("agent_id")) != args.session
                or hello.get("state") != "running" or not hello.get("pid")
                or not hello.get("instance_id")):
            raise ValueError("worker Hello does not identify the running fixture session")
        identity = {key: hello[key] for key in ("instance_id", "pid")}
        identity["session_id"] = args.session
        if args.expected and identity != load(args.expected)["identity"]:
            raise ValueError("worker instance/PTY/session changed across recovery")
        for _ in range(args.samples):
            token = uuid.uuid4().hex
            request = (token + "\n").encode()
            # A terminal's input echo cannot satisfy this prefixed response.
            expected = ("canary-response:" + token).encode()
            started = time.monotonic()
            connection.sendall(struct.pack("<IB", len(request), 5) + request)
            buffered = b""
            while expected not in buffered:
                kind, payload = receive_frame(connection, started + args.timeout)
                if kind in (10, 12):
                    raise RuntimeError(f"worker exit/error during checkpoint (frame {kind})")
                if kind == 4:
                    if len(payload) < 8:
                        raise ValueError("worker output is missing its source watermark")
                    buffered = (buffered + payload[8:])[-65536:]
            samples.append((time.monotonic() - started) * 1000)
            time.sleep(0.02)
    write_json(args.output, {
        "transport": "worker_ipc", "daemon_stopped_for_checkpoint": True,
        "identity": identity, "samples_ms": samples, "sample_count": len(samples),
        "p50_ms": percentile(samples, .5), "p95_ms": percentile(samples, .95),
        "maximum_ms": max(samples), "absolute_timeout_seconds": args.timeout,
    })


def pty_shell():
    """Synthetic session command; heartbeat and responses are real PTY output."""
    heartbeat = Path(".canary-heartbeat.json")
    started = time.monotonic_ns()
    output_lock = threading.Lock()

    def beat():
        sequence = 0
        while True:
            sequence += 1
            # Write to the PTY before publishing the checkpoint: a stopped or
            # backpressured PTY must not appear healthy just from file writes.
            with output_lock:
                print(f"canary-heartbeat:{sequence}", flush=True)
            write_json(heartbeat, {
                "sequence": sequence, "pid": os.getpid(), "started_ns": started,
                "updated_ns": time.monotonic_ns(),
            })
            time.sleep(.25)

    threading.Thread(target=beat, daemon=True).start()
    for line in sys.stdin:
        with output_lock:
            print("canary-response:" + line.rstrip("\r\n"), flush=True)


def monitor(args):
    started = time.monotonic()
    first = previous = load(args.heartbeat)
    inode = os.stat(args.socket).st_ino
    observations = advances = 0
    maximum_gap = 0.0
    last_advance = started
    while True:
        current_time = time.monotonic()
        elapsed = current_time - started
        if elapsed > args.seconds + 180:
            raise TimeoutError("canary actions did not finish within the bounded soak")
        os.kill(args.worker_pid, 0)
        if os.stat(args.socket).st_ino != inode:
            raise ValueError("worker socket was replaced during soak")
        current = load(args.heartbeat)
        if any(current[key] != first[key] for key in ("pid", "started_ns")):
            raise ValueError("PTY heartbeat process changed during soak")
        if current["sequence"] < previous["sequence"]:
            raise ValueError("PTY heartbeat regressed")
        if current["sequence"] > previous["sequence"]:
            advances += 1
            maximum_gap = max(maximum_gap, current_time - last_advance)
            last_advance = current_time
        if current_time - last_advance > 5:
            raise TimeoutError("PTY heartbeat stalled for more than five seconds")
        previous = current
        observations += 1
        if elapsed >= args.seconds and Path(args.stop_file).exists():
            break
        time.sleep(.25)
    if advances < args.seconds:
        raise ValueError("not enough independently observed heartbeat advances")
    write_json(args.output, {
        "transport": "pty_heartbeat", "soak_seconds": elapsed,
        "observations": observations, "observed_advances": advances,
        "heartbeat_advance": previous["sequence"] - first["sequence"],
        "maximum_observed_gap_seconds": maximum_gap, "worker_pid": args.worker_pid,
        "socket_inode": inode, "pty_pid": first["pid"],
    })


def verify_adoption_logs(report, artifact_directory):
    """A persisted server 'running' row alone does not prove worker adoption."""
    for case in report["cases"]:
        identity = case["metrics"]["ipc_before"]["identity"]
        session_marker = "session_id=" + identity["session_id"]
        log_path = Path(artifact_directory) / (case["id"] + "-daemon.log")
        lines = [line for line in log_path.read_text().splitlines() if session_marker in line]
        completed = sum("rediscovered worker-backed session" in line for line in lines)
        accepted = [line for line in lines if "adopting session worker" in line]
        expected_pid = f"pid=Some({identity['pid']})"
        if (completed < MIN_ADOPTIONS[case["id"]] or len(accepted) < completed
                or any("state=running" not in line or not re.search(
                    re.escape(expected_pid) + r"(?:\s|$)", line) for line in accepted)):
            raise ValueError(f"successful adoption of the original worker was not observed: {case['id']}")
        case["checks"]["adoption_log_verified"] = True
        case["metrics"]["worker_adoptions"] = completed
        case["artifacts"] = {"daemon_log_sha256": sha256(log_path)}


def verify_harness(report, directory):
    expected = report["artifacts"]["harness"]
    for name in ("connection-canary.py", "test-connection-canary.sh"):
        if sha256(Path(directory) / name) != expected[name]:
            raise ValueError("canary harness changed during observation")


def registration_count(path, host):
    return sum("registered with server" in line and f"host_id={host}" in line
               for line in Path(path).read_text().splitlines())


def wait_registration(path, host, previous, timeout):
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        count = registration_count(path, host)
        if count > previous:
            return {"host_id": host, "before_count": previous, "after_count": count,
                    "wait_ms": (time.monotonic() - started) * 1000}
        time.sleep(.05)
    raise TimeoutError("no fresh daemon registration for the fixture host")


def validate(report):
    if report.get("schema_version") != 1 or report.get("suite") != "connection_canary":
        raise ValueError("wrong canary evidence schema")
    if (report.get("evidence_kind") != "isolated_canary"
            or report.get("physical_device") is not False):
        raise ValueError("canary evidence must identify its isolated scope")
    for key in ("candidate_commit", "baseline_commit"):
        if len(report.get(key, "")) != 40 or any(c not in "0123456789abcdef" for c in report[key]):
            raise ValueError(f"missing exact {key}")
    cases = report.get("cases", [])
    if len(cases) != len(CASES) or {case["id"] for case in cases} != set(CASES):
        raise ValueError("missing or duplicate required canary case")
    for case in cases:
        if case["status"] != "passed":
            raise ValueError(f"required case did not pass: {case['id']}")
        required = COMMON_CHECKS | CASES[case["id"]]
        if any(case.get("checks", {}).get(check) is not True for check in required):
            raise ValueError(f"missing/failed required checks: {case['id']}")
        metrics = case["metrics"]
        duration = metrics["monitor"]["soak_seconds"]
        if (not finite_number(duration) or not 60 <= duration <= 7200
                or metrics["monitor"]["observed_advances"] < 60):
            raise ValueError(f"soak too short: {case['id']}")
        for phase in ("ipc_before", "ipc_after"):
            checkpoint = metrics[phase]
            samples = checkpoint["samples_ms"]
            if len(samples) < 16 or any(not finite_number(x) or x < 0 or x >= 5000 for x in samples):
                raise ValueError(f"missing/invalid/over-budget IPC samples: {case['id']}/{phase}")
            if checkpoint["identity"] != metrics["ipc_before"]["identity"]:
                raise ValueError(f"worker identity changed: {case['id']}")
        if metrics["monitor"]["pty_pid"] != metrics["ipc_before"]["identity"]["pid"]:
            raise ValueError("heartbeat and IPC observed different PTY processes")
        if metrics["worker_adoptions"] < MIN_ADOPTIONS[case["id"]]:
            raise ValueError("required daemon/worker adoption transitions were not observed")
        registrations = ["ipc_before_registration", "ipc_after_registration"]
        if case["id"] == "update_recovery":
            registrations += ["server_recovery_registration", "daemon_recovery_registration"]
        fixture_host = metrics["ipc_before_registration"]["host_id"]
        for name in registrations:
            witness = metrics[name]
            if (witness["host_id"] != fixture_host
                    or type(witness["before_count"]) is not int
                    or type(witness["after_count"]) is not int
                    or witness["after_count"] <= witness["before_count"]):
                raise ValueError("recovery/checkpoint lacks a fresh fixture daemon registration")
        if case["id"] == "update_recovery":
            for field in ("server_restart_ms", "daemon_restart_ms"):
                elapsed = metrics["recovery"][field]
                if not finite_number(elapsed) or not 0 <= elapsed <= 60000:
                    raise ValueError("fixture recovery exceeded the 60-second limit")
        if case["id"] == "startup_rollback":
            elapsed = metrics["rollback"]["no_retry_observation_ms"]
            if not finite_number(elapsed) or elapsed < 60000:
                raise ValueError("rollback retry observation did not cover two keepalive windows")
    if report.get("cleanup_complete") is not True:
        raise ValueError("fixture cleanup incomplete")
    artifacts = report.get("artifacts", {})
    for generation in ("baseline", "candidate"):
        artifact = artifacts[generation]
        if artifact["commit"] != report[generation + "_commit"]:
            raise ValueError("built artifact belongs to a different source commit")
        for key in ("source_tree", "daemon_source_tree"):
            if len(artifact[key]) != 40:
                raise ValueError("missing immutable source tree")
        for key in ("spawnd_sha256", "worker_sha256"):
            if len(artifact[key]) != 64:
                raise ValueError("missing built artifact hash")
    baseline = next(c for c in cases if c["id"] == "baseline_holdback")
    candidate = next(c for c in cases if c["id"] == "candidate_soak")
    old_samples = baseline["metrics"]["ipc_after"]["samples_ms"]
    new_samples = candidate["metrics"]["ipc_after"]["samples_ms"]
    old_p95, new_p95 = percentile(old_samples, .95), percentile(new_samples, .95)
    # Generous guard against severe regression; this is a local IPC check,
    # not a product/network latency SLO or a statistical benchmark.
    limit = max(250.0, old_p95 * 5)
    report["metrics"] = {
        "transport": "worker_ipc", "baseline_p95_ms": old_p95,
        "candidate_p95_ms": new_p95, "candidate_p95_limit_ms": limit,
        "comparison_rule": "candidate p95 <= max(250ms, baseline p95 * 5)",
        "sample_absolute_timeout_ms": 5000,
    }
    if new_p95 > limit:
        raise ValueError("candidate worker IPC latency exceeded the baseline regression guard")


def evidence(args):
    action, path, *values = args.values
    if action == "init":
        candidate, baseline, platform, seconds = values
        report = {
            "schema_version": 1, "suite": "connection_canary",
            "evidence_kind": "isolated_canary", "physical_device": False,
            "isolation": "loopback-disposable", "candidate_commit": candidate,
            "baseline_commit": baseline, "platform": platform,
            "started_at": now(), "status": "failed", "cleanup_complete": False,
            "requested_soak_seconds": int(seconds), "artifacts": {}, "metrics": {},
            "cases": [{"id": name, "status": "pending", "checks": {}, "metrics": {}}
                      for name in CASES],
        }
    else:
        report = load(path)
        if action in ("begin", "check", "metric", "end"):
            case = next(case for case in report["cases"] if case["id"] == values[0])
            if action == "begin":
                case.update(status="running", started_at=now())
            elif action == "check":
                case["checks"][values[1]] = True
            elif action == "metric":
                case["metrics"][values[1]] = load(values[2])
                if values[1] == "monitor":
                    case["metrics"]["soak_seconds"] = case["metrics"]["monitor"]["soak_seconds"]
                elif values[1] == "ipc_after":
                    case["metrics"]["samples"] = case["metrics"]["ipc_after"]["sample_count"]
            else:
                case.update(status="passed", completed_at=now())
        elif action == "artifact":
            report["artifacts"][values[0]] = load(values[1])
            if values[0] in ("candidate", "baseline"):
                artifact = report["artifacts"][values[0]]
                for field in ("source_tree", "daemon_source_tree", "mobile_source_tree"):
                    report[values[0] + "_" + field] = artifact[field]
        elif action == "finalize":
            status, cleanup = values
            report["cleanup_complete"] = cleanup == "0"
            report["completed_at"] = now()
            try:
                if status != "0":
                    raise ValueError(f"canary runner exited {status}")
                verify_harness(report, Path(__file__).resolve().parent)
                verify_adoption_logs(report, path + ".artifacts")
                validate(report)
                report["status"] = "passed"
            except (ValueError, KeyError, TypeError, OSError) as error:
                report["status"] = "failed"
                report["failure_reason"] = str(error)
                write_json(path, report)
                raise
        else:
            raise ValueError("unknown evidence action")
    write_json(path, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("shell")
    ipc = commands.add_parser("ipc")
    for field in ("socket", "session", "output"):
        ipc.add_argument("--" + field, required=True)
    ipc.add_argument("--expected")
    ipc.add_argument("--samples", type=int, default=32)
    ipc.add_argument("--timeout", type=float, default=5)
    watch = commands.add_parser("monitor")
    for field in ("heartbeat", "socket", "stop-file", "output"):
        watch.add_argument("--" + field, required=True)
    watch.add_argument("--worker-pid", type=int, required=True)
    watch.add_argument("--seconds", type=int, required=True)
    report = commands.add_parser("evidence")
    report.add_argument("values", nargs="+")
    registered = commands.add_parser("registrations")
    registered.add_argument("--log", required=True)
    registered.add_argument("--host", required=True)
    registered.add_argument("--after", type=int)
    registered.add_argument("--output")
    args = parser.parse_args()
    if args.command == "shell":
        pty_shell()
    elif args.command == "ipc":
        if not 16 <= args.samples <= 256 or not 0 < args.timeout <= 5:
            parser.error("IPC requires 16..256 samples and a timeout in (0, 5] seconds")
        ipc_checkpoint(args)
    elif args.command == "monitor":
        if not 60 <= args.seconds <= 3600:
            parser.error("soak must be between 60 and 3600 seconds")
        monitor(args)
    elif args.command == "registrations":
        if args.after is None:
            print(registration_count(args.log, args.host))
        else:
            if args.after < 0 or not args.output:
                parser.error("registration wait needs a nonnegative count and output path")
            write_json(args.output, wait_registration(args.log, args.host, args.after, 60))
    else:
        evidence(args)


if __name__ == "__main__":
    main()
