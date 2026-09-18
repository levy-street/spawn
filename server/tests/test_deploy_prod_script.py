"""Pure release-contract checks embedded in the production deploy script."""

from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.name == "nt", reason="production deploy scripts require POSIX shell semantics"
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = REPO_ROOT / "scripts" / "deploy-prod.sh"
HEALTH_SCRIPT = REPO_ROOT / "scripts" / "health-check.sh"
RELEASE_LIB = REPO_ROOT / "scripts" / "release-lib.sh"


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def test_deploy_self_test_covers_release_contract_without_remote_calls(tmp_path: Path):
    """Rendering, signing failures, tree gate, and API checks stay local."""
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


def test_manifest_renderer_includes_signed_release_identity():
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; render_prebuilt_manifest '
            "1111111111111111111111111111111111111111 "
            "2222222222222222222222222222222222222222 "
            "0.1.0+g111111111111 1700000000 e65c013f "
            "darwin-aarch64:"
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:"
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "release-render-test",
            str(RELEASE_LIB),
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    manifest = json.loads(result.stdout)
    assert manifest["release_counter"] == 1_700_000_000
    assert manifest["signing_key_id"] == "e65c013f"
    assert manifest["targets"]["darwin-aarch64"]["spawn_worker_sha256"] == "b" * 64


def test_deploy_signing_key_gate_and_unsigned_override_warning_are_pinned():
    source = DEPLOY_SCRIPT.read_text()
    key_gate = source.index('release_signing_key_readable "$release_signing_key_file"')
    release_prepare = source.index("prepare_prebuilt_release")

    assert release_prepare < key_gate
    assert "release signing key is missing or unreadable" in source
    assert "daemons will refuse unsigned manifests" in source
    assert "SPAWN_DEPLOY_PREBUILTS=0 overrides the daemon release gate" in source
    # Atomic publication and interrupted-transfer recovery run against the
    # real shell function and verifier in test_prebuilt_publication.py.


def test_release_key_parser_accepts_daemon_rotation_list(tmp_path: Path):
    public_key = "8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0"
    rust_source = tmp_path / "release_key.rs"
    rust_source.write_text(
        "pub const RELEASE_SIGNING_PUBLIC_KEYS: &[&str] = &[\n"
        f'    "{public_key}",\n'
        "];\n"
    )
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; release_public_keys_from_rust_file "$2"',
            "release-key-parser-test",
            str(RELEASE_LIB),
            str(rust_source),
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == public_key
