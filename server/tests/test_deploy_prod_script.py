"""Pure release-contract checks embedded in the production deploy script."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = REPO_ROOT / "scripts" / "deploy-prod.sh"
HEALTH_SCRIPT = REPO_ROOT / "scripts" / "health-check.sh"


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def test_deploy_self_test_covers_release_contract_without_remote_calls(tmp_path: Path):
    """The renderer, tree gate, and API comparison run without ssh/scp/gh."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    forbidden_log = tmp_path / "forbidden.log"
    for tool in ("ssh", "scp", "gh", "curl", "systemctl"):
        _write_executable(
            bin_dir / tool,
            "#!/usr/bin/env bash\n"
            f'echo "{tool} $*" >> "{forbidden_log}"\n'
            "exit 99\n",
        )

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    result = subprocess.run(
        [str(DEPLOY_SCRIPT), "--self-test"],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "self-test ok" in result.stdout
    assert "connection-probe: self-test ok" in result.stdout
    assert not forbidden_log.exists()


def test_health_self_test_covers_connection_parsing_without_network_calls(tmp_path: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    forbidden_log = tmp_path / "forbidden.log"
    for tool in ("curl", "systemctl"):
        _write_executable(
            bin_dir / tool,
            "#!/usr/bin/env bash\n"
            f'echo "{tool} $*" >> "{forbidden_log}"\n'
            "exit 99\n",
        )

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    result = subprocess.run(
        [str(HEALTH_SCRIPT), "--self-test"],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "connection-probe: self-test ok" in result.stdout
    assert "health: self-test ok" in result.stdout
    assert not forbidden_log.exists()


def test_health_websocket_mode_passes_the_public_origin_to_the_probe(tmp_path: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "python.log"
    _write_executable(
        bin_dir / "python3",
        "#!/usr/bin/env bash\n"
        f'printf "%s\\n" "$*" >> "{calls}"\n'
        'echo "websocket wss://status.example/ws/alerts upgraded (101) and rejected anonymous auth (1008)"\n',
    )
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"

    result = subprocess.run(
        [str(HEALTH_SCRIPT), "--probe-websocket", "https://status.example"],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert calls.read_text().strip().endswith(
        "scripts/connection-probe.py websocket https://status.example"
    )
    assert "101" in result.stdout
    assert "1008" in result.stdout


def test_deploy_smoke_names_the_public_websocket_probe():
    source = DEPLOY_SCRIPT.read_text()
    assert "SPAWN_DEPLOY_PUBLIC_ORIGIN" in source
    assert "health-check.sh --probe-websocket" in source
