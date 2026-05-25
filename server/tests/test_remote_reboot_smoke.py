"""Repeatable tests for the gated remote reboot smoke script."""

from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "smoke-remote-systemd-reboot.sh"


def _write_fake_ssh(tmp_path: Path) -> Path:
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    ssh = fakebin / "ssh"
    ssh.write_text(
        """#!/usr/bin/env python3
import json
import os
import shutil
import sys
from pathlib import Path

state_dir = Path(os.environ["SPAWN_REBOOT_FAKE_STATE"])
state_dir.mkdir(parents=True, exist_ok=True)
state_file = state_dir / "state.json"
log_file = state_dir / "ssh.jsonl"


def read_state():
    if state_file.exists():
        return json.loads(state_file.read_text())
    return {
        "reboot_requested": False,
        "down_seen": False,
        "work": "",
        "unit": "",
        "cleaned": False,
    }


def write_state(state):
    state_file.write_text(json.dumps(state, sort_keys=True))


args = sys.argv[1:]
options = []
while args and args[0] == "-o":
    options.extend(args[:2])
    args = args[2:]
if not args:
    raise SystemExit("missing host")
host = args[0]
command = " ".join(args[1:])
stdin = sys.stdin.read()

with log_file.open("a", encoding="utf-8") as handle:
    handle.write(
        json.dumps(
            {
                "host": host,
                "options": options,
                "command": command,
                "stdin": stdin,
            },
            sort_keys=True,
        )
        + "\\n"
    )

state = read_state()

if command == "true":
    if state["reboot_requested"] and not state["down_seen"]:
        state["down_seen"] = True
        write_state(state)
        raise SystemExit(255)
    raise SystemExit(0)

if "SPAWN_REBOOT_SMOKE_ID=" in command and "SPAWN_REBOOT_SMOKE_UNIT=" in command:
    env = {}
    for part in command.split():
        if part.startswith("SPAWN_REBOOT_SMOKE_ID="):
            env["id"] = part.split("=", 1)[1].strip("'")
        if part.startswith("SPAWN_REBOOT_SMOKE_UNIT="):
            env["unit"] = part.split("=", 1)[1].strip("'")
    work = state_dir / f"spawn-reboot-smoke-{env['id']}"
    work.mkdir(parents=True, exist_ok=True)
    (work / "meta").write_text(f"unit={env['unit']}\\norig_linger=no\\n")
    (work / "count").write_text("1\\n")
    (work / "pid").write_text("12345\\n")
    state["work"] = str(work)
    state["unit"] = env["unit"]
    write_state(state)
    print(work)
    raise SystemExit(0)

if "systemctl reboot" in command:
    state["reboot_requested"] = True
    if state["work"]:
        Path(state["work"], "count").write_text("2\\n")
    write_state(state)
    raise SystemExit(0)

if "SPAWN_REBOOT_SMOKE_WORK=" in command:
    work = command.split("SPAWN_REBOOT_SMOKE_WORK=", 1)[1].split(" ", 1)[0].strip("'")
    if "smoke-remote-systemd-reboot: passed" in stdin:
        count = Path(work, "count").read_text().strip()
        if count != "2":
            raise SystemExit(1)
        print("smoke-remote-systemd-reboot: passed")
        raise SystemExit(0)
    state["cleaned"] = True
    write_state(state)
    if work:
        shutil.rmtree(work, ignore_errors=True)
    raise SystemExit(0)

raise SystemExit(f"unexpected ssh command: {command}")
""",
        encoding="utf-8",
    )
    ssh.chmod(ssh.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return fakebin


def _run(script_env: dict[str, str], tmp_path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(SCRIPT), "fake-host"],
        cwd=REPO_ROOT,
        env=script_env,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )


def test_remote_reboot_smoke_refuses_without_explicit_gate(tmp_path: Path):
    fakebin = _write_fake_ssh(tmp_path)
    state_dir = tmp_path / "state"
    env = {
        **os.environ,
        "PATH": f"{fakebin}:{os.environ['PATH']}",
        "SPAWN_REBOOT_FAKE_STATE": str(state_dir),
    }
    env.pop("SPAWN_ALLOW_REBOOT", None)

    result = _run(env, tmp_path)

    assert result.returncode == 2
    assert "refusing to reboot without SPAWN_ALLOW_REBOOT=1" in result.stderr
    assert not (state_dir / "ssh.jsonl").exists()


def test_remote_reboot_smoke_gated_flow_uses_sudo_password_and_cleans_up(tmp_path: Path):
    fakebin = _write_fake_ssh(tmp_path)
    state_dir = tmp_path / "state"
    env = {
        **os.environ,
        "PATH": f"{fakebin}:{os.environ['PATH']}",
        "SPAWN_ALLOW_REBOOT": "1",
        "SPAWN_REBOOT_FAKE_STATE": str(state_dir),
        "SPAWN_REBOOT_TIMEOUT": "20",
        "SPAWN_SUDO_PASSWORD": "admin",
    }

    result = _run(env, tmp_path)

    assert result.returncode == 0, result.stderr
    assert "smoke-remote-systemd-reboot: preparing remote user service" in result.stdout
    assert "smoke-remote-systemd-reboot: rebooting fake-host" in result.stdout
    assert "smoke-remote-systemd-reboot: verifying service restarted after reboot" in result.stdout
    assert "smoke-remote-systemd-reboot: passed" in result.stdout

    calls = [
        json.loads(line)
        for line in (state_dir / "ssh.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert any("sudo -S -p '' systemctl reboot" in call["command"] for call in calls)
    assert any(call["stdin"] == "admin\n" for call in calls)
    assert any(call["options"] == ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3"] for call in calls)
    assert any(call["options"] == ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"] for call in calls)

    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["reboot_requested"] is True
    assert state["down_seen"] is True
    assert state["cleaned"] is True
    assert state["work"]
    assert not Path(state["work"]).exists()
