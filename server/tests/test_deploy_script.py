"""Production deploy script behavior with real temp git repos and fake SSH."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = REPO_ROOT / "scripts" / "deploy-prod.sh"


def _run(cmd: list[str], cwd: Path, **kwargs) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
        **kwargs,
    )


def _git(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    result = _run(["git", *cmd], cwd)
    assert result.returncode == 0, result.stderr
    return result


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _init_repo(tmp_path: Path) -> tuple[Path, Path, Path]:
    origin = tmp_path / "origin.git"
    local = tmp_path / "local"
    remote = tmp_path / "remote"

    # Pin the bare repo's HEAD: with an unset init.defaultBranch the machine
    # default may be "main", leaving clones of this master-only origin
    # branchless (and the remote deploy step on an unborn HEAD).
    assert (
        _run(
            ["git", "init", "--bare", "--initial-branch=master", str(origin)], tmp_path
        ).returncode
        == 0
    )
    assert _run(["git", "clone", str(origin), str(local)], tmp_path).returncode == 0
    _git(["config", "user.email", "test@example.com"], local)
    _git(["config", "user.name", "Test User"], local)
    (local / "README.md").write_text("spawn\n")
    (local / "server").mkdir()
    (local / "server" / ".keep").write_text("")
    (local / "web").mkdir()
    (local / "web" / ".keep").write_text("")
    (local / "daemon").mkdir()
    (local / "daemon" / "Cargo.toml").write_text("[package]\nname='fake'\nversion='0.1.0'\n")
    _git(["add", "."], local)
    _git(["commit", "-m", "initial"], local)
    _git(["branch", "-M", "master"], local)
    _git(["push", "-u", "origin", "master"], local)
    assert _run(["git", "clone", str(origin), str(remote)], tmp_path).returncode == 0
    _git(["config", "user.email", "test@example.com"], remote)
    _git(["config", "user.name", "Test User"], remote)
    return origin, local, remote


def _fake_remote_home(tmp_path: Path) -> Path:
    home = tmp_path / "remote-home"
    bin_dir = home / ".local" / "bin"
    bin_dir.mkdir(parents=True)
    for name in ["uv", "bun", "cargo", "systemctl", "sudo"]:
        _write_executable(
            bin_dir / name,
            f"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "{name} $*" >> "$SPAWN_DEPLOY_TEST_LOG_DIR/{name}.log"
if [[ "{name}" == "sudo" ]]; then
  if [[ "${{1:-}}" == "-n" ]]; then shift; fi
  exec "$@"
fi
exit 0
""",
        )
    return home


def _fake_ssh(tmp_path: Path, remote_home: Path) -> Path:
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    # Mask any real gh on the invoking machine: the darwin prebuilt publish
    # step must deterministically skip instead of hitting the network and
    # issuing extra ssh calls that clobber the recorded logs.
    _write_executable(fakebin / "gh", "#!/usr/bin/env bash\nexit 1\n")
    _write_executable(
        fakebin / "ssh",
        f"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" >> "$SPAWN_DEPLOY_TEST_LOG_DIR/ssh-host.log"
printf '%s\\n' "$2" >> "$SPAWN_DEPLOY_TEST_LOG_DIR/ssh-command.log"
script="$SPAWN_DEPLOY_TEST_LOG_DIR/remote-script.sh"
cat > "$script"
HOME={str(remote_home)!r} bash -lc "$2" < "$script"
""",
    )
    # Tripwires: the deploy script must never reach the real network or a real
    # host from a test. A leaked scp/gh call fails the deploy loudly and locally
    # instead of contacting GitHub or production (spawnd-prod is a REAL alias).
    _write_executable(
        fakebin / "scp",
        """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SPAWN_DEPLOY_TEST_LOG_DIR/scp.log"
exit 1
""",
    )
    _write_executable(
        fakebin / "gh",
        """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SPAWN_DEPLOY_TEST_LOG_DIR/gh.log"
exit 1
""",
    )
    return fakebin


def _deploy_env(tmp_path: Path, fakebin: Path, remote: Path, **overrides: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fakebin}:{env['PATH']}",
            "SPAWN_DEPLOY_TEST_LOG_DIR": str(tmp_path / "logs"),
            "SPAWN_DEPLOY_PATH": str(remote),
            "SPAWN_DEPLOY_SUDO": "",
            # Prebuilt publishing pulls a real GitHub release and scp's to the
            # target host; tests exercise it only via the explicit opt-in below.
            "SPAWN_DEPLOY_PREBUILTS": "0",
        }
    )
    env.update(overrides)
    (tmp_path / "logs").mkdir(exist_ok=True)
    return env


def _deploy(local: Path, env: dict[str, str], host: str = "prod") -> subprocess.CompletedProcess[str]:
    return _run([str(DEPLOY_SCRIPT), host], local, env=env)


def _log(tmp_path: Path, name: str) -> str:
    path = tmp_path / "logs" / name
    return path.read_text() if path.exists() else ""


def test_deploy_refuses_dirty_checkout(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    (local / "README.md").write_text("dirty\n")

    result = _deploy(local, _deploy_env(tmp_path, fakebin, remote))

    assert result.returncode != 0
    assert "local checkout has uncommitted changes" in result.stderr
    assert _log(tmp_path, "ssh-host.log") == ""


def test_deploy_refuses_unpushed_commits(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    (local / "local-only.txt").write_text("not pushed\n")
    _git(["add", "local-only.txt"], local)
    _git(["commit", "-m", "local only"], local)

    result = _deploy(local, _deploy_env(tmp_path, fakebin, remote))

    assert result.returncode != 0
    assert "unpushed commit" in result.stderr
    assert _log(tmp_path, "ssh-host.log") == ""


def test_deploy_runs_remote_build_and_restarts_services(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)

    result = _deploy(local, _deploy_env(tmp_path, fakebin, remote))

    assert result.returncode == 0, result.stderr
    assert _log(tmp_path, "ssh-host.log").strip() == "prod"
    assert "SPAWN_DEPLOY_BRANCH=master" in _log(tmp_path, "ssh-command.log")
    assert "uv sync --frozen" in _log(tmp_path, "uv.log")
    assert "uv run alembic upgrade head" in _log(tmp_path, "uv.log")
    assert "bun install --frozen-lockfile" in _log(tmp_path, "bun.log")
    assert "bun run build" in _log(tmp_path, "bun.log")
    assert "cargo build --release --locked" in _log(tmp_path, "cargo.log")
    systemctl_log = _log(tmp_path, "systemctl.log")
    assert "restart spawn-server" in systemctl_log
    assert "restart spawn-web" in systemctl_log
    assert "--no-pager --full status spawn-server" in systemctl_log
    assert "--no-pager --full status spawn-web" in systemctl_log
    assert "remote deploy: complete" in result.stdout


def test_deploy_honors_no_build_custom_services_and_no_sudo(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    env = _deploy_env(
        tmp_path,
        fakebin,
        remote,
        SPAWN_DEPLOY_BUILD="0",
        SPAWN_DEPLOY_SERVICES="spawn-api spawn-web",
        SPAWN_DEPLOY_SUDO="",
    )

    result = _deploy(local, env, host="spawnd-prod")

    assert result.returncode == 0, result.stderr
    assert _log(tmp_path, "ssh-host.log").strip() == "spawnd-prod"
    assert _log(tmp_path, "uv.log") == ""
    assert _log(tmp_path, "bun.log") == ""
    assert _log(tmp_path, "cargo.log") == ""
    systemctl_log = _log(tmp_path, "systemctl.log")
    assert "restart spawn-api" in systemctl_log
    assert "restart spawn-web" in systemctl_log
    assert _log(tmp_path, "sudo.log") == ""


def test_deploy_handles_remote_path_with_spaces(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_with_spaces = tmp_path / "remote path with spaces"
    remote.rename(remote_with_spaces)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    env = _deploy_env(
        tmp_path,
        fakebin,
        remote_with_spaces,
        SPAWN_DEPLOY_BUILD="0",
    )

    result = _deploy(local, env)

    assert result.returncode == 0, result.stderr
    assert f"to prod:{remote_with_spaces}" in result.stdout
    assert "restart spawn-server" in _log(tmp_path, "systemctl.log")
    assert "remote deploy: complete" in result.stdout


def test_deploy_prebuilt_publish_skips_cleanly_without_a_release(tmp_path: Path):
    """With publishing enabled but no prebuilt-latest release (fake gh exits 1),
    the deploy still succeeds and never invokes scp — the publish step is
    best-effort by contract, the from-source fallback stays intact."""

    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    env = _deploy_env(tmp_path, fakebin, remote, SPAWN_DEPLOY_PREBUILTS="1")

    result = _deploy(local, env)

    assert result.returncode == 0, result.stderr
    assert "no prebuilt-latest release; skipping prebuilt publish" in result.stdout
    assert "release download prebuilt-latest" in _log(tmp_path, "gh.log")
    assert _log(tmp_path, "scp.log") == ""
    assert "remote deploy: complete" in result.stdout


def test_deploy_refuses_stale_prebuilt_before_touching_production(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    prebuilt_commit = _git(["rev-parse", "HEAD"], local).stdout.strip()
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)

    # The rolling release still describes the old daemon tree while master has
    # moved on. This is the exact v2-prebuilt/v3-server incident the preflight
    # must stop before SSH is invoked.
    (local / "daemon" / "Cargo.toml").write_text(
        "[package]\nname='fake'\nversion='0.2.0'\n"
    )
    _git(["add", "daemon/Cargo.toml"], local)
    _git(["commit", "-m", "change daemon protocol"], local)
    _git(["push", "origin", "master"], local)

    _write_executable(
        fakebin / "gh",
        f"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SPAWN_DEPLOY_TEST_LOG_DIR/gh.log"
out=''
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--dir" ]]; then out="$2"; shift 2; else shift; fi
done
mkdir -p "$out"
printf '%s\\n' {prebuilt_commit!r} > "$out/COMMIT"
""",
    )
    env = _deploy_env(tmp_path, fakebin, remote, SPAWN_DEPLOY_PREBUILTS="1")

    result = _deploy(local, env)

    assert result.returncode != 0
    assert "prebuilt-latest was built from a different daemon tree" in result.stderr
    assert _log(tmp_path, "ssh-host.log") == ""


def test_deploy_refuses_dirty_remote_checkout_before_build_or_restart(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    (remote / "README.md").write_text("dirty on prod\n")

    result = _deploy(local, _deploy_env(tmp_path, fakebin, remote))

    assert result.returncode != 0
    assert "remote checkout has uncommitted changes" in result.stderr
    assert _log(tmp_path, "uv.log") == ""
    assert _log(tmp_path, "bun.log") == ""
    assert _log(tmp_path, "cargo.log") == ""
    assert _log(tmp_path, "systemctl.log") == ""


def test_deploy_refuses_remote_branch_commits_not_in_origin(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    (remote / "prod-only.txt").write_text("prod-only\n")
    _git(["add", "prod-only.txt"], remote)
    _git(["commit", "-m", "prod only"], remote)

    result = _deploy(local, _deploy_env(tmp_path, fakebin, remote))

    assert result.returncode != 0
    assert "production branch has 1 commit(s) not present in origin/master" in result.stderr
    assert _log(tmp_path, "systemctl.log") == ""
