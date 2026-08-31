"""Read-only release verifier checks for signed daemon manifests."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shlex
import stat
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

pytestmark = pytest.mark.skipif(
    os.name == "nt", reason="release verification scripts require POSIX shell semantics"
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VERIFY_SCRIPT = REPO_ROOT / "scripts" / "verify-release.sh"
EXPECTED_COMMIT = "1" * 40
EXPECTED_DAEMON_TREE = "2" * 40
EXPECTED_MOBILE_TREE = "3" * 40
EXPECTED_DESKTOP_TREE = "4" * 40
EXPECTED_DESKTOP_VERSION = "0.1.0"
EXPECTED_COUNTER = 1_700_000_000


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _minisign_fixture(artifact: bytes) -> tuple[str, str]:
    """A public key and signature in the exact shape `tauri signer` produces.

    Both are the base64 of a minisign text file. The payload signature is
    Ed25519 over the BLAKE2b-512 prehash of the artifact ("ED"), and the global
    signature covers the raw signature followed by the trusted comment text —
    without its "trusted comment: " label, which is where a hand-rolled
    verifier most easily goes wrong.
    """
    private_key = Ed25519PrivateKey.generate()
    public_raw = private_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    key_id = hashlib.sha256(public_raw).digest()[:8]
    public_text = (
        "untrusted comment: minisign public key\n"
        + base64.b64encode(b"Ed" + key_id + public_raw).decode("ascii")
        + "\n"
    )
    signature = private_key.sign(hashlib.blake2b(artifact, digest_size=64).digest())
    trusted_comment = "timestamp:1700000000\tfile:SPAWN-D.app.tar.gz"
    global_signature = private_key.sign(signature + trusted_comment.encode("ascii"))
    signature_text = (
        "untrusted comment: signature from tauri secret key\n"
        + base64.b64encode(b"ED" + key_id + signature).decode("ascii")
        + f"\ntrusted comment: {trusted_comment}\n"
        + base64.b64encode(global_signature).decode("ascii")
        + "\n"
    )
    encode = lambda text: base64.b64encode(text.encode("ascii")).decode("ascii")  # noqa: E731
    return encode(public_text), encode(signature_text)


def _run_verifier(
    tmp_path: Path, *, manifest_counter: int, include_desktop: bool = False
) -> subprocess.CompletedProcess[str]:
    private_key = Ed25519PrivateKey.generate()
    public_raw = private_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    public_key = _b64url(public_raw)
    key_id = hashlib.sha256(public_raw).hexdigest()[:8]

    spawnd = b"throwaway spawnd binary\n"
    worker = b"throwaway spawn-worker binary\n"
    target = "darwin-aarch64"
    manifest = {
        "commit": EXPECTED_COMMIT,
        "tree": EXPECTED_DAEMON_TREE,
        "version": f"0.1.0+g{EXPECTED_COMMIT[:12]}",
        "release_counter": manifest_counter,
        "signing_key_id": key_id,
        "targets": {
            target: {
                "spawnd_sha256": hashlib.sha256(spawnd).hexdigest(),
                "spawn_worker_sha256": hashlib.sha256(worker).hexdigest(),
            }
        },
    }
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    signature = (_b64url(private_key.sign(manifest_bytes)) + "\n").encode("ascii")
    release: dict[str, object] = {
        "server": {"commit": EXPECTED_COMMIT},
        "daemon": {
            "tree": EXPECTED_DAEMON_TREE,
            "targets": manifest["targets"],
        },
    }
    desktop_platforms = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]
    desktop_artifact = b"throwaway SPAWN D.app.tar.gz\n"
    desktop_public_key, desktop_signature = _minisign_fixture(desktop_artifact)
    if include_desktop:
        release["desktop"] = {
            "version": EXPECTED_DESKTOP_VERSION,
            "tree": EXPECTED_DESKTOP_TREE,
            "platforms": desktop_platforms,
        }
    payloads = {
        "/api/release": json.dumps(release).encode("utf-8"),
        "/api/install/manifest.json": manifest_bytes,
        "/api/install/manifest.json.sig": signature,
        f"/api/install/spawnd/{target}": spawnd,
        f"/api/install/spawn-worker/{target}": worker,
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            body = payloads.get(self.path)
            if body is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    if include_desktop:
        # The manifest's URLs must point back into this origin's /desktop/
        # tree, so it can only be assembled once the port is known.
        artifact_names = {
            platform: (
                f"SPAWN-D_{EXPECTED_DESKTOP_VERSION}_{platform}-setup.exe"
                if platform == "windows-x86_64"
                else f"SPAWN-D_{EXPECTED_DESKTOP_VERSION}_{platform}.app.tar.gz"
            )
            for platform in desktop_platforms
        }
        latest = {
            "version": EXPECTED_DESKTOP_VERSION,
            "notes": "throwaway",
            "pub_date": "2026-01-01T00:00:00Z",
            "platforms": {
                platform: {
                    "url": f"{origin}/desktop/{name}",
                    "signature": desktop_signature,
                }
                for platform, name in artifact_names.items()
            },
        }
        payloads["/desktop/latest.json"] = json.dumps(latest).encode("utf-8")
        for name in artifact_names.values():
            payloads[f"/desktop/{name}"] = desktop_artifact

    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    tauri_conf = json.dumps({"version": EXPECTED_DESKTOP_VERSION})
    _write_executable(
        fakebin / "git",
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'case "$*" in\n'
        f"  'rev-parse --show-toplevel') printf '%s\\n' {shlex.quote(str(REPO_ROOT))} ;;\n"
        f"  'rev-parse HEAD^{{commit}}') printf '%s\\n' {EXPECTED_COMMIT} ;;\n"
        f"  'rev-parse HEAD:daemon') printf '%s\\n' {EXPECTED_DAEMON_TREE} ;;\n"
        f"  'rev-parse HEAD:mobile') printf '%s\\n' {EXPECTED_MOBILE_TREE} ;;\n"
        f"  'rev-parse HEAD:desktop') printf '%s\\n' {EXPECTED_DESKTOP_TREE} ;;\n"
        f"  'show HEAD:desktop/src-tauri/tauri.conf.json') printf '%s\\n' {shlex.quote(tauri_conf)} ;;\n"
        f"  'show HEAD:desktop/updater.pubkey') printf '%s\\n' {desktop_public_key} ;;\n"
        f"  'show -s --format=%ct {EXPECTED_COMMIT}') printf '%s\\n' {EXPECTED_COUNTER} ;;\n"
        "  'show HEAD:daemon/src/release_key.rs') exit 1 ;;\n"
        "  *) printf 'unexpected fake git call: %s\\n' \"$*\" >&2; exit 99 ;;\n"
        "esac\n",
    )
    env = os.environ.copy()
    env["PATH"] = f"{fakebin}:{env['PATH']}"
    env["SPAWN_RELEASE_PUBLIC_KEY"] = public_key

    try:
        return subprocess.run(
            [
                str(VERIFY_SCRIPT),
                "--ref",
                "HEAD",
                "--skip-mobile",
                *([] if include_desktop else ["--skip-desktop"]),
                origin,
            ],
            cwd=REPO_ROOT,
            env=env,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_verify_release_accepts_throwaway_signed_manifest(tmp_path: Path):
    result = _run_verifier(tmp_path, manifest_counter=EXPECTED_COUNTER)

    assert result.returncode == 0, result.stderr
    assert "daemon manifest signature" in result.stdout
    assert "SPAWN_RELEASE_PUBLIC_KEY fallback" in result.stdout
    assert "daemon release counter" in result.stdout
    assert "valid (key " in result.stdout


def test_verify_release_accepts_desktop_minisign_manifest(tmp_path: Path):
    result = _run_verifier(tmp_path, manifest_counter=EXPECTED_COUNTER, include_desktop=True)

    assert result.returncode == 0, result.stdout + result.stderr
    rows = [line for line in result.stdout.splitlines() if "desktop." in line]
    assert any("desktop.darwin-aarch64 signature" in line and "valid" in line for line in rows)
    assert any("desktop.windows-x86_64.url" in line and "-setup.exe" in line for line in rows)
    assert any("desktop.windows-x86_64 signature" in line and "valid" in line for line in rows)


def test_verify_release_rejects_wrong_release_counter(tmp_path: Path):
    result = _run_verifier(tmp_path, manifest_counter=EXPECTED_COUNTER - 1)

    assert result.returncode != 0
    counter_row = next(
        line for line in result.stdout.splitlines() if "daemon release counter" in line
    )
    assert "FAIL" in counter_row
    assert "one or more release identities do not match" in result.stderr
