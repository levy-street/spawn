"""Hosted daemon installer."""

from __future__ import annotations

import os
import stat
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from spawn_server.routes import install as install_routes


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _fake_spawnd_body() -> str:
    return """#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$SPAWN_FAKE_LOG_DIR/spawnd.log"
if [ "${1:-}" = "--version" ]; then
  printf '%s\\n' "${SPAWN_FAKE_SPAWND_VERSION:-spawnd fake 1.0}"
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
    script.write_text(r.text)
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

    env = os.environ.copy()
    env.update(
        {
            "HOME": str(home),
            "PATH": f"{fakebin}:{env['PATH']}",
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
    assert "start_launchd_service" in r.text
    assert "https://github.com/levy-street/spawn.git" in r.text
    assert 'login --no-run' in r.text
    assert "spawnd.service" in r.text
    assert "--prebuilt-only" in r.text


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
    assert (install_root / "bin" / "spawnd").is_file()
    assert (install_root / "bin" / "spawn-worker").is_file()


async def test_unsupported_daemon_binary_target_404(client):
    r = await client.get("/api/install/spawnd/plan9-riscv")

    assert r.status_code == 404
    assert r.json()["detail"] == "unsupported daemon target"


@pytest.mark.parametrize(
    ("os_name", "arch", "target"),
    [
        ("Darwin", "arm64", "darwin-aarch64"),
        ("Darwin", "x86_64", "darwin-x86_64"),
        ("Linux", "x86_64", "linux-x86_64"),
        ("Linux", "aarch64", "linux-aarch64"),
    ],
)
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
    assert (install_root / "bin" / "spawnd").is_file()
    assert (install_root / "bin" / "spawn-worker").is_file()
    assert _log(logs, "git.log") == ""
    assert _log(logs, "cargo.log") == ""
    assert "skipping login" in result.stdout


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
    assert (install_root / "bin" / "spawnd").is_file()
    assert (install_root / "bin" / "spawn-worker").is_file()


async def test_installer_writes_and_starts_macos_launchagent(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)
    server = 'http://spawn.test/?a=1&b="<tag>'

    result, logs, home, install_root = _run_installer(
        script,
        tmp_path,
        os_name="Darwin",
        arch="arm64",
        server=server,
        install_root_name="install & root",
    )

    assert result.returncode == 0, result.stderr
    plist = home / "Library" / "LaunchAgents" / "app.spawn.spawnd.plist"
    assert plist.is_file()
    text = plist.read_text()
    assert "<key>ProgramArguments</key>" in text
    assert f"<string>{install_root}/bin/spawnd</string>".replace("&", "&amp;") in text
    assert "<string>--server</string>" in text
    assert "<string>http://spawn.test/?a=1&amp;b=&quot;&lt;tag&gt;</string>" in text
    assert "<key>RunAtLoad</key>" in text
    assert "<key>KeepAlive</key>" in text
    assert "<true/>" in text
    assert "bootstrap" in _log(logs, "launchctl.log")
    assert "kickstart -k" in _log(logs, "launchctl.log")
    assert "--server" in _log(logs, "spawnd.log")
    assert "login --no-run" in _log(logs, "spawnd.log")


async def test_installer_launchd_falls_back_to_load_when_bootstrap_fails(
    client, tmp_path: Path
):
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, _install_root = _run_installer(
        script,
        tmp_path,
        os_name="Darwin",
        arch="arm64",
        extra_env={"SPAWN_FAKE_LAUNCHCTL_MODE": "bootstrap_fail"},
    )

    assert result.returncode == 0, result.stderr
    launchctl_log = _log(logs, "launchctl.log")
    assert "bootstrap" in launchctl_log
    assert "load" in launchctl_log
    assert "kickstart -k" in launchctl_log
    assert "started LaunchAgent app.spawn.spawnd" in result.stdout


async def test_installer_writes_and_starts_linux_systemd_user_service(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)

    result, logs, home, install_root = _run_installer(
        script,
        tmp_path,
        os_name="Linux",
        arch="x86_64",
        install_root_name="install root",
    )

    assert result.returncode == 0, result.stderr
    unit = home / ".config" / "systemd" / "user" / "spawnd.service"
    assert unit.is_file()
    text = unit.read_text()
    assert (
        'ExecStart="' + str(install_root / "bin" / "spawnd") + '" --server "http://spawn.test" run'
        in text
    )
    assert "Restart=always" in text
    assert "RestartSec=2" in text
    assert "KillMode=process" in text
    assert "Delegate=yes" in text
    assert 'Environment="PATH=' in text
    systemctl_log = _log(logs, "systemctl.log")
    assert "--user show-environment" in systemctl_log
    assert "--user daemon-reload" in systemctl_log
    assert "--user enable --now spawnd.service" in systemctl_log
    assert "show-user" in _log(logs, "loginctl.log")
    assert "enable-linger" in _log(logs, "loginctl.log")
    assert "enabled systemd linger" in result.stdout


async def test_installer_does_not_reenable_existing_systemd_linger(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, _install_root = _run_installer(
        script,
        tmp_path,
        os_name="Linux",
        arch="x86_64",
        extra_env={"SPAWN_FAKE_LINGER": "yes"},
    )

    assert result.returncode == 0, result.stderr
    loginctl_log = _log(logs, "loginctl.log")
    assert "show-user" in loginctl_log
    assert "enable-linger" not in loginctl_log


async def test_installer_warns_when_systemd_linger_cannot_be_enabled(client, tmp_path: Path):
    script = await _install_script_file(client, tmp_path)

    result, logs, _home, _install_root = _run_installer(
        script,
        tmp_path,
        os_name="Linux",
        arch="x86_64",
        extra_env={"SPAWN_FAKE_LINGER_ENABLE": "fail"},
    )

    assert result.returncode == 0, result.stderr
    assert "enable-linger" in _log(logs, "loginctl.log")
    assert "systemd linger is not enabled" in result.stdout


async def test_installer_falls_back_to_background_when_user_systemd_unavailable(
    client, tmp_path: Path
):
    script = await _install_script_file(client, tmp_path)

    result, logs, home, _install_root = _run_installer(
        script,
        tmp_path,
        os_name="Linux",
        arch="x86_64",
        extra_env={"SPAWN_FAKE_SYSTEMCTL_MODE": "fail_show"},
    )

    assert result.returncode == 0, result.stderr
    assert "started spawnd in the background" in result.stdout
    assert "--user show-environment" in _log(logs, "systemctl.log")
    assert "--user daemon-reload" not in _log(logs, "systemctl.log")
    assert not (home / ".config" / "systemd" / "user" / "spawnd.service").exists()


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

    second, _logs, _home, _install_root = _run_installer(
        script,
        tmp_path,
        os_name="Linux",
        arch="x86_64",
        args=["--no-login", "--no-start", "--no-service", "--prebuilt-only"],
    )

    assert second.returncode == 0, second.stderr
    assert "installed spawnd fake 1.0" in second.stdout


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


async def test_daemon_binary_supported_target_missing_binary_404(client, tmp_path: Path, monkeypatch):
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
        tmp_path / "daemon" / "target" / "prebuilt" / "linux-x86_64" / "spawn-worker"
        in local_paths
    )
    assert (
        tmp_path
        / "daemon"
        / "target"
        / "x86_64-unknown-linux-gnu"
        / "release"
        / "spawn-worker"
        in local_paths
    )
    assert tmp_path / "daemon" / "target" / "release" / "spawn-worker" in local_paths
    assert tmp_path / "daemon" / "target" / "release" / "spawn-worker" not in remote_paths
