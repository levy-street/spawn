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

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

REPO_ROOT = Path(__file__).resolve().parents[2]
VERIFY_SCRIPT = REPO_ROOT / "scripts" / "verify-release.sh"
EXPECTED_COMMIT = "1" * 40
EXPECTED_DAEMON_TREE = "2" * 40
EXPECTED_MOBILE_TREE = "3" * 40
EXPECTED_COUNTER = 1_700_000_000


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _run_verifier(tmp_path: Path, *, manifest_counter: int) -> subprocess.CompletedProcess[str]:
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
    release = {
        "server": {"commit": EXPECTED_COMMIT},
        "daemon": {
            "tree": EXPECTED_DAEMON_TREE,
            "targets": manifest["targets"],
        },
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

    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    _write_executable(
        fakebin / "git",
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "case \"$*\" in\n"
        f"  'rev-parse --show-toplevel') printf '%s\\n' {shlex.quote(str(REPO_ROOT))} ;;\n"
        f"  'rev-parse HEAD^{{commit}}') printf '%s\\n' {EXPECTED_COMMIT} ;;\n"
        f"  'rev-parse HEAD:daemon') printf '%s\\n' {EXPECTED_DAEMON_TREE} ;;\n"
        f"  'rev-parse HEAD:mobile') printf '%s\\n' {EXPECTED_MOBILE_TREE} ;;\n"
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
                f"http://127.0.0.1:{server.server_port}",
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


def test_verify_release_rejects_wrong_release_counter(tmp_path: Path):
    result = _run_verifier(tmp_path, manifest_counter=EXPECTED_COUNTER - 1)

    assert result.returncode != 0
    counter_row = next(
        line for line in result.stdout.splitlines() if "daemon release counter" in line
    )
    assert "FAIL" in counter_row
    assert "one or more release identities do not match" in result.stderr
