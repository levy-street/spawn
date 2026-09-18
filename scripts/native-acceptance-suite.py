"""Real native/WebRTC acceptance assertions driven by the disposable fixture."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import time
import uuid
from datetime import UTC, datetime
from typing import Any

NATIVE_BOOT_TIMEOUT_SECONDS = 180


def require(condition: Any, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def lifecycle_interval(before: dict, after: dict) -> tuple[float, float] | None:
    """Read actual callbacks retained by this app launch, not HTTP arrival order."""
    require(
        isinstance(before.get("launchId"), str)
        and before["launchId"] == after.get("launchId"),
        "backgrounding replaced the native app launch",
    )
    start = before.get("lifecycleSequence")
    end = after.get("lifecycleSequence")
    history = after.get("lifecycleTransitions")
    require(
        type(start) is int and type(end) is int and 0 <= start <= end,
        "native lifecycle sequence is absent or went backwards",
    )
    require(isinstance(history, list) and len(history) <= 64, "invalid lifecycle history")
    previous = None
    for item in history:
        require(
            isinstance(item, dict)
            and type(item.get("sequence")) is int
            and item["sequence"] > 0
            and isinstance(item.get("state"), str)
            and type(item.get("nativeDateMs")) in (int, float)
            and math.isfinite(item["nativeDateMs"]),
            "invalid native lifecycle observation",
        )
        require(
            previous is None or item["sequence"] == previous + 1,
            "native lifecycle observations have a gap",
        )
        previous = item["sequence"]
    require((previous or 0) == end, "native lifecycle history is incomplete")
    changed = [item for item in history if item["sequence"] > start]
    require(
        not changed or changed[0]["sequence"] == start + 1,
        "native lifecycle history overflowed during the case",
    )
    background = None
    for item in changed:
        if background is None and item["state"] == "background":
            background = item["nativeDateMs"]
        elif background is not None and item["state"] == "active":
            require(item["nativeDateMs"] > background, "native lifecycle time went backwards")
            return background, item["nativeDateMs"]
    return None


def native_revocation_body(fixture: Any, device_id: str) -> dict[str, str]:
    for event in reversed(fixture.events):
        details = event.get("details", {})
        values = details.get("values", {})
        if (
            event.get("type") == "identity"
            and details.get("candidate_commit") == fixture.candidate
            and values.get("deviceId") == device_id
        ):
            public_key = values.get("publicKey")
            require(
                isinstance(public_key, str) and len(public_key) == 43,
                "native revocation target lacks an observed public key",
            )
            return {
                "expected_public_key": public_key,
                "revoked_by_device_id": fixture.anchor["id"],
            }
    raise AssertionError("native revocation target identity was not observed")


async def eventually(predicate: Any, *, timeout: float = 45, message: str) -> Any:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = await predicate()
        if last:
            return last
        await asyncio.sleep(0.2)
    raise AssertionError(f"{message}; last={last!r}")


def data_packets(status: dict[str, Any], counter: str) -> int:
    # The proxy distinguishes TURN application-data envelopes from STUN
    # allocation/keepalive traffic. Handshake traffic alone cannot pass.
    total = 0
    for direction in ("c2s", "s2c"):
        counts = status["totals"][direction]
        if counter in {"data", "dropped_data"}:
            classes = counts.get("classes", {})
            total += sum(
                classes.get(name, {}).get(
                    "dropped" if counter == "dropped_data" else "forwarded", 0
                )
                for name in ("turn_channel_data", "turn_send", "turn_data")
            )
        else:
            total += counts["dropped"]["packets"]
    return total


async def exercise(fixture: Any) -> None:
    report: dict[str, Any] = {
        "schema_version": 1,
        "suite": "native_connections",
        "status": "running",
        "candidate_commit": fixture.candidate,
        "source_clean": fixture.source_clean,
        "baseline_commit": fixture.args.baseline,
        "physical_device": False,
        "started_at": datetime.now(UTC).isoformat(),
        "cases": [],
        "isolation": "loopback-disposable",
        "network": fixture.args.transport,
        "binaries": fixture.binary_identity,
    }
    evidence_path = fixture.output / "evidence.json"

    def save() -> None:
        if fixture.failed is not None:
            report.update(status="failed", failure_reason=fixture.failed)
        temporary = evidence_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(report, indent=2) + "\n")
        temporary.replace(evidence_path)

    async def case(name: str, action: Any) -> None:
        row: dict[str, Any] = {
            "id": name,
            "status": "running",
            "started_at": datetime.now(UTC).isoformat(),
        }
        report["cases"].append(row)
        started = time.monotonic()
        save()
        try:
            await fixture.health()
            row["metrics"] = await action() or {}
            fixture.raise_if_failed()
            row["status"] = "passed"
        except BaseException as error:
            row.update(status="failed", error=str(error))
            raise
        finally:
            row["elapsed_ms"] = (time.monotonic() - started) * 1000
            row["completed_at"] = datetime.now(UTC).isoformat()
            save()

    async def snapshot() -> dict[str, Any]:
        return await fixture.command("snapshot")

    async def ready(min_sample_ms: float = 0) -> dict[str, Any] | None:
        state = await snapshot()
        sessions = state.get("sessions", {})
        if not all(
            sessions.get(label, {}).get("state") == "ready" for label in ("a", "b")
        ):
            return None
        peer = state.get("peer") or {}
        if len(state.get("tools", [])) != 2 or any(
            item.get("state") != "ready" for item in state["tools"]
        ):
            return None
        if peer.get("sampledAtMs", 0) < min_sample_ms:
            return None
        if peer.get("livePeerCount") != 1 or state.get("peerAgeMs", 999999) > 5000:
            return None
        peers = [
            item
            for item in peer.get("peers", [])
            if item.get("connectionState") == "connected"
        ]
        if len(peers) != 1:
            return None
        selected = peers[0].get("selected") or {}
        if fixture.args.transport == "relay" and not (
            selected.get("localCandidateType") == "relay"
            and selected.get("protocol") == "udp"
        ):
            return None
        return state

    async def wait_ready(min_sample_ms: float = 0) -> dict[str, Any]:
        state = await eventually(
            lambda: ready(min_sample_ms),
            timeout=90,
            message="two sessions did not recover on one measured peer",
        )
        for tool in (0, 1):
            await fixture.command(
                "host-request", {"tool": tool, "operation": "fs.home", "payload": {}}
            )
        return state

    async def echo(label: str = "a") -> str:
        marker = f"acceptance-{uuid.uuid4()}"
        await fixture.command(
            "input", {"session": label, "text": marker + "\n", "takeControl": True}
        )

        async def observed() -> bool:
            path = fixture.cwd / label / "received.txt"
            return path.exists() and marker in path.read_text()

        await eventually(
            observed, message="native input never reached the session shell"
        )
        return marker

    def process_ids() -> dict[str, int]:
        values = {}
        for label in ("a", "b"):
            pid = int((fixture.cwd / label / "shell.pid").read_text())
            os.kill(pid, 0)
            values[label] = pid
        return values

    async def boot() -> dict[str, Any] | None:
        fixture.raise_if_failed()
        for event in reversed(fixture.events):
            details = event.get("details", {})
            values = details.get("values", {})
            if (
                event.get("type") == "native-command"
                and event.get("status") == "failed"
                and details.get("candidate_commit") == fixture.candidate
                and values.get("action") == "runner-error"
            ):
                reason = values.get("result", {}).get("error", "unknown setup error")
                raise RuntimeError(f"native runner failed: {reason}")
        return next(
            (
                event
                for event in reversed(fixture.events)
                if event.get("type") == "boot"
            ),
            None,
        )

    try:
        # The installed native runner starts provisioning once. Build time
        # precedes all live daemon/session work and contributes no evidence.
        async def provisioned() -> bool:
            await boot()  # Preserve a runner setup failure before /start.
            return fixture.status()["ready"]

        await eventually(
            provisioned,
            timeout=fixture.args.timeout,
            message="native fixture was never provisioned",
        )
        await fixture.health()
        event = await eventually(
            boot,
            timeout=min(fixture.args.timeout, NATIVE_BOOT_TIMEOUT_SECONDS),
            message="native app never booted",
        )
        metadata = event["details"]
        require(
            fixture.source_clean,
            "native acceptance requires committed candidate source",
        )
        require(
            metadata.get("source_clean") is True,
            "native app lacks committed-source provenance",
        )
        require(event.get("status") == "passed", "native app boot failed")
        require(
            all(item["candidate_match"] for item in fixture.binary_identity.values()),
            "native fixture daemon/worker were not built from the candidate commit",
        )
        require(
            metadata.get("values", {}).get("runId") == fixture.run_id,
            "native app reports a different fixture run",
        )
        expected_platform = (
            "android" if fixture.args.client_host == "10.0.2.2" else "ios"
        )
        expected_kind = (
            "native_emulator" if expected_platform == "android" else "native_simulator"
        )
        require(
            metadata.get("candidate_commit") == fixture.candidate,
            "native app candidate mismatch",
        )
        require(
            metadata.get("platform") == expected_platform,
            "native app platform mismatch",
        )
        require(
            metadata.get("schema_kind") == expected_kind,
            "native runtime was not identified",
        )
        report.update(
            evidence_kind=expected_kind,
            platform=expected_platform,
            os_version=metadata.get("os_version"),
            launch_id=metadata.get("launchId"),
        )
        require(
            fixture.args.transport == "relay",
            "direct-only smoke cannot pass UDP fault acceptance",
        )

        async def shared() -> dict[str, Any]:
            await fixture.command("mount", {"sessions": ["a", "b"], "tools": 2})
            first = await wait_ready()
            await echo("a")
            await echo("b")
            for tool in (0, 1):
                await fixture.command(
                    "host-request",
                    {"tool": tool, "operation": "fs.home", "payload": {}},
                )
            await fixture.command("mount", {"sessions": ["b"], "tools": 1})
            await echo("b")
            await fixture.command("mount", {"sessions": ["a", "b"], "tools": 2})
            second = await wait_ready()
            require(
                first["peer"]["workerId"] == second["peer"]["workerId"]
                and first["peer"]["createdPeerCount"]
                == second["peer"]["createdPeerCount"],
                "view detach/reopen created a replacement parent",
            )
            self_ids = process_ids()
            return {
                "shell_pids": self_ids,
                "live_peers": second["peer"]["livePeerCount"],
            }

        await case("shared_transport", shared)
        initial_pids = process_ids()

        async def background(milliseconds: int) -> dict[str, Any]:
            before = await snapshot()
            started = time.monotonic()
            await fixture.command(
                "background-cycle", {"durationMs": milliseconds}, native=True
            )
            after = await wait_ready()
            await echo()

            async def resumed():
                observed = await snapshot()
                interval = lifecycle_interval(before, observed)
                return (observed, interval) if observed.get("appState") == "active" and interval else None

            after, (inactive_ms, active_ms) = await eventually(
                resumed,
                message="native app did not retain background and foreground transitions",
            )
            measured_ms = active_ms - inactive_ms
            after = await wait_ready(min_sample_ms=active_ms)
            require(measured_ms > 0, "native background interval was not measured")
            same_parent = (
                before["peer"]["workerId"] == after["peer"]["workerId"]
                and before["peer"]["createdPeerCount"]
                == after["peer"]["createdPeerCount"]
            )
            require(
                process_ids() == initial_pids, "backgrounding replaced a live shell"
            )
            if milliseconds < 3000:
                require(
                    measured_ms < 3000,
                    "short-background test exceeded the grace interval",
                )
                require(
                    same_parent,
                    "short background unexpectedly retired the parent",
                )
            else:
                require(
                    measured_ms >= 3000,
                    "long-background test did not cross the retirement interval",
                )
                require(not same_parent, "long background did not retire the parent")
            return {
                "background_ms": milliseconds,
                "measured_background_ms": measured_ms,
                "recovery_ms": (time.monotonic() - started) * 1000,
                "shell_pids": initial_pids,
                "live_peers": after["peer"]["livePeerCount"],
            }

        # OS activation itself takes time. Immediately request foreground for
        # the short case; accept it only if real callbacks prove a nonzero gap
        # below three seconds and the original parent survives unchanged.
        await case("background_short", lambda: background(0))
        await case("background_retire", lambda: background(5000))

        async def restart() -> dict[str, Any]:
            previous = (await boot())["details"]["launchId"]
            await fixture.command("relaunch", native=True)

            async def relaunched() -> bool:
                latest = await boot()
                return (
                    latest is not None and latest["details"].get("launchId") != previous
                )

            await eventually(
                relaunched, timeout=60, message="native process was not replaced"
            )
            await fixture.command("mount", {"sessions": ["a", "b"], "tools": 2})
            await wait_ready()
            await echo()
            require(
                process_ids() == initial_pids,
                "app process restart replaced a daemon shell",
            )
            return {
                "shell_pids": initial_pids,
                "launch_id": (await boot())["details"]["launchId"],
            }

        await case("process_restart", restart)

        async def outage() -> dict[str, Any]:
            before = await fixture.proxy_command({"op": "status"})
            await echo()
            live = await fixture.proxy_command({"op": "status"})
            require(
                data_packets(live, "data") > data_packets(before, "data"),
                "selected relay carried no measured TURN application data",
            )
            await fixture.proxy_command(
                {"op": "set", "c2s": {"outage": True}, "s2c": {"outage": True}}
            )
            try:
                await fixture.command(
                    "input",
                    {
                        "session": "a",
                        "text": f"outage-dispatched-{uuid.uuid4()}\n",
                        "takeControl": False,
                    },
                )

                # Write after the channel is unavailable. Nothing here asserts
                # that already-dispatched input was lost; only fresh input
                # queued after readiness loss is forbidden from later replay.
                async def unavailable() -> bool:
                    down = await snapshot()
                    return all(
                        down.get("sessions", {}).get(label, {}).get("state") != "ready"
                        for label in ("a", "b")
                    )

                await eventually(
                    unavailable,
                    timeout=75,
                    message="real UDP outage did not retire session readiness",
                )
                forbidden = f"retired-{uuid.uuid4()}"
                await fixture.command(
                    "input",
                    {"session": "a", "text": forbidden + "\n", "takeControl": False},
                )
                fault = await fixture.proxy_command({"op": "status"})
                require(
                    data_packets(fault, "dropped_data")
                    > data_packets(live, "dropped_data"),
                    "UDP outage dropped no TURN application-data packets",
                )
            finally:
                await fixture.proxy_command(
                    {"op": "set", "c2s": {"outage": False}, "s2c": {"outage": False}}
                )
            start = time.monotonic()
            await wait_ready()
            await echo()
            require(
                forbidden not in (fixture.cwd / "a" / "received.txt").read_text(),
                "input queued on a retired transport was replayed",
            )
            require(
                process_ids() == initial_pids, "network outage replaced a session shell"
            )
            return {
                "recovery_ms": (time.monotonic() - start) * 1000,
                "proxy_before": before,
                "proxy_during_outage": fault,
                "selected_transport": "relay/udp",
            }

        await case("relay_udp_outage", outage)

        async def loss() -> dict[str, Any]:
            before = await fixture.proxy_command({"op": "status"})
            await fixture.proxy_command(
                {
                    "op": "set",
                    "c2s": {"loss": 0.1, "delay_ms": 30},
                    "s2c": {"loss": 0.1, "delay_ms": 30},
                }
            )
            start = time.monotonic()
            try:
                for _ in range(12):
                    await echo("a")
                    await echo("b")
                after = await fixture.proxy_command({"op": "status"})
                require(
                    data_packets(after, "dropped_data")
                    > data_packets(before, "dropped_data"),
                    "loss injection did not affect the selected data path",
                )
            finally:
                await fixture.proxy_command(
                    {
                        "op": "set",
                        "c2s": {"loss": 0, "delay_ms": 0},
                        "s2c": {"loss": 0, "delay_ms": 0},
                    }
                )
            return {
                "echo_samples": 24,
                "elapsed_ms": (time.monotonic() - start) * 1000,
                "proxy_before": before,
                "proxy_after": after,
            }

        await case("relay_udp_loss", loss)

        async def upload() -> dict[str, Any]:
            interrupted_id = str(uuid.uuid4())
            await fixture.command(
                "upload",
                {
                    "session": "a",
                    "uploadId": interrupted_id,
                    "name": "interrupted.bin",
                    "totalBytes": 8 * 1024 * 1024,
                    "pauseAfterFirstChunk": True,
                },
            )

            async def in_flight() -> dict[str, Any] | None:
                current = await fixture.command(
                    "upload-status", {"uploadId": interrupted_id}
                )
                require(
                    current.get("state") not in {"failed", "cancelled", "complete"},
                    "upload did not remain active for interruption",
                )
                return (
                    current
                    if current.get("sourceReadPaused") is True
                    and 0 < current.get("sentBytes", 0) < current.get("totalBytes", 0)
                    else None
                )

            dispatched = await eventually(
                in_flight,
                timeout=45,
                message="upload did not pause its source after sending bytes",
            )
            retirement = await background(5000)
            state = await fixture.command("upload-status", {"uploadId": interrupted_id})
            require(
                state.get("state") in {"failed", "cancelled"}
                and state.get("sourceReadPaused") is True
                and state.get("sentBytes") == dispatched["sentBytes"],
                "interrupted upload continued or reported unproven completion",
            )
            await fixture.command("upload-release-source", {"uploadId": interrupted_id})
            released = await fixture.command("upload-status", {"uploadId": interrupted_id})
            require(
                released.get("state") in {"failed", "cancelled"}
                and released.get("sentBytes") == dispatched["sentBytes"]
                and not list((fixture.cwd / "a").rglob("interrupted.bin")),
                "releasing the retired source resumed or completed its upload",
            )
            await echo("b")
            fresh_id = str(uuid.uuid4())
            fresh = await fixture.command(
                "upload",
                {
                    "session": "a",
                    "uploadId": fresh_id,
                    "name": "verified.bin",
                    "totalBytes": 1024 * 1024,
                },
            )

            async def complete() -> dict[str, Any] | None:
                current = await fixture.command("upload-status", {"uploadId": fresh_id})
                require(
                    current.get("state") not in {"failed", "cancelled"},
                    "fresh upload failed",
                )
                return current if current.get("state") == "complete" else None

            finished = await eventually(
                complete, timeout=60, message="fresh upload never completed"
            )
            paths = list((fixture.cwd / "a").rglob("verified.bin"))
            require(
                len(paths) == 1,
                "uploaded file is absent or duplicated in the session directory",
            )
            digest = hashlib.sha256(paths[0].read_bytes()).hexdigest()
            require(
                digest == fresh["sha256"],
                "uploaded bytes differ from the native source",
            )
            return {
                "interrupted_state": state["state"],
                "bytes_before_interruption": dispatched["sentBytes"],
                "retirement": retirement,
                "released_source_state": released["state"],
                "fresh_sha256": digest,
                "result": finished,
            }

        await case("upload_interruption", upload)

        async def identity() -> dict[str, Any]:
            old = await snapshot()
            await fixture.command("rotate-identity")
            await fixture.command("mount", {"sessions": ["a", "b"], "tools": 2})
            new = await wait_ready()
            require(
                new["identityGeneration"] != old["identityGeneration"],
                "device identity did not rotate",
            )
            await echo()
            revoked_device = new["deviceId"]
            require(revoked_device, "native device identity was not observed")
            await fixture.request(
                "POST",
                f"/api/browser-devices/{revoked_device}/revoke",
                native_revocation_body(fixture, revoked_device),
            )

            async def trust_retired() -> bool:
                current = await snapshot()
                peer = current.get("peer") or {}
                return (
                    peer.get("livePeerCount") == 0
                    and peer.get("sampledAtMs", 0) > new["peer"].get("sampledAtMs", 0)
                    and all(
                        item.get("state") != "ready"
                        for item in current.get("tools", [])
                    )
                    and all(
                        current.get("sessions", {}).get(label, {}).get("state")
                        != "ready"
                        for label in ("a", "b")
                    )
                )

            await eventually(
                trust_retired,
                timeout=45,
                message="revocation did not close the measured native parent and attachments",
            )
            closed_worker = (await snapshot())["peer"]["workerId"]
            refused = await fixture.command("retry-host")
            require(
                refused.get("opened") is False and refused.get("state") == "failed",
                "revoked identity was not refused on explicit reconnect",
            )
            refused_at = (await snapshot())["nativeDateMs"]

            async def refused_closed() -> bool:
                current = await snapshot()
                peer = current.get("peer") or {}
                return (
                    peer.get("livePeerCount") == 0
                    and peer.get("workerId") == closed_worker
                    and peer.get("sampledAtMs", 0) >= refused_at
                    and all(
                        current["sessions"][label].get("daemonState") == "failed"
                        for label in ("a", "b")
                    )
                )

            await eventually(
                refused_closed,
                message="refused reconnect did not close its native peer",
            )
            closed_samples = []
            observation_end = time.monotonic() + 3
            last_sample = 0
            while time.monotonic() < observation_end:
                current = await snapshot()
                peer = current.get("peer") or {}
                require(
                    peer.get("workerId") == closed_worker,
                    "revocation check replaced the worker before proving refusal",
                )
                require(
                    current.get("peerAgeMs", 999999) < 2000,
                    "revocation check lost fresh native peer telemetry",
                )
                require(
                    peer.get("livePeerCount") == 0,
                    "refused reconnect left a native peer alive",
                )
                require(
                    all(
                        current["sessions"][label].get("daemonState") == "failed"
                        for label in ("a", "b")
                    ),
                    "revoked parent did not remain failed",
                )
                if peer.get("sampledAtMs", 0) > last_sample:
                    last_sample = peer["sampledAtMs"]
                    closed_samples.append(last_sample)
                await asyncio.sleep(0.25)
            require(
                len(closed_samples) >= 4,
                "too few fresh native samples after refused reconnect",
            )
            await fixture.command("rotate-identity")
            await fixture.command("mount", {"sessions": ["a", "b"], "tools": 2})
            replacement = await wait_ready()
            require(
                replacement["deviceId"] != revoked_device,
                "revoked device identity was reused",
            )
            await echo()
            await fixture.command("switch-account", {"account": "b"})

            async def other_retired() -> bool:
                state = await snapshot()
                return all(
                    item.get("state") in {"closed", "unmounted", "idle"}
                    for item in [
                        *state.get("sessions", {}).values(),
                        *state.get("tools", []),
                    ]
                )

            await eventually(
                other_retired,
                message="second account retained first-account attachments",
            )
            other = await snapshot()
            require(
                other["accountReady"]
                and other["accountId"] == fixture.second_account_id,
                "second account did not become the authenticated owner",
            )
            require(
                all(
                    item.get("state") in {"closed", "unmounted", "idle"}
                    for item in [
                        *other.get("sessions", {}).values(),
                        *other.get("tools", []),
                    ]
                ),
                "second account retained first-account attachments",
            )
            token_b = await fixture.account_token(fixture.second_account_id)
            require(
                await fixture.request("GET", "/api/hosts", token=token_b) == [],
                "second fixture account unexpectedly has a host",
            )
            await fixture.command("switch-account", {"account": "a"})
            await fixture.command("mount", {"sessions": ["a", "b"], "tools": 2})
            await wait_ready()
            await echo()
            await fixture.command("sign-out")

            async def signed_out_retired() -> bool:
                signed_out = await snapshot()
                handles = [
                    *signed_out.get("sessions", {}).values(),
                    *signed_out.get("tools", []),
                ]
                return not signed_out["accountReady"] and all(
                    item.get("state") in {"closed", "unmounted", "idle"}
                    for item in handles
                )

            await eventually(
                signed_out_retired,
                message="signed-out driver retains authenticated attachments",
            )
            await fixture.command("sign-in")
            await fixture.command("mount", {"sessions": ["a", "b"], "tools": 2})
            await wait_ready()
            await echo()
            require(
                process_ids() == initial_pids,
                "identity retirement killed live daemon sessions",
            )
            return {
                "before_generation": old["identityGeneration"],
                "after_generation": new["identityGeneration"],
                "revoked_device_id": revoked_device,
                "replacement_device_id": replacement["deviceId"],
                "revoked_reconnect": refused,
                "closed_peer_samples": closed_samples,
                "shell_pids": initial_pids,
            }

        await case("identity_retirement", identity)
        await fixture.health()
        fixture.raise_if_failed()
        report["status"] = "passed"
    except BaseException as error:
        reason = (
            fixture.failed
            or str(error)
            or (
                "native acceptance interrupted before completion"
                if isinstance(error, asyncio.CancelledError)
                else type(error).__name__
            )
        )
        report.update(status="failed", failure_reason=reason)
        raise
    finally:
        report["completed_at"] = datetime.now(UTC).isoformat()
        save()
        try:
            await fixture.command(
                "screenshot", {"name": "acceptance-final"}, native=True, timeout=10
            )
            await fixture.command(
                "finish",
                {"status": report["status"], "reason": report.get("failure_reason")},
                native=True,
                timeout=10,
            )
        except Exception:
            pass
