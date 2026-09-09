"""Hosted daemon installer."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

from spawn_server.routes import install as install_routes

requires_posix_shell = pytest.mark.skipif(
    os.name == "nt", reason="the Unix installer harness requires POSIX path semantics"
)


@pytest.fixture(autouse=True)
def _isolate_repo_root(monkeypatch, tmp_path):
    # Keep install.sh rendering hermetic: point the prebuilt lookup at an empty
    # dir so a locally-built daemon/target/release/* can't leak sha256 pins into
    # tests (a real pin would fail-verify the fabricated fake downloads). Tests
    # that need a staged prebuilt override _repo_root themselves afterwards.
    empty = tmp_path / "empty-repo"
    empty.mkdir()
    monkeypatch.setattr(install_routes, "_repo_root", lambda: empty)


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


#: Where the fake daemon "publishes" the pair it is run from, relative to the
#: install root: the real layout's directory, with a fixed release id.
FAKE_RELEASE = "lib/spawn/releases/fake-1.0-00000000"


def _fake_spawnd_body() -> str:
    return f"""#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$SPAWN_FAKE_LOG_DIR/spawnd.log"
if [ -n "${{SPAWN_SETUP_TOKEN:-}}" ]; then
  printf '%s|%s\\n' "$SPAWN_SETUP_TOKEN" "$*" >> "$SPAWN_FAKE_LOG_DIR/setup-token.log"
fi
if [ "${{1:-}}" = "--version" ]; then
  printf '%s\\n' "${{SPAWN_FAKE_SPAWND_VERSION:-spawnd fake 1.0}}"
  exit 0
fi
if [ "${{1:-}}" = "__publish-release" ]; then
  # What the real command does: publish the pair beside this executable as
  # one release under the install root and point bin/ at it.
  root=""
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--install-root" ]; then
      root="$arg"
    fi
    previous="$arg"
  done
  [ -n "$root" ] || exit 1
  here=$(cd "$(dirname "$0")" && pwd)
  release="$root/{FAKE_RELEASE}"
  mkdir -p "$release" "$root/bin"
  cp "$here/spawnd" "$release/spawnd"
  cp "$here/spawn-worker" "$release/spawn-worker"
  chmod 755 "$release/spawnd" "$release/spawn-worker"
  ln -sfn "$release/spawnd" "$root/bin/spawnd"
  ln -sfn "$release/spawn-worker" "$root/bin/spawn-worker"
  printf '%s\\n' "spawn: published fake 1.0 (release) to $release"
  printf '%s\\n' "spawn: $root/bin/spawnd now runs this release"
  exit 0
fi
exit 0
"""


def _fake_worker_body() -> str:
    return """#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$SPAWN_FAKE_LOG_DIR/spawn-worker.log"
exit 0
"""


def _write_fake_host_commands(fakebin: Path) -> None:
    _write_executable(
        fakebin / "uname",
        """#!/bin/sh
case "${1:-}" in
  -s) printf '%s\\n' "$SPAWN_FAKE_UNAME_S" ;;
  -m) printf '%s\\n' "$SPAWN_FAKE_UNAME_M" ;;
  *) printf '%s\\n' "$SPAWN_FAKE_UNAME_S" ;;
esac
""",
    )
    _write_executable(fakebin / "cc", "#!/bin/sh\nexit 0\n")
    _write_executable(
        fakebin / "rustup",
        """#!/bin/sh
printf '%s\\n' "$*" >> "$SPAWN_FAKE_LOG_DIR/rustup.log"
exit 0
""",
    )
    _write_executable(
        fakebin / "curl",
        f"""#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$SPAWN_FAKE_LOG_DIR/curl.log"
out=""
previous=""
url=""
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then
    out="$arg"
  fi
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
  previous="$arg"
done

case "${{SPAWN_FAKE_CURL_MODE:-good}}" in
  fail)
    exit 22
    ;;
  bad)
    [ -n "$out" ] || exit 0
    cat > "$out" <<'BIN'
#!/bin/sh
exit 1
BIN
    chmod 755 "$out"
    ;;
  good|*)
    [ -n "$out" ] || exit 0
    case "$url" in
      */api/install/spawn-worker/*)
        cat > "$out" <<'BIN'
{_fake_worker_body().rstrip()}
BIN
        ;;
      *)
        cat > "$out" <<'BIN'
{_fake_spawnd_body().rstrip()}
BIN
        ;;
    esac
    chmod 755 "$out"
    ;;
esac
""",
    )
    _write_executable(
        fakebin / "git",
        """#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$SPAWN_FAKE_LOG_DIR/git.log"
dest=""
for arg in "$@"; do
  dest="$arg"
done
mkdir -p "$dest/daemon"
""",
    )
    _write_executable(
        fakebin / "cargo",
        f"""#!/bin/sh
set -eu
if [ "${{1:-}}" = "--version" ]; then
  printf 'cargo %s (aaaaaaa 2024-01-01)\\n' "${{SPAWN_FAKE_CARGO_VERSION:-1.86.0}}"
  exit 0
fi
printf '%s\\n' "$*" >> "$SPAWN_FAKE_LOG_DIR/cargo.log"
root=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--root" ]; then
    root="$arg"
    break
  fi
  previous="$arg"
done
[ -n "$root" ] || exit 1
mkdir -p "$root/bin"
cat > "$root/bin/spawnd" <<'BIN'
{_fake_spawnd_body().rstrip()}
BIN
cat > "$root/bin/spawn-worker" <<'BIN'
{_fake_worker_body().rstrip()}
BIN
chmod 755 "$root/bin/spawnd" "$root/bin/spawn-worker"
""",
    )
    _write_executable(
        fakebin / "launchctl",
        """#!/bin/sh
printf '%s\\n' "$*" >> "$SPAWN_FAKE_LOG_DIR/launchctl.log"
if [ "${SPAWN_FAKE_LAUNCHCTL_MODE:-}" = "bootstrap_fail" ] && [ "${1:-}" = "bootstrap" ]; then
  exit 1
fi
exit 0
""",
    )
    _write_executable(
        fakebin / "systemctl",
        """#!/bin/sh
printf '%s\\n' "$*" >> "$SPAWN_FAKE_LOG_DIR/systemctl.log"
if [ "${SPAWN_FAKE_SYSTEMCTL_MODE:-}" = "fail_show" ] && [ "$*" = "--user show-environment" ]; then
  exit 1
fi
exit 0
""",
    )
    _write_executable(
        fakebin / "loginctl",
        """#!/bin/sh
printf '%s\\n' "$*" >> "$SPAWN_FAKE_LOG_DIR/loginctl.log"
case "$*" in
  show-user*" -p Linger --value")
    if [ "${SPAWN_FAKE_LINGER:-no}" = "yes" ]; then
      printf '%s\\n' yes
    else
      printf '%s\\n' no
    fi
    ;;
  enable-linger*)
    if [ "${SPAWN_FAKE_LINGER_ENABLE:-ok}" = "fail" ]; then
      exit 1
    fi
    ;;
esac
exit 0
""",
    )


async def _install_script_file(client, tmp_path: Path) -> Path:
    r = await client.get("/install.sh")
    assert r.status_code == 200
    script = tmp_path / "install.sh"
    script.write_text(r.text, encoding="utf-8")
    return script


def _run_installer(
    script: Path,
    tmp_path: Path,
    *,
    os_name: str,
    arch: str,
    args: list[str] | None = None,
    server: str = "http://spawn.test",
    curl_mode: str = "good",
    install_root_name: str = "install-root",
    extra_env: dict[str, str] | None = None,
    remove_from_path: tuple[str, ...] = (),
    minimal_path: bool = False,
) -> tuple[subprocess.CompletedProcess[str], Path, Path, Path]:
    fakebin = tmp_path / "fakebin"
    logs = tmp_path / "logs"
    home = tmp_path / "home"
    install_root = tmp_path / install_root_name
    tmpdir = tmp_path / "tmp"
    fakebin.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    install_root.mkdir(parents=True, exist_ok=True)
    tmpdir.mkdir(parents=True, exist_ok=True)
    _write_fake_host_commands(fakebin)
    # Simulate a host missing certain tools (e.g. no rustup). minimal_path also
    # drops the system PATH so a real rustup in ~/.cargo/bin can't leak in.
    for name in remove_from_path:
        (fakebin / name).unlink(missing_ok=True)

    env = os.environ.copy()
    path_value = f"{fakebin}:/usr/bin:/bin" if minimal_path else f"{fakebin}:{env['PATH']}"
    env.update(
        {
            "HOME": str(home),
            "PATH": path_value,
            "SPAWN_FAKE_LOG_DIR": str(logs),
            "SPAWN_FAKE_UNAME_S": os_name,
            "SPAWN_FAKE_UNAME_M": arch,
            "SPAWN_FAKE_CURL_MODE": curl_mode,
            "SPAWN_INSTALL_ROOT": str(install_root),
            "TMPDIR": str(tmpdir),
        }
    )
    if extra_env:
        env.update(extra_env)
    command = ["sh", str(script), "--server", server, *(args or [])]
    result = subprocess.run(
        command,
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    return result, logs, home, install_root


def _log(logs: Path, name: str) -> str:
    path = logs / name
    return path.read_text() if path.exists() else ""


class _SmokeInstallHandler(BaseHTTPRequestHandler):
    script = ""

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/install.sh":
            body = self.script.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/x-shellscript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/api/install/spawnd/") or self.path.startswith(
            "/api/install/spawn-worker/"
        ):
            body = (
                _fake_worker_body()
                if self.path.startswith("/api/install/spawn-worker/")
                else _fake_spawnd_body()
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return


def _run_smoke_http_server(script: str) -> tuple[ThreadingHTTPServer, str]:
    _SmokeInstallHandler.script = script
    server = ThreadingHTTPServer(("127.0.0.1", 0), _SmokeInstallHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}"


async def test_install_script_is_shell_and_uses_public_url(client):
    r = await client.get("/install.sh")

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/x-shellscript")
    assert "Cache-Control" in r.headers
    assert r.text.startswith("#!/bin/sh")
    assert "DEFAULT_SERVER=http" in r.text
    assert "/api/install/spawnd/$TARGET" in r.text
    assert "/api/install/spawn-worker/$TARGET" in r.text
    assert "darwin-aarch64" in r.text
    assert "linux-x86_64" in r.text
    assert "__publish-release" in r.text
    assert "https://github.com/levy-street/spawn.git" in r.text
    assert "login --no-run" in r.text
    assert "possess" in r.text
    assert "--prebuilt-only" in r.text
    assert "--setup TOKEN" in r.text
    assert "--new-account" in r.text


async def test_manifest_and_signature_are_served_byte_exact_with_no_store(
    client, tmp_path: Path, monkeypatch
):
    from spawn_server import release

    repo = tmp_path / "signed-prebuilt"
    prebuilt = repo / "daemon" / "target" / "prebuilt"
    target = prebuilt / "linux-x86_64"
    target.mkdir(parents=True)
    spawnd = b"signed-spawnd"
    worker = b"signed-worker"
    (target / "spawnd").write_bytes(spawnd)
    (target / "spawn-worker").write_bytes(worker)
    manifest_bytes = (
        json.dumps(
            {
                "commit": "a" * 40,
                "tree": "b" * 40,
                "version": "0.2.0+gaaaaaaaaaaaa",
                "release_counter": 1234,
                "signing_key_id": "e65c013f",
                "targets": {
                    "linux-x86_64": {
                        "spawnd_sha256": hashlib.sha256(spawnd).hexdigest(),
                        "spawn_worker_sha256": hashlib.sha256(worker).hexdigest(),
                    }
                },
            },
            separators=(",", ":"),
        ).encode()
        + b"\n"
    )
    signature = b"detached-signature-without-newline"
    (prebuilt / "manifest.json").write_bytes(manifest_bytes)
    (prebuilt / "manifest.json.sig").write_bytes(signature)
    monkeypatch.setattr(install_routes, "_repo_root", lambda: repo)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)

    manifest = await client.get("/api/install/manifest.json")
    assert manifest.status_code == 200
    assert manifest.content == manifest_bytes
    assert manifest.headers["content-type"].startswith("application/json")
    assert manifest.headers["cache-control"] == "no-store"
    sig = await client.get("/api/install/manifest.json.sig")
    assert sig.status_code == 200
    assert sig.content == signature
    assert sig.headers["content-type"].startswith("text/plain")
    assert sig.headers["cache-control"] == "no-store"

    (target / "spawn-worker").write_bytes(b"corrupt")
    release.refresh()
    assert (await client.get("/api/install/manifest.json")).status_code == 404
    # Detached bytes have their own absence rule; diagnostics can still fetch
    # the signature even while the manifest fails binary/hash validation.
    assert (await client.get("/api/install/manifest.json.sig")).content == signature


@requires_posix_shell
async def test_installer_smoke_uses_real_curl_against_local_http_server(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)
    server, base_url = _run_smoke_http_server(script.read_text())
    fakebin = tmp_path / "smoke-fakebin"
    logs = tmp_path / "smoke-logs"
    install_root = tmp_path / "smoke-install"
    fakebin.mkdir()
    logs.mkdir()
    install_root.mkdir()

    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fakebin}:{env['PATH']}",
            "SPAWN_INSTALL_ROOT": str(install_root),
            "SPAWN_FAKE_LOG_DIR": str(logs),
        }
    )

    try:
        result = subprocess.run(
            [
                "sh",
                str(script),
                "--server",
                base_url,
                "--no-login",
                "--no-start",
                "--no-service",
                "--prebuilt-only",
            ],
            env=env,
            text=True,
            capture_output=True,
            timeout=20,
            check=False,
        )
    finally:
        server.shutdown()
        server.server_close()

    assert result.returncode == 0, result.stderr
    assert "downloading prebuilt spawnd" in result.stdout
    assert "spawn-worker" in result.stdout
    assert "installed spawnd fake 1.0" in result.stdout
    assert "skipping login" in result.stdout
    _assert_published_layout(install_root)


def _assert_published_layout(install_root: Path) -> None:
    """The contract every install leaves behind: an immutable release
    directory holding the pair, and `bin/` pointing into it. The shell never
    writes a binary into `bin/` itself."""
    release = install_root / FAKE_RELEASE
    assert (release / "spawnd").is_file()
    assert (release / "spawn-worker").is_file()
    for name in ("spawnd", "spawn-worker"):
        link = install_root / "bin" / name
        assert link.is_symlink(), f"{link} must be a link into the release store"
        assert link.resolve() == (release / name).resolve()


async def test_install_script_never_writes_binaries_into_bin_itself(client):
    # The 2026-09-09 incident: the installer's two `mv`s into ~/.local/bin
    # replaced the pair under a running daemon of another account. The shell
    # now downloads into scratch and hands the pair to spawnd, which publishes
    # it as an immutable release and points bin/ at it — or leaves bin/ alone
    # while a daemon still starts from it.
    r = await client.get("/install.sh")
    script = r.text
    assert 'mv "$TMP_BIN" "$BIN"' not in script
    assert 'mv "$TMP_WORKER" "$WORKER_BIN"' not in script
    assert '--root "$INSTALL_ROOT"' not in script
    assert '__publish-release --install-root "$INSTALL_ROOT"' in script
    # The old shared-pair unit generators are gone; possess owns the service.
    assert "start_systemd_service" not in script
    assert "start_launchd_service" not in script
    # Everything after the download runs the published release.
    assert 'exec_attached "$RUN_BIN" --server "$SERVER" possess' in script
    assert 'exec_attached "$BIN"' not in script


async def test_unsupported_daemon_binary_target_404(client):
    r = await client.get("/api/install/spawnd/plan9-riscv")

    assert r.status_code == 404
    assert r.json()["detail"] == "unsupported daemon target"


async def test_install_script_pins_prebuilt_sha256(client, tmp_path: Path, monkeypatch):
    # A present prebuilt gets its sha256 templated into the script so the
    # installer verifies the download; a target with no prebuilt emits no pin.
    repo = tmp_path / "repo-with-prebuilt"
    prebuilt = repo / "daemon" / "target" / "prebuilt" / "darwin-aarch64"
    prebuilt.mkdir(parents=True)
    (prebuilt / "spawnd").write_bytes(b"fake-spawnd")
    (prebuilt / "spawn-worker").write_bytes(b"fake-worker")
    monkeypatch.setattr(install_routes, "_repo_root", lambda: repo)

    want_spawnd = hashlib.sha256(b"fake-spawnd").hexdigest()
    want_worker = hashlib.sha256(b"fake-worker").hexdigest()

    r = await client.get("/install.sh")

    assert r.status_code == 200
    assert f"spawnd:darwin-aarch64) printf %s {want_spawnd} ;;" in r.text
    assert f"spawn-worker:darwin-aarch64) printf %s {want_worker} ;;" in r.text
    assert "linux-x86_64) printf" not in r.text  # not staged → not pinned


async def test_install_script_uses_valid_manifest_hashes(client, tmp_path: Path, monkeypatch):
    from spawn_server import release

    repo = tmp_path / "repo-with-manifest"
    prebuilt = repo / "daemon" / "target" / "prebuilt"
    target = prebuilt / "linux-x86_64"
    target.mkdir(parents=True)
    spawnd = b"manifest-spawnd"
    worker = b"manifest-worker"
    (target / "spawnd").write_bytes(spawnd)
    (target / "spawn-worker").write_bytes(worker)
    spawnd_sha = hashlib.sha256(spawnd).hexdigest()
    worker_sha = hashlib.sha256(worker).hexdigest()
    (prebuilt / "manifest.json").write_text(
        json.dumps(
            {
                "commit": "c" * 40,
                "tree": "d" * 40,
                "version": "0.2.0+gcccccccccccc",
                "targets": {
                    "linux-x86_64": {
                        "spawnd_sha256": spawnd_sha,
                        "spawn_worker_sha256": worker_sha,
                    }
                },
            }
        )
    )
    monkeypatch.setattr(install_routes, "_repo_root", lambda: repo)
    monkeypatch.setattr(
        install_routes,
        "_sha256_file",
        lambda path: (_ for _ in ()).throw(AssertionError("fallback hashing used")),
    )
    release.refresh()

    response = await client.get("/install.sh")

    assert response.status_code == 200
    assert f"spawnd:linux-x86_64) printf %s {spawnd_sha} ;;" in response.text
    assert f"spawn-worker:linux-x86_64) printf %s {worker_sha} ;;" in response.text


@pytest.mark.parametrize(
    ("os_name", "arch", "target"),
    [
        ("Darwin", "arm64", "darwin-aarch64"),
        ("Darwin", "x86_64", "darwin-x86_64"),
        ("Linux", "x86_64", "linux-x86_64"),
        ("Linux", "aarch64", "linux-aarch64"),
    ],
)
@requires_posix_shell
async def test_installer_downloads_prebuilt_for_supported_targets(
    client, tmp_path: Path, os_name: str, arch: str, target: str
):
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, install_root = _run_installer(
        script,
        tmp_path,
        os_name=os_name,
        arch=arch,
        args=["--no-login", "--no-start", "--no-service", "--prebuilt-only"],
    )

    assert result.returncode == 0, result.stderr
    assert f"downloading prebuilt spawnd + spawn-worker for {target}" in result.stdout
    assert f"/api/install/spawnd/{target}" in _log(logs, "curl.log")
    assert f"/api/install/spawn-worker/{target}" in _log(logs, "curl.log")
    # The downloaded pair is handed to spawnd to publish; the shell writes
    # nothing into bin/ and the download never lands there.
    assert f"__publish-release --install-root {install_root}" in _log(logs, "spawnd.log")
    assert not (install_root / "bin" / "spawnd.tmp.").exists()
    _assert_published_layout(install_root)
    assert f"release: {install_root / FAKE_RELEASE}" in result.stdout
    assert _log(logs, "git.log") == ""
    assert _log(logs, "cargo.log") == ""
    assert "skipping login" in result.stdout


@requires_posix_shell
async def test_installer_prebuilt_only_fails_without_source_fallback(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, _install_root = _run_installer(
        script,
        tmp_path,
        os_name="Linux",
        arch="x86_64",
        args=["--no-login", "--prebuilt-only"],
        curl_mode="bad",
    )

    assert result.returncode != 0
    assert "prebuilt daemon unavailable for this host" in result.stderr
    assert _log(logs, "git.log") == ""
    assert _log(logs, "cargo.log") == ""


@requires_posix_shell
async def test_installer_bad_prebuilt_falls_back_to_source_build(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, install_root = _run_installer(
        script,
        tmp_path,
        os_name="Linux",
        arch="x86_64",
        args=["--no-login", "--no-start", "--no-service"],
        curl_mode="bad",
    )

    assert result.returncode == 0, result.stderr
    assert "prebuilt daemon is not compatible with this host" in result.stdout
    assert "prebuilt daemon unavailable; falling back to source build" in result.stdout
    assert "clone --depth 1 --branch master https://github.com/levy-street/spawn.git" in _log(
        logs, "git.log"
    )
    assert "install --path" in _log(logs, "cargo.log")
    # A source build installs into scratch and is published from there; the
    # `--root` cargo is given is never the install root.
    assert f"--root {install_root}" not in _log(logs, "cargo.log")
    assert f"__publish-release --install-root {install_root}" in _log(logs, "spawnd.log")
    _assert_published_layout(install_root)


@requires_posix_shell
async def test_installer_refreshes_rust_via_rustup_before_source_build(client, tmp_path: Path):
    # With rustup available, the installer brings stable current before the
    # --locked source build, so a lagging toolchain — too old for the lock file
    # (format v4) or a dependency's rising MSRV (home 0.5.12 wants rustc 1.88) —
    # can't break the build. 1.86 reads the lock file fine but fails that MSRV.
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, install_root = _run_installer(
        script,
        tmp_path,
        os_name="Darwin",
        arch="aarch64",
        args=["--no-login", "--no-start", "--no-service"],
        curl_mode="bad",  # force the source build
        extra_env={"SPAWN_FAKE_CARGO_VERSION": "1.86.0"},
    )

    assert result.returncode == 0, result.stderr
    assert "ensuring a current Rust toolchain" in result.stdout
    assert "update stable" in _log(logs, "rustup.log")
    assert (install_root / "bin" / "spawnd").is_file()


@requires_posix_shell
async def test_installer_without_rustup_stops_on_too_old_cargo(client, tmp_path: Path):
    # No rustup to self-update: an existing cargo below the floor must stop with
    # guidance, not crash mid-build on a lock file / MSRV it can't satisfy.
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, install_root = _run_installer(
        script,
        tmp_path,
        os_name="Darwin",
        arch="aarch64",
        args=["--no-login", "--no-start", "--no-service"],
        curl_mode="bad",
        extra_env={"SPAWN_FAKE_CARGO_VERSION": "1.86.0"},
        remove_from_path=("rustup",),
        minimal_path=True,
    )

    assert result.returncode != 0
    assert "too old" in result.stderr
    assert "install --path" not in _log(logs, "cargo.log")
    assert not (install_root / "bin" / "spawnd").is_file()


@requires_posix_shell
async def test_installer_default_runs_possess_on_linux(client, tmp_path: Path):
    # The default install hands off to `spawnd possess`, which owns login + the
    # supervised background service. That systemd/launchd setup lives in the
    # daemon now (tested in daemon/src/service.rs), so the installer no longer
    # drives the service manager itself.
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, _install_root = _run_installer(
        script,
        tmp_path,
        os_name="Linux",
        arch="x86_64",
    )

    assert result.returncode == 0, result.stderr
    assert "--server http://spawn.test possess" in _log(logs, "spawnd.log")
    assert _log(logs, "systemctl.log") == ""


@requires_posix_shell
async def test_installer_default_runs_possess_on_macos(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, _install_root = _run_installer(
        script,
        tmp_path,
        os_name="Darwin",
        arch="arm64",
    )

    assert result.returncode == 0, result.stderr
    assert "--server http://spawn.test possess" in _log(logs, "spawnd.log")
    assert _log(logs, "launchctl.log") == ""


@requires_posix_shell
async def test_installer_accepts_and_ignores_legacy_setup_flags(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)
    token = "S" * 43
    notice = (
        "SPAWN D: the --setup flag is no longer needed; "
        "approval happens through the link spawnd prints"
    )

    default, logs, _home, _install_root = _run_installer(
        script,
        tmp_path / "claimed",
        os_name="Linux",
        arch="x86_64",
        args=["--setup", token, "--new-account"],
        extra_env={"SPAWN_SETUP_TOKEN": token},
    )
    assert default.returncode == 0, default.stderr
    assert notice in default.stdout
    assert "--server http://spawn.test possess --new-account" in _log(logs, "spawnd.log")
    assert _log(logs, "setup-token.log") == ""

    equals, equals_logs, _home, _install_root = _run_installer(
        script,
        tmp_path / "claimed-equals",
        os_name="Linux",
        arch="x86_64",
        args=[f"--setup={token}"],
    )
    assert equals.returncode == 0, equals.stderr
    assert notice in equals.stdout
    assert "--server http://spawn.test possess" in _log(equals_logs, "spawnd.log")
    assert _log(equals_logs, "setup-token.log") == ""

    empty, _logs, _home, _install_root = _run_installer(
        script,
        tmp_path / "claimed-empty",
        os_name="Linux",
        arch="x86_64",
        args=["--setup", ""],
    )
    assert empty.returncode != 0
    assert "--setup requires a token" in empty.stderr


@requires_posix_shell
async def test_installer_replaces_existing_binary_on_reinstall(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)
    install_root = tmp_path / "install-root"
    bin_dir = install_root / "bin"
    bin_dir.mkdir(parents=True)
    _write_executable(
        bin_dir / "spawnd",
        "#!/bin/sh\nprintf '%s\\n' 'old spawnd'\nexit 0\n",
    )
    _write_executable(
        bin_dir / "spawn-worker",
        "#!/bin/sh\nprintf '%s\\n' 'old spawn-worker'\nexit 0\n",
    )

    first, _logs, _home, install_root = _run_installer(
        script,
        tmp_path,
        os_name="Linux",
        arch="x86_64",
        args=["--no-login", "--no-start", "--no-service", "--prebuilt-only"],
    )
    assert first.returncode == 0, first.stderr
    assert "installed spawnd fake 1.0" in first.stdout
    assert "old spawnd" not in first.stdout
    assert "old spawn-worker" not in (bin_dir / "spawn-worker").read_text()
    # It is spawnd that decided the old pair could go (nothing launches from
    # it in this fixture); the shell only ever hands the new pair over.
    _assert_published_layout(install_root)

    second, _logs, _home, _install_root = _run_installer(
        script,
        tmp_path,
        os_name="Linux",
        arch="x86_64",
        args=["--no-login", "--no-start", "--no-service", "--prebuilt-only"],
    )

    assert second.returncode == 0, second.stderr
    assert "installed spawnd fake 1.0" in second.stdout


@requires_posix_shell
async def test_installer_start_flags_control_login_and_services(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)

    no_start, no_start_logs, _home, _install_root = _run_installer(
        script,
        tmp_path / "no-start",
        os_name="Linux",
        arch="x86_64",
        args=["--no-start"],
    )
    assert no_start.returncode == 0, no_start.stderr
    assert "login complete; not starting daemon because --no-start was set" in no_start.stdout
    assert "login --no-run" in _log(no_start_logs, "spawnd.log")
    assert _log(no_start_logs, "systemctl.log") == ""

    foreground, foreground_logs, _home, _install_root = _run_installer(
        script,
        tmp_path / "foreground",
        os_name="Linux",
        arch="x86_64",
        args=["--foreground"],
    )
    assert foreground.returncode == 0, foreground.stderr
    assert "--server http://spawn.test run" in _log(foreground_logs, "spawnd.log")
    assert _log(foreground_logs, "systemctl.log") == ""

    no_service, no_service_logs, _home, _install_root = _run_installer(
        script,
        tmp_path / "no-service",
        os_name="Linux",
        arch="x86_64",
        args=["--no-service"],
    )
    assert no_service.returncode == 0, no_service.stderr
    assert "started spawnd in the background" in no_service.stdout
    assert _log(no_service_logs, "systemctl.log") == ""


async def test_daemon_binary_serves_supported_target(client, tmp_path: Path, monkeypatch):
    binary = tmp_path / "spawnd"
    binary.write_bytes(b"fake-daemon")
    monkeypatch.setattr(install_routes, "_binary_candidates", lambda target, name: [binary])

    r = await client.get("/api/install/spawnd/linux-x86_64")

    assert r.status_code == 200
    assert r.content == b"fake-daemon"
    assert r.headers["content-type"].startswith("application/octet-stream")
    assert 'filename="spawnd"' in r.headers["content-disposition"]
    assert r.headers["cache-control"] == "no-store"


async def test_worker_binary_serves_supported_target(client, tmp_path: Path, monkeypatch):
    binary = tmp_path / "spawn-worker"
    binary.write_bytes(b"fake-worker")
    monkeypatch.setattr(install_routes, "_binary_candidates", lambda target, name: [binary])

    r = await client.get("/api/install/spawn-worker/linux-x86_64")

    assert r.status_code == 200
    assert r.content == b"fake-worker"
    assert 'filename="spawn-worker"' in r.headers["content-disposition"]


async def test_daemon_binary_supported_target_missing_binary_404(
    client, tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(
        install_routes, "_binary_candidates", lambda target, name: [tmp_path / "missing"]
    )

    r = await client.get("/api/install/spawnd/linux-x86_64")

    assert r.status_code == 404
    assert r.json()["detail"] == "daemon binary is not available for linux-x86_64"


def test_binary_candidates_include_local_release_fallback(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(install_routes, "_repo_root", lambda: tmp_path)
    monkeypatch.setattr(install_routes, "_local_target", lambda: "linux-x86_64")

    local_paths = install_routes._binary_candidates("linux-x86_64", "spawn-worker")
    remote_paths = install_routes._binary_candidates("linux-aarch64", "spawn-worker")

    assert (
        tmp_path / "daemon" / "target" / "prebuilt" / "linux-x86_64" / "spawn-worker" in local_paths
    )
    assert (
        tmp_path / "daemon" / "target" / "x86_64-unknown-linux-gnu" / "release" / "spawn-worker"
        in local_paths
    )
    assert tmp_path / "daemon" / "target" / "release" / "spawn-worker" in local_paths
    assert tmp_path / "daemon" / "target" / "release" / "spawn-worker" not in remote_paths


def test_variant_binary_candidates_follow_the_cargo_profile(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(install_routes, "_repo_root", lambda: tmp_path)
    monkeypatch.setattr(install_routes, "_local_target", lambda: "linux-x86_64")

    local = install_routes._binary_candidates("linux-x86_64", "spawnd", "diagnostics")
    remote = install_routes._binary_candidates("linux-aarch64", "spawnd", "diagnostics")

    assert local == [
        tmp_path / "daemon" / "target" / "prebuilt" / "linux-x86_64" / "diagnostics" / "spawnd",
        tmp_path / "daemon" / "target" / "x86_64-unknown-linux-gnu" / "diagnostics" / "spawnd",
        tmp_path / "daemon" / "target" / "diagnostics" / "spawnd",
    ]
    assert remote == [
        tmp_path / "daemon" / "target" / "prebuilt" / "linux-aarch64" / "diagnostics" / "spawnd",
        tmp_path / "daemon" / "target" / "aarch64-unknown-linux-gnu" / "diagnostics" / "spawnd",
    ]
    # The release pair's candidates are unchanged by the variant beside them.
    assert install_routes._binary_candidates("linux-x86_64", "spawnd") == [
        tmp_path / "daemon" / "target" / "prebuilt" / "linux-x86_64" / "spawnd",
        tmp_path / "daemon" / "target" / "x86_64-unknown-linux-gnu" / "release" / "spawnd",
        tmp_path / "daemon" / "target" / "release" / "spawnd",
    ]


async def test_variant_routes_serve_the_published_pair_under_the_plain_names(
    client, tmp_path: Path, monkeypatch
):
    target = tmp_path / "daemon" / "target" / "prebuilt" / "linux-x86_64"
    (target / "diagnostics").mkdir(parents=True)
    (target / "spawnd").write_bytes(b"release-daemon")
    (target / "spawn-worker").write_bytes(b"release-worker")
    (target / "diagnostics" / "spawnd").write_bytes(b"diagnostics-daemon")
    (target / "diagnostics" / "spawn-worker").write_bytes(b"diagnostics-worker")
    monkeypatch.setattr(install_routes, "_repo_root", lambda: tmp_path)

    daemon = await client.get("/api/install/spawnd/linux-x86_64/diagnostics")
    worker = await client.get("/api/install/spawn-worker/linux-x86_64/diagnostics")

    assert daemon.status_code == 200
    assert daemon.content == b"diagnostics-daemon"
    assert daemon.headers["content-type"].startswith("application/octet-stream")
    assert 'filename="spawnd"' in daemon.headers["content-disposition"]
    assert daemon.headers["cache-control"] == "no-store"
    assert worker.status_code == 200
    assert worker.content == b"diagnostics-worker"
    assert 'filename="spawn-worker"' in worker.headers["content-disposition"]
    # The release routes still hand out the release pair, not the variant.
    assert (await client.get("/api/install/spawnd/linux-x86_64")).content == b"release-daemon"
    assert (await client.get("/api/install/spawn-worker/linux-x86_64")).content == b"release-worker"


async def test_variant_routes_fail_closed(client, tmp_path: Path, monkeypatch):
    target = tmp_path / "daemon" / "target" / "prebuilt" / "linux-x86_64"
    target.mkdir(parents=True)
    (target / "spawnd").write_bytes(b"release-daemon")
    monkeypatch.setattr(install_routes, "_repo_root", lambda: tmp_path)

    # A published release pair is never served in place of an absent variant.
    missing = await client.get("/api/install/spawnd/linux-x86_64/diagnostics")
    assert missing.status_code == 404
    assert missing.json()["detail"] == "diagnostics daemon binary is not available for linux-x86_64"

    unknown = await client.get("/api/install/spawnd/linux-x86_64/debug")
    assert unknown.status_code == 404
    assert unknown.json()["detail"] == "unsupported daemon variant"

    bad_target = await client.get("/api/install/spawn-worker/linux-riscv64/diagnostics")
    assert bad_target.status_code == 404
    assert bad_target.json()["detail"] == "unsupported worker target"


def test_windows_binary_candidates_keep_exe_and_unix_candidates_do_not(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(install_routes, "_repo_root", lambda: tmp_path)
    monkeypatch.setattr(install_routes, "_local_target", lambda: "windows-x86_64")

    windows = install_routes._binary_candidates("windows-x86_64", "spawnd")
    linux = install_routes._binary_candidates("linux-x86_64", "spawnd")

    assert windows == [
        tmp_path / "daemon" / "target" / "prebuilt" / "windows-x86_64" / "spawnd.exe",
        tmp_path / "daemon" / "target" / "x86_64-pc-windows-msvc" / "release" / "spawnd.exe",
        tmp_path / "daemon" / "target" / "release" / "spawnd.exe",
    ]
    assert all(path.name == "spawnd" for path in linux)


async def test_windows_binary_routes_serve_exe_names(client, tmp_path: Path, monkeypatch):
    target = tmp_path / "daemon" / "target" / "prebuilt" / "windows-x86_64"
    target.mkdir(parents=True)
    (target / "spawnd.exe").write_bytes(b"windows-daemon")
    (target / "spawn-worker.exe").write_bytes(b"windows-worker")
    monkeypatch.setattr(install_routes, "_repo_root", lambda: tmp_path)

    daemon = await client.get("/api/install/spawnd/windows-x86_64")
    worker = await client.get("/api/install/spawn-worker/windows-x86_64")

    assert daemon.status_code == 200
    assert daemon.content == b"windows-daemon"
    assert 'filename="spawnd.exe"' in daemon.headers["content-disposition"]
    assert daemon.headers["cache-control"] == "no-store"
    assert worker.status_code == 200
    assert worker.content == b"windows-worker"
    assert 'filename="spawn-worker.exe"' in worker.headers["content-disposition"]
    assert worker.headers["cache-control"] == "no-store"


async def test_windows_binary_route_rejects_extensionless_staging(
    client, tmp_path: Path, monkeypatch
):
    target = tmp_path / "daemon" / "target" / "prebuilt" / "windows-x86_64"
    target.mkdir(parents=True)
    (target / "spawnd").write_bytes(b"wrong-name")
    monkeypatch.setattr(install_routes, "_repo_root", lambda: tmp_path)

    response = await client.get("/api/install/spawnd/windows-x86_64")

    assert response.status_code == 404


def test_local_target_recognizes_native_windows_x86_64(monkeypatch):
    monkeypatch.setattr(install_routes.sys, "platform", "win32")
    monkeypatch.setattr("platform.machine", lambda: "AMD64")

    assert install_routes._local_target() == "windows-x86_64"


async def test_install_powershell_is_fail_closed_without_windows_release(client, monkeypatch):
    monkeypatch.setattr(install_routes, "_windows_prebuilt_hashes", lambda: None)

    powershell = await client.get("/install.ps1")
    shell = await client.get("/install.sh")

    assert powershell.status_code == 503
    assert shell.status_code == 200


async def test_install_powershell_renders_hash_pinned_script(client, monkeypatch):
    spawnd_sha = "A" * 64
    worker_sha = "B" * 64
    manifest = SimpleNamespace(
        targets={
            "windows-x86_64": SimpleNamespace(
                spawnd_sha256=spawnd_sha,
                spawn_worker_sha256=worker_sha,
            )
        }
    )
    monkeypatch.setattr(
        install_routes.release,
        "read_prebuilt_manifest",
        lambda **_kwargs: manifest,
    )
    monkeypatch.setattr(
        install_routes.get_settings(),
        "public_url",
        "https://spawn.test/team/o'hara/",
    )

    response = await client.get("/install.ps1")
    shell = await client.get("/install.sh")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert response.headers["cache-control"] == "no-store"
    assert "$DefaultServer = 'https://spawn.test/team/o''hara'" in response.text
    # Windows publishes through spawnd too, and no longer stops every instance's
    # daemon to make room for a file rename.
    assert "__publish-release --install-root $InstallRoot --json" in response.text
    assert "Install-Pair" not in response.text
    assert "disconnect" not in response.text
    assert "Assert-Sha256 $releaseSpawnd $PinnedSpawndSha256" in response.text
    assert f"$PinnedSpawndSha256 = '{spawnd_sha.lower()}'" in response.text
    assert f"$PinnedWorkerSha256 = '{worker_sha.lower()}'" in response.text
    assert "__DEFAULT_SERVER__" not in response.text
    assert "__WINDOWS_X86_64_" not in response.text
    for parameter in (
        "$Server",
        "$Repo",
        "$Branch",
        "$NewAccount",
        "$NoService",
        "$Foreground",
        "$PrebuiltOnly",
        "$NoLogin",
        "$NoStart",
        "$Setup",
    ):
        assert parameter in response.text
    assert "-Repo and -Branch are Unix source-build options" in response.text
    assert "& $spawndPath --server $Server possess" in response.text
    assert "Unblock-File -LiteralPath $stagedSpawnd" in response.text
    assert "[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')" in response.text
    assert "$spawnPlatformIsWindows" in response.text
    assigned_variables = {
        match.group(1).casefold()
        for match in re.finditer(r"(?mi)^\s*\$([a-z_][a-z0-9_]*)\s*=", response.text)
    }
    readonly_automatic_variables = {
        "args",
        "error",
        "foreach",
        "home",
        "host",
        "input",
        "iscoreclr",
        "islinux",
        "ismacos",
        "iswindows",
        "matches",
        "myinvocation",
        "nestedpromptlevel",
        "null",
        "pid",
        "psedition",
        "pshome",
        "psversiontable",
        "pwd",
        "shellid",
        "stacktrace",
        "this",
        "true",
        "false",
    }
    assert assigned_variables.isdisjoint(readonly_automatic_variables)
    assert f"spawnd:windows-x86_64) printf %s {spawnd_sha.lower()} ;;" in shell.text
    assert f"spawn-worker:windows-x86_64) printf %s {worker_sha.lower()} ;;" in shell.text


@requires_posix_shell
@pytest.mark.parametrize("os_name", ["MINGW_NT-10.0", "MSYS_NT-10.0", "CYGWIN_NT-10.0"])
async def test_shell_installer_redirects_native_windows_without_source_fallback(
    client, tmp_path: Path, os_name: str
):
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, _install_root = _run_installer(
        script,
        tmp_path,
        os_name=os_name,
        arch="x86_64",
    )

    assert result.returncode != 0
    assert (
        "native Windows uses PowerShell: irm http://spawn.test/install.ps1 | iex" in result.stderr
    )
    assert _log(logs, "git.log") == ""
    assert _log(logs, "cargo.log") == ""
