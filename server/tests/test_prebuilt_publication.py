"""Publication faults keep a complete old or new daemon release readable."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

from spawn_server import release
from spawn_server.routes import install

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "activate_prebuilt", ROOT / "scripts/activate-prebuilt.py"
)
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)

pytestmark = pytest.mark.skipif(
    os.name == "nt", reason="production publication uses POSIX symlinks"
)


def stage_pair(directory: Path, content: bytes, tree: str) -> dict:
    target = directory / "linux-x86_64"
    target.mkdir(parents=True)
    for name in ("spawnd", "spawn-worker"):
        (target / name).write_bytes(content + name.encode())
    manifest = {
        "version": "0.1.0+g111111111111",
        "commit": "1" * 40,
        "tree": tree,
        "targets": {
            "linux-x86_64": {
                "spawnd_sha256": hashlib.sha256((target / "spawnd").read_bytes()).hexdigest(),
                "spawn_worker_sha256": hashlib.sha256(
                    (target / "spawn-worker").read_bytes()
                ).hexdigest(),
            }
        },
    }
    (directory / "manifest.json").write_text(json.dumps(manifest))
    (directory / "manifest.json.sig").write_text("already locally signed bytes\n")
    return manifest


def activate(base: Path, stage: Path):
    return activation.activate(
        base,
        stage,
        "b" * 40,
        *(
            hashlib.sha256((stage / name).read_bytes()).hexdigest()
            for name in ("manifest.json", "manifest.json.sig")
        ),
    )


@pytest.fixture
def published(tmp_path, monkeypatch):
    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    monkeypatch.setattr(install, "_repo_root", lambda: tmp_path)
    base = tmp_path / "daemon/target/prebuilt"
    stage_pair(base, b"old-", "a" * 40)
    return base


@pytest.mark.parametrize("existing_pointer", [False, True])
def test_atomic_switch_pins_inflight_downloads_and_preserves_old_release(
    published, existing_pointer
):
    if existing_pointer:
        initial = published / "releases/.staging-initial"
        stage_pair(initial, b"initial-", "b" * 40)
        activate(published, initial)
    old = release.prebuilt_root()
    response = install._serve_binary("spawnd", "linux-x86_64", None)
    old_bytes = Path(response.path).read_bytes()
    stage = published / "releases/.staging-next"
    stage_pair(stage, b"new-", "b" * 40)
    # Uploading a partial or complete stage cannot change the serving root.
    assert release.prebuilt_root() == old
    result = activate(published, stage)
    assert release.prebuilt_root() == result
    assert release.read_prebuilt_manifest().tree == "b" * 40
    assert Path(response.path).read_bytes() == old_bytes
    assert (
        Path(install._serve_binary("spawnd", "linux-x86_64", None).path).read_bytes()
        == b"new-spawnd"
    )
    assert (old / "manifest.json").is_file()


@pytest.mark.parametrize(
    "fault", ["binary", "manifest", "signature", "before-switch", "after-switch"]
)
def test_failed_activation_keeps_one_complete_identity(published, monkeypatch, fault):
    stage = published / "releases/.staging-fault"
    stage_pair(stage, b"new-", "b" * 40)
    digests = [
        hashlib.sha256((stage / name).read_bytes()).hexdigest()
        for name in ("manifest.json", "manifest.json.sig")
    ]
    if fault in {"binary", "manifest", "signature"}:
        path = {
            "binary": "linux-x86_64/spawn-worker",
            "manifest": "manifest.json",
            "signature": "manifest.json.sig",
        }[fault]
        (stage / path).write_bytes(b"incomplete transfer")
    else:
        replace = activation.os.replace

        def interrupted(source, destination):
            if fault == "after-switch":
                replace(source, destination)
            raise OSError("connection dropped")

        monkeypatch.setattr(activation.os, "replace", interrupted)
    with pytest.raises((ValueError, OSError)):
        activation.activate(published, stage, "b" * 40, *digests)
    expected = "b" if fault == "after-switch" else "a"
    assert release.read_prebuilt_manifest().tree == expected * 40


@pytest.mark.parametrize("failure_transfer", range(1, 5))
def test_real_publish_function_can_retry_each_interrupted_transfer(
    published, tmp_path, failure_transfer
):
    assets = tmp_path / "assets"
    assets.mkdir()
    reference = tmp_path / "reference"
    stage_pair(reference, b"new-", "b" * 40)
    for name in ("spawnd", "spawn-worker"):
        (assets / f"{name}-x86_64-unknown-linux-gnu").write_bytes(
            (reference / "linux-x86_64" / name).read_bytes()
        )
    script = (ROOT / "scripts/deploy-prod.sh").read_text()
    publish = script[script.index("publish_prebuilts() {") : script.index("\npublish_prebuilts\n")]
    # Exercise the real upload order; only SSH, SCP and local signing are fixture
    # adapters. The activation helper and server manifest verifier are real.
    remote = published.parents[2]
    (remote / "scripts").mkdir()
    (remote / "scripts/activate-prebuilt.py").symlink_to(ROOT / "scripts/activate-prebuilt.py")
    (remote / "server").mkdir()
    (remote / "server/.venv").symlink_to(ROOT / "server/.venv", target_is_directory=True)
    harness = tmp_path / "publish.sh"
    harness.write_text(
        """set -euo pipefail
source "$PUBLICATION_SOURCE/scripts/release-lib.sh"
ssh() { shift; bash -c "$1"; }
transfers=0
scp() {
  shift
  transfers=$((transfers + 1))
  if [[ "$transfers" == "$FAIL_TRANSFER" ]]; then return 1; fi
  cp "$1" "${2#fixture:}"
}
render_prebuilt_manifest() { cat "$PUBLICATION_REFERENCE/manifest.json"; }
sign_prebuilt_manifest() { cp "$PUBLICATION_REFERENCE/manifest.json.sig" "$2"; }
host=fixture
remote_path="$PUBLICATION_REMOTE"
prebuilt_tmp="$PUBLICATION_ASSETS"
prebuilt_setting=1
prebuilt_ready=1
release_commit=unused
release_tree=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
release_version=unused
release_counter=1
release_key_id=unused
release_signing_key_file=unused
prebuilt_entries=(unused)
prebuilt_variant_entries=()
PREBUILT_TARGETS=(linux-x86_64:x86_64-unknown-linux-gnu)
PREBUILT_VARIANTS=()
"""
        + publish
        + "\npublish_prebuilts\n"
    )
    env = os.environ | {
        "PUBLICATION_SOURCE": str(ROOT),
        "PUBLICATION_REMOTE": str(remote),
        "PUBLICATION_ASSETS": str(assets),
        "PUBLICATION_REFERENCE": str(reference),
        "FAIL_TRANSFER": str(failure_transfer),
    }
    failed = subprocess.run(
        ["bash", str(harness)], env=env, capture_output=True, text=True, timeout=15
    )
    assert failed.returncode != 0
    assert release.read_prebuilt_manifest().tree == "a" * 40
    result = subprocess.run(
        ["bash", str(harness)],
        env=env | {"FAIL_TRANSFER": "0"},
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert release.read_prebuilt_manifest().tree == "b" * 40
