#!/usr/bin/env python3
"""Run the installed acceptance shell with real adb/simctl lifecycle effects."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request
from urllib.parse import urlparse

APP_ID = "dev.spawnd.acceptance"
SIMULATOR_INSTALL_TIMEOUT_SECONDS = 600
DIAGNOSTIC_STREAM_LIMIT = 32_768


def local_origin(value: str) -> str:
    url = urlparse(value)
    if (url.scheme != "http" or url.hostname not in {"localhost", "127.0.0.1"}
            or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment):
        raise ValueError("Native runner requires a local fixture origin")
    return value.rstrip("/")


class Runner:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.ready = json.loads(args.ready_file.read_text())
        self.manifest = json.loads((args.build / "acceptance-build.json").read_text())
        if self.manifest["candidate_commit"] != self.ready["candidateCommit"]:
            raise ValueError("Native artifact and fixture candidates differ")
        if self.manifest.get("source_clean") is not True:
            raise ValueError("Native artifact lacks clean candidate source provenance")
        if self.manifest["platform"] != args.platform or self.manifest["app_id"] != APP_ID:
            raise ValueError("Native artifact platform/application mismatch")
        self.origin = local_origin(args.fixture_url)
        self.device = args.device
        self.secrets = [self.ready["token"]]
        for server in self.ready.get("iceServers", []):
            self.secrets.extend(str(server[key]) for key in ("username", "credential") if key in server)
        self.args.output.mkdir(parents=True, exist_ok=True)
        (self.args.output / "native-build.json").write_text(json.dumps(self.manifest, indent=2) + "\n")

    def control(self, path: str, body: object | None = None) -> object:
        request = urllib.request.Request(self.origin + "/__acceptance/" + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"X-Acceptance-Token": self.ready["token"], "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)

    def redact(self, value: str) -> str:
        for secret in self.secrets:
            if secret:
                value = value.replace(secret, "[REDACTED]")
        value = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED_JWT]", value)
        return re.sub(r"(?i)(Bearer\s+)[A-Za-z0-9._~+-]+", r"\1[REDACTED]", value)

    def event(self, action: str, result: object, command_id: str | None = None, status: str = "passed") -> None:
        self.control("event", {"type": "native-command", "status": status,
            **({"commandId": command_id} if command_id else {}), "details": {
                "schema_kind": self.manifest["schema_kind"],
                "candidate_commit": self.manifest["candidate_commit"],
                "source_clean": True,
                "platform": self.args.platform,
                "values": {"action": action, "result": result}}})

    def command(self, *args: str, timeout: int = 120) -> str:
        started = time.monotonic()
        record = {"command": list(args), "timeout_seconds": timeout, "device": self.device}
        self.diagnostic({**record, "status": "started"})

        def stream(value: str | bytes | None) -> str:
            if isinstance(value, bytes):
                value = value.decode("utf-8", errors="replace")
            # Redact before truncation so an output boundary cannot split a token.
            return self.redact(value or "")[-DIAGNOSTIC_STREAM_LIMIT:]

        try:
            result = subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=True)
        except (OSError, subprocess.SubprocessError) as error:
            self.diagnostic({**record, "status": "failed", "error_type": type(error).__name__,
                "error": self.redact(str(error)), "returncode": getattr(error, "returncode", None),
                "stdout": stream(getattr(error, "stdout", None)),
                "stderr": stream(getattr(error, "stderr", None)),
                "elapsed_seconds": round(time.monotonic() - started, 3)})
            raise
        self.diagnostic({**record, "status": "completed", "returncode": result.returncode,
            "stdout": stream(result.stdout), "stderr": stream(result.stderr),
            "elapsed_seconds": round(time.monotonic() - started, 3)})
        return result.stdout.strip()

    def diagnostic(self, record: dict) -> None:
        entry = {**record, "at": datetime.now(timezone.utc).isoformat(),
            "disk_free_bytes": shutil.disk_usage(self.args.output).free}
        with (self.args.output / "native-runner.jsonl").open("a") as output:
            output.write(self.redact(json.dumps(entry)) + "\n")

    def platform_phase(self, info: dict, phase: str) -> None:
        info.update(phase=phase, at=datetime.now(timezone.utc).isoformat(),
            disk_free_bytes=shutil.disk_usage(self.args.output).free)
        (self.args.output / "native-platform.json").write_text(json.dumps(info, indent=2) + "\n")
        self.diagnostic({"platform": self.args.platform, **info})

    def adb(self, *args: str) -> str:
        return self.command("adb", "-s", self.device, *args)

    def simctl(self, *args: str, timeout: int = 120) -> str:
        return self.command("xcrun", "simctl", *args, timeout=timeout)

    def install(self) -> None:
        artifact = Path((self.args.build / "native-artifact.txt").read_text().strip()).resolve(strict=True)
        if not artifact.is_relative_to(self.args.build.resolve()):
            raise ValueError("Native artifact must belong to the disposable build")
        bootstrap = self.control("bootstrap")
        self.secrets.append(bootstrap["bearerToken"])
        if bootstrap.get("secondAccount"):
            self.secrets.append(bootstrap["secondAccount"]["bearerToken"])
        if self.args.platform == "android":
            if not self.device:
                devices = [line.split()[0] for line in self.command("adb", "devices").splitlines()[1:]
                           if line.endswith("\tdevice") and line.startswith("emulator-")]
                if len(devices) != 1:
                    raise RuntimeError("Exactly one Android emulator is required")
                self.device = devices[0]
            if self.adb("shell", "getprop", "ro.kernel.qemu") != "1":
                raise RuntimeError("Acceptance runner refuses physical Android devices")
            platform_info = {"sdk": self.adb("shell", "getprop", "ro.build.version.sdk"),
                "release": self.adb("shell", "getprop", "ro.build.version.release"),
                "model": self.adb("shell", "getprop", "ro.product.model"), "device": self.device}
            self.platform_phase(platform_info, "installing")
            self.adb("install", "-r", str(artifact))
            self.adb("logcat", "-c")
        else:
            devices = json.loads(self.simctl("list", "devices", "available", "--json"))["devices"]
            available = [(runtime, device) for runtime, entries in devices.items() for device in entries
                         if "iOS" in runtime and device["name"].startswith("iPhone")]
            if not self.device:
                available.sort(key=lambda item: (item[1]["state"] == "Booted", item[0], item[1]["name"]), reverse=True)
                if not available:
                    raise RuntimeError("No installed iOS simulator runtime/iPhone device")
                self.device = available[0][1]["udid"]
            selected = next(((runtime, device) for runtime, device in available if device["udid"] == self.device), None)
            if not selected:
                raise RuntimeError("Requested device is not an available iPhone simulator")
            platform_info = {"runtime": selected[0], "device": self.device, "model": selected[1]["name"],
                "initial_state": selected[1]["state"]}
            self.platform_phase(platform_info, "selected")
            platform_info["xcode"] = self.command("xcodebuild", "-version")
            self.platform_phase(platform_info, "booting")
            if selected[1]["state"] != "Booted":
                self.simctl("boot", self.device)
            self.simctl("bootstatus", self.device, "-b", timeout=300)
            self.platform_phase(platform_info, "installing")
            # Installation exceeded the default 120s on a cold hosted run.
            # Give setup one larger bounded attempt; product cases are not retried.
            self.simctl("install", self.device, str(artifact), timeout=SIMULATOR_INSTALL_TIMEOUT_SECONDS)
        self.platform_phase(platform_info, "launching")
        self.launch()
        self.platform_phase(platform_info, "launched")
        self.event("launch", platform_info)

    def launch(self) -> None:
        if self.args.platform == "android":
            self.adb("shell", "am", "start", "-W", "-n", APP_ID + "/.MainActivity")
        else:
            self.simctl("launch", self.device, APP_ID)

    def screenshot(self, label: str) -> str:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", label)[:80]
        path = self.args.output / (safe + ".png")
        if self.args.platform == "android":
            with path.open("wb") as output:
                subprocess.run(["adb", "-s", self.device, "exec-out", "screencap", "-p"],
                    stdout=output, check=True, timeout=30)
        else:
            self.simctl("io", self.device, "screenshot", str(path))
        return path.name

    def perform(self, action: str, payload: dict) -> dict:
        if action == "background":
            if self.args.platform == "android":
                self.adb("shell", "input", "keyevent", "KEYCODE_HOME")
            else:
                self.simctl("launch", self.device, "com.apple.Preferences")
            duration = float(payload.get("durationMs", 0)) / 1000
            if not 0 <= duration <= 30:
                raise ValueError("Native background duration must be between 0 and 30000 ms")
            time.sleep(duration)
        elif action == "foreground":
            self.launch()
        elif action == "relaunch":
            if self.args.platform == "android":
                self.adb("shell", "am", "force-stop", APP_ID)
            else:
                self.simctl("terminate", self.device, APP_ID)
            time.sleep(1)
            self.launch()
        elif action == "screenshot":
            return {"screenshot": self.screenshot(str(payload.get("name", "native")))}
        elif action == "finish":
            if payload.get("status") not in {"passed", "failed"}:
                raise ValueError("Finish needs a passed/failed fixture verdict")
            return {"status": payload["status"], "reason": payload.get("reason"),
                "screenshot": self.screenshot("final")}
        else:
            raise ValueError(f"Unknown native runner action: {action}")
        return {"completed": True}

    def collect_logs(self) -> None:
        try:
            if self.args.platform == "android":
                logs = self.adb("logcat", "-d", "-v", "threadtime")
            else:
                logs = self.command("xcrun", "simctl", "spawn", self.device, "log", "show", "--last", "30m",
                    "--style", "compact", "--predicate", 'processImagePath CONTAINS "SPAWND"', timeout=60)
            (self.args.output / "native.log").write_text(self.redact(logs))
        except Exception as error:
            (self.args.output / "native-log-error.txt").write_text(self.redact(str(error)))

    def execute(self) -> int:
        try:
            self.install()
            deadline = time.monotonic() + self.args.timeout
            while time.monotonic() < deadline:
                command = self.control("native-command")
                if command is None:
                    time.sleep(0.5)
                    continue
                try:
                    result = self.perform(command["action"], command.get("payload", {}))
                    self.event(command["action"], result, command["id"])
                    if command["action"] == "finish":
                        return 0 if result["status"] == "passed" else 1
                except Exception as error:
                    self.event(command["action"], {"error": self.redact(str(error))}, command["id"], "failed")
                    raise
            raise TimeoutError("Native acceptance fixture did not finish within the runner budget")
        except Exception as error:
            try:
                self.event("runner-error", {"error": self.redact(str(error))}, status="failed")
            except Exception:
                # Keep the native setup/runtime failure even if the fixture is unavailable.
                pass
            raise
        finally:
            if self.device:
                self.collect_logs()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=["ios", "android"], required=True)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--ready-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fixture-url", default="http://127.0.0.1:18100")
    parser.add_argument("--device")
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()
    if not 60 <= args.timeout <= 7200:
        parser.error("timeout must be between 60 and 7200 seconds")
    runner = Runner(args)
    try:
        raise SystemExit(runner.execute())
    except Exception as error:
        print(runner.redact(str(error)), flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
