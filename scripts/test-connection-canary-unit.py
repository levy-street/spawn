#!/usr/bin/env python3
"""Protocol and fail-closed evidence regressions for the isolated canary."""

import copy
import importlib.util
import json
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("canary", Path(__file__).with_name("connection-canary.py"))
canary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canary)


def passed_report():
    identity = {"instance_id": "fixture-worker", "session_id": "fixture-session", "pid": 123}
    checkpoint = {"identity": identity, "samples_ms": [1.0] * 32}
    report = {
        "schema_version": 1, "suite": "connection_canary", "evidence_kind": "isolated_canary",
        "physical_device": False, "candidate_commit": "a" * 40, "baseline_commit": "b" * 40,
        "cleanup_complete": True,
        "artifacts": {name: {"commit": ("a" if name == "candidate" else "b") * 40,
                             "source_tree": "a" * 40, "daemon_source_tree": "b" * 40,
                             "spawnd_sha256": "1" * 64, "worker_sha256": "2" * 64}
                      for name in ("baseline", "candidate")},
        "cases": [{"id": name, "status": "passed",
                   "checks": dict.fromkeys(canary.COMMON_CHECKS | checks, True),
                   "metrics": {"monitor": {"soak_seconds": 60.1, "observed_advances": 240,
                                           "pty_pid": 123},
                               "worker_adoptions": canary.MIN_ADOPTIONS[name],
                               "ipc_before": copy.deepcopy(checkpoint),
                               "ipc_after": copy.deepcopy(checkpoint),
                               **{name + "_registration": {"host_id": "fixture-host", "before_count": 1, "after_count": 2}
                                  for name in ("ipc_before", "ipc_after", "server_recovery", "daemon_recovery")},
                               "recovery": {"server_restart_ms": 3000, "daemon_restart_ms": 500},
                               "rollback": {"no_retry_observation_ms": 65000}}}
                  for name, checks in canary.CASES.items()],
    }
    return report


class EvidenceTests(unittest.TestCase):
    def test_complete_measurements_pass_and_compute_comparison(self):
        report = passed_report()
        canary.validate(report)
        self.assertEqual(report["metrics"]["candidate_p95_limit_ms"], 250)

    def test_missing_or_duplicate_case_fails(self):
        for replacement in ([], [copy.deepcopy(passed_report()["cases"][0])] * 4):
            report = passed_report()
            report["cases"] = replacement
            with self.assertRaises(ValueError):
                canary.validate(report)

    def test_skipped_failed_pending_cases_never_pass(self):
        for status in ("skipped", "failed", "pending", "running"):
            report = passed_report()
            report["cases"][0]["status"] = status
            with self.assertRaises(ValueError):
                canary.validate(report)

    def test_missing_check_or_cleanup_fails(self):
        for check in canary.COMMON_CHECKS | canary.CASES["baseline_holdback"]:
            report = passed_report()
            del report["cases"][0]["checks"][check]
            with self.assertRaises(ValueError):
                canary.validate(report)
        report = passed_report()
        report["cleanup_complete"] = False
        with self.assertRaises(ValueError):
            canary.validate(report)

    def test_short_unobserved_or_mismatched_soak_fails(self):
        for field, value in (("soak_seconds", 59.9), ("soak_seconds", float("nan")),
                             ("observed_advances", 0), ("pty_pid", 456)):
            report = passed_report()
            report["cases"][0]["metrics"]["monitor"][field] = value
            with self.assertRaises(ValueError):
                canary.validate(report)

    def test_missing_invalid_and_timeout_samples_fail(self):
        for samples in ([], [1] * 15, [True] * 32, [float("nan")] * 32, [-1] * 32, [5000] * 32):
            report = passed_report()
            report["cases"][0]["metrics"]["ipc_after"]["samples_ms"] = samples
            with self.assertRaises(ValueError):
                canary.validate(report)

    def test_replaced_worker_identity_fails(self):
        report = passed_report()
        report["cases"][0]["metrics"]["ipc_after"]["identity"]["instance_id"] = "replacement"
        with self.assertRaises(ValueError):
            canary.validate(report)

    def test_candidate_latency_regression_fails(self):
        report = passed_report()
        report["cases"][1]["metrics"]["ipc_after"]["samples_ms"] = [251] * 32
        with self.assertRaises(ValueError):
            canary.validate(report)

    def test_over_budget_recovery_and_short_retry_observation_fail(self):
        report = passed_report()
        report["cases"][2]["metrics"]["recovery"]["server_restart_ms"] = 60001
        with self.assertRaises(ValueError):
            canary.validate(report)
        report = passed_report()
        report["cases"][3]["metrics"]["rollback"]["no_retry_observation_ms"] = 59999
        with self.assertRaises(ValueError):
            canary.validate(report)

    def test_artifact_commit_mismatch_fails(self):
        report = passed_report()
        report["artifacts"]["candidate"]["commit"] = "c" * 40
        with self.assertRaises(ValueError):
            canary.validate(report)

    def test_cached_online_status_cannot_replace_fresh_registration(self):
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "daemon.log"
            path.write_text("registered with server host_id=fixture-host\n")
            self.assertEqual(canary.registration_count(path, "fixture-host"), 1)
            with self.assertRaises(TimeoutError):
                canary.wait_registration(path, "fixture-host", 1, .1)
            with path.open("a") as log:
                log.write("registered with server host_id=another-host\n")
            self.assertEqual(canary.registration_count(path, "fixture-host"), 1)
            def reconnect():
                time.sleep(.06)
                with path.open("a") as log:
                    log.write("registered with server host_id=fixture-host\n")
            thread = threading.Thread(target=reconnect)
            thread.start()
            witness = canary.wait_registration(path, "fixture-host", 1, 1)
            thread.join()
            self.assertEqual(witness["after_count"], 2)
        report = passed_report()
        report["cases"][2]["metrics"]["server_recovery_registration"]["after_count"] = 1
        with self.assertRaises(ValueError):
            canary.validate(report)

    def test_harness_changed_during_observation_fails(self):
        report = passed_report()
        with tempfile.TemporaryDirectory() as scratch:
            paths = [Path(scratch) / name for name in ("connection-canary.py", "test-connection-canary.sh")]
            for path in paths:
                path.write_text("original fixture")
            report["artifacts"]["harness"] = {path.name: canary.sha256(path) for path in paths}
            canary.verify_harness(report, scratch)
            paths[0].write_text("changed fixture")
            with self.assertRaises(ValueError):
                canary.verify_harness(report, scratch)

    def test_persisted_running_status_without_adoption_is_insufficient(self):
        report = passed_report()
        with tempfile.TemporaryDirectory() as scratch:
            for case in report["cases"]:
                path = Path(scratch) / (case["id"] + "-daemon.log")
                path.write_text("session_id=fixture-session server status=running\n")
            with self.assertRaises(ValueError):
                canary.verify_adoption_logs(report, scratch)
            for case in report["cases"]:
                path = Path(scratch) / (case["id"] + "-daemon.log")
                path.write_text(("adopting session worker session_id=fixture-session state=running pid=Some(123)\n"
                                 "rediscovered worker-backed session session_id=fixture-session\n")
                                * canary.MIN_ADOPTIONS[case["id"]])
            canary.verify_adoption_logs(report, scratch)
            canary.validate(report)
            path.write_text(path.read_text().replace("Some(123)", "Some(456)"))
            with self.assertRaises(ValueError):
                canary.verify_adoption_logs(report, scratch)


class ProtocolTests(unittest.TestCase):
    def test_partial_header_and_payload_are_reassembled(self):
        reader, writer = socket.socketpair()
        with reader, writer:
            frame = struct.pack("<IB", 3, 4) + b"abc"
            def fragmented():
                for byte in frame:
                    writer.sendall(bytes([byte]))
                    time.sleep(.001)
            thread = threading.Thread(target=fragmented)
            thread.start()
            self.assertEqual(canary.receive_frame(reader, time.monotonic() + 1), (4, b"abc"))
            thread.join()

    def test_oversized_header_rejected_before_payload_read(self):
        reader, writer = socket.socketpair()
        with reader, writer:
            writer.sendall(struct.pack("<IB", canary.MAX_FRAME + 1, 4))
            with self.assertRaises(ValueError):
                canary.receive_frame(reader, time.monotonic() + 1)

    def test_partial_frame_eof_is_failure(self):
        reader, writer = socket.socketpair()
        writer.sendall(b"\x01")
        writer.close()
        with reader, self.assertRaises(RuntimeError):
            canary.receive_frame(reader, time.monotonic() + 1)

    def test_partial_progress_does_not_extend_absolute_deadline(self):
        reader, writer = socket.socketpair()
        with reader, writer:
            def dribble():
                for byte in struct.pack("<IB", 1, 4) + b"x":
                    writer.sendall(bytes([byte]))
                    time.sleep(.03)
            thread = threading.Thread(target=dribble)
            thread.start()
            with self.assertRaises(TimeoutError):
                canary.receive_frame(reader, time.monotonic() + .08)
            thread.join()

    def test_checkpoint_requires_shell_response_not_terminal_echo(self):
        for shell_response in (True, False):
            with self.subTest(shell_response=shell_response), tempfile.TemporaryDirectory(dir="/tmp") as scratch:
                endpoint = str(Path(scratch) / "w.sock")
                output = str(Path(scratch) / "result.json")
                listener = socket.socket(socket.AF_UNIX)
                listener.bind(endpoint)
                listener.listen()
                def serve():
                    with listener, listener.accept()[0] as peer:
                        hello = json.dumps({"session_id": "session", "instance_id": "instance",
                                            "state": "running", "pid": 1}).encode()
                        peer.sendall(struct.pack("<IB", len(hello), 1) + hello)
                        for _ in range(16):
                            kind, data = canary.receive_frame(peer, time.monotonic() + 1)
                            self.assertEqual(kind, 5)
                            response = b"\0" * 8 + (b"canary-response:" if shell_response else b"") + data
                            peer.sendall(struct.pack("<IB", len(response), 4) + response)
                            if not shell_response:
                                return
                thread = threading.Thread(target=serve)
                thread.start()
                args = SimpleNamespace(socket=endpoint, session="session", output=output,
                                       expected=None, samples=16, timeout=.5)
                if shell_response:
                    canary.ipc_checkpoint(args)
                    self.assertEqual(canary.load(output)["sample_count"], 16)
                else:
                    with self.assertRaises(RuntimeError):
                        canary.ipc_checkpoint(args)
                    self.assertFalse(Path(output).exists())
                thread.join()


if __name__ == "__main__":
    unittest.main()
