"""Production deploy script behavior with real temp git repos and fake SSH."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.name == "nt", reason="production deploy scripts require POSIX shell semantics"
)

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
    path.write_text(body, encoding="utf-8")
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
    # The smoke check derives its probe port from the start script, so the
    # fixture carries the same shape the real web/package.json has.
    (local / "web" / "package.json").write_text(
        '{"scripts": {"start:spawn": "node scripts/next-with-proxy-target.mjs'
        ' start -H 0.0.0.0 -p 3001"}}\n'
    )
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
    for name in ["uv", "bun", "cargo", "systemctl", "sudo", "curl"]:
        _write_executable(
            bin_dir / name,
            f"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "{name} $*" >> "$SPAWN_DEPLOY_TEST_LOG_DIR/{name}.log"
if [[ "{name}" == "sudo" ]]; then
  if [[ "${{1:-}}" == "-n" ]]; then shift; fi
  exec "$@"
fi
if [[ "{name}" == "bun" && "${{1:-}}" == "run" && "${{2:-}}" == "build" ]]; then
  # A real build freezes the proxy target into the routes manifest; the deploy
  # verifies that bake before restarting anything. SPAWN_TEST_BAKED_TARGET lets
  # a test simulate a build that baked something other than what was asked for.
  dist_dir="${{SPAWN_NEXT_DIST_DIR:-.next}}"
  mkdir -p "$dist_dir"
  baked="${{SPAWN_TEST_BAKED_TARGET:-$SPAWN_API_PROXY_TARGET}}"
  printf '{{"rewrites":{{"afterFiles":[{{"source":"/api/:path*","destination":"%s/api/:path*"}}]}}}}\\n' \\
    "$baked" > "$dist_dir/routes-manifest.json"
fi
if [[ "{name}" == "curl" ]]; then
  url="${{@: -1}}"
  if [[ "$url" == */api/release ]]; then
    commit="$(git rev-parse HEAD)"
    manifest="daemon/target/prebuilt/manifest.json"
    tree=""
    if [[ -f "$manifest" ]]; then
      tree="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("tree", ""))' "$manifest" 2>/dev/null || true)"
    fi
    if [[ -n "$tree" ]]; then
      printf '{{"server":{{"commit":"%s"}},"daemon":{{"tree":"%s"}}}}' "$commit" "$tree"
    else
      printf '{{"server":{{"commit":"%s"}},"daemon":null}}' "$commit"
    fi
  else
    printf '%s' "${{SPAWN_TEST_CURL_CODE:-200}}"
  fi
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
# The deploy pins keepalive -o options on every connection; consume them the
# way real ssh does so $1 is the host and $2 the command.
while [[ "${{1:-}}" == "-o" ]]; do shift 2; done
printf '%s\\n' "$1" >> "$SPAWN_DEPLOY_TEST_LOG_DIR/ssh-host.log"
printf '%s\\n' "$2" >> "$SPAWN_DEPLOY_TEST_LOG_DIR/ssh-command.log"
if [[ -n "${{SPAWN_TEST_ADVANCE_CHECKOUT:-}}" && ! -f "$SPAWN_DEPLOY_TEST_LOG_DIR/branch-advanced" ]]; then
  git -C "$SPAWN_TEST_ADVANCE_CHECKOUT" push origin master
  touch "$SPAWN_DEPLOY_TEST_LOG_DIR/branch-advanced"
fi
script="$SPAWN_DEPLOY_TEST_LOG_DIR/remote-script.sh"
cat > "$script"
HOME={str(remote_home)!r} bash -lc "export PATH={str(remote_home / '.local' / 'bin')!r}:\\$PATH; $2" < "$script"
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
    # Existing deploy cases isolate the prevalidated acceptance result, just as
    # SSH/HTTP are isolated here. The real validator's malformed/stale/skipped
    # evidence cases live in scripts/test-release-acceptance.py.
    _write_executable(
        fakebin / "python3",
        "#!/usr/bin/env bash\n"
        'if [[ "${1:-}" == */scripts/check-release-acceptance.py ]]; then\n'
        '  printf "%s\\n" "$*" >> "$SPAWN_DEPLOY_TEST_LOG_DIR/acceptance.log"\n'
        '  exit "${SPAWN_TEST_REJECT_ACCEPTANCE:-0}"\n'
        "fi\n"
        f'exec {shutil.which("python3")!r} "$@"\n',
    )
    return fakebin


def _deploy_env(tmp_path: Path, fakebin: Path, remote: Path, **overrides: str) -> dict[str, str]:
    env = os.environ.copy()
    # The deploy refuses an inherited SPAWN_API_PROXY_TARGET by design; a dev
    # shell running this suite must not trip every test into that refusal.
    env.pop("SPAWN_API_PROXY_TARGET", None)
    acceptance = tmp_path / "acceptance.json"
    acceptance.write_text(
        json.dumps({
            "fixture": "prevalidated acceptance",
            "baseline_commit": _git(["rev-parse", "HEAD"], remote).stdout.strip(),
        }) + "\n"
    )
    env.update(
        {
            "PATH": f"{fakebin}:{env['PATH']}",
            "SPAWN_DEPLOY_TEST_LOG_DIR": str(tmp_path / "logs"),
            "SPAWN_RELEASE_ACCEPTANCE": str(acceptance),
            "SPAWN_DEPLOY_PATH": str(remote),
            "SPAWN_DEPLOY_SUDO": "",
            # Prebuilt publishing pulls a real GitHub release and scp's to the
            # target host; tests exercise it only via the explicit opt-in below.
            "SPAWN_DEPLOY_PREBUILTS": "0",
            # The smoke check probes a live web server; tests that exercise it
            # opt in with the fake curl above and a small attempt budget.
            "SPAWN_DEPLOY_SMOKE": "0",
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


def _stage_current_remote_manifest(remote: Path) -> None:
    """Give production the daemon identity it already runs, outside git."""

    daemon_tree = _git(["rev-parse", "HEAD:daemon"], remote).stdout.strip()
    exclude = remote / ".git" / "info" / "exclude"
    with exclude.open("a") as handle:
        handle.write("\ndaemon/target/prebuilt/\n")
    prebuilt = remote / "daemon" / "target" / "prebuilt"
    prebuilt.mkdir(parents=True)
    (prebuilt / "manifest.json").write_text(f'{{"tree":"{daemon_tree}"}}\n')


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
    assert set(_log(tmp_path, "ssh-host.log").splitlines()) == {"prod"}
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
    assert "deploy-prod: complete" in result.stdout


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
    assert set(_log(tmp_path, "ssh-host.log").splitlines()) == {"spawnd-prod"}
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
    assert "deploy-prod: complete" in result.stdout


def test_deploy_prebuilt_publish_skips_cleanly_without_a_release(tmp_path: Path):
    """With publishing enabled but no prebuilt-latest release (fake gh exits 1),
    the deploy still succeeds and never invokes scp — the publish step is
    best-effort by contract, the from-source fallback stays intact."""

    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    _stage_current_remote_manifest(remote)
    env = _deploy_env(tmp_path, fakebin, remote, SPAWN_DEPLOY_PREBUILTS="1")

    result = _deploy(local, env)

    assert result.returncode == 0, result.stderr
    assert "prebuilt publish skipped (prebuilt-latest could not be downloaded)" in result.stdout
    assert "daemon tree is unchanged, continuing" in result.stderr
    assert "release download prebuilt-latest" in _log(tmp_path, "gh.log")
    assert _log(tmp_path, "scp.log") == ""
    assert "deploy-prod: complete" in result.stdout


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
    assert "prebuilt-latest COMMIT/TREE is stale or invalid" in result.stderr
    assert _log(tmp_path, "systemctl.log") == ""


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


def test_deploy_refuses_inherited_proxy_target_env(tmp_path: Path):
    """The 2026-08-24 incident: a dev shell's SPAWN_API_PROXY_TARGET was baked
    into the production web build. An inherited value must be a hard error
    before SSH is invoked; only the flag may carry a non-default target."""

    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    env = _deploy_env(
        tmp_path, fakebin, remote, SPAWN_API_PROXY_TARGET="http://127.0.0.1:8010"
    )

    result = _deploy(local, env)

    assert result.returncode != 0
    assert "refusing to bake SPAWN_API_PROXY_TARGET" in result.stderr
    assert _log(tmp_path, "ssh-host.log") == ""


def test_deploy_flag_bakes_and_verifies_requested_target(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    env = _deploy_env(tmp_path, fakebin, remote)

    result = _run(
        [str(DEPLOY_SCRIPT), "prod", "--api-proxy-target", "http://127.0.0.1:9001"],
        local,
        env=env,
    )

    assert result.returncode == 0, result.stderr
    assert "SPAWN_API_PROXY_TARGET=http://127.0.0.1:9001" in _log(tmp_path, "ssh-command.log")
    assert "verified baked proxy target http://127.0.0.1:9001" in result.stdout


def test_deploy_aborts_before_restart_when_build_bakes_wrong_target(tmp_path: Path):
    """A build whose manifest disagrees with the requested target must abort
    while the previous build is still serving: nothing restarted."""

    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    env = _deploy_env(
        tmp_path, fakebin, remote, SPAWN_TEST_BAKED_TARGET="http://127.0.0.1:8010"
    )

    result = _deploy(local, env)

    assert result.returncode != 0
    assert "baked the wrong API proxy target" in result.stderr
    assert "bun run build" in _log(tmp_path, "bun.log")
    assert _log(tmp_path, "systemctl.log") == ""


def test_deploy_smoke_probes_healthz_through_the_web_proxy(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    env = _deploy_env(
        tmp_path, fakebin, remote, SPAWN_DEPLOY_SMOKE="1", SPAWN_DEPLOY_SMOKE_ATTEMPTS="2"
    )

    result = _deploy(local, env)

    assert result.returncode == 0, result.stderr
    # Port derived from web/package.json's start script, not hardcoded.
    assert "http://127.0.0.1:3001/healthz" in _log(tmp_path, "curl.log")
    assert "smoke check ok" in result.stdout


def test_deploy_smoke_failure_fails_the_deploy_and_names_the_rollback(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    env = _deploy_env(
        tmp_path,
        fakebin,
        remote,
        SPAWN_DEPLOY_SMOKE="1",
        SPAWN_DEPLOY_SMOKE_ATTEMPTS="2",
        SPAWN_TEST_CURL_CODE="502",
    )

    result = _deploy(local, env)

    assert result.returncode != 0
    assert "post-deploy smoke check failed" in result.stderr
    assert "Roll back with" in result.stderr


def _push_side_branch(local: Path) -> None:
    _git(["checkout", "-b", "feat/side"], local)
    (local / "side.txt").write_text("side\n")
    _git(["add", "side.txt"], local)
    _git(["commit", "-m", "side"], local)
    _git(["push", "-u", "origin", "feat/side"], local)


def test_deploy_refuses_non_master_branch_without_opt_in(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    _push_side_branch(local)

    result = _deploy(local, _deploy_env(tmp_path, fakebin, remote))

    assert result.returncode != 0
    assert "production deploys from master" in result.stderr
    assert _log(tmp_path, "ssh-host.log") == ""


def test_deploy_allows_non_master_branch_with_explicit_flag(tmp_path: Path):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    _push_side_branch(local)

    result = _run(
        [str(DEPLOY_SCRIPT), "prod", "--allow-branch"],
        local,
        env=_deploy_env(tmp_path, fakebin, remote),
    )

    assert result.returncode == 0, result.stderr
    assert "SPAWN_DEPLOY_BRANCH=feat/side" in _log(tmp_path, "ssh-command.log")


@pytest.mark.parametrize("allow_branch", [False, True])
@pytest.mark.parametrize("missing", [False, True])
def test_deploy_acceptance_refusal_precedes_any_ssh_even_with_overrides(
    tmp_path: Path, allow_branch: bool, missing: bool
):
    _origin, local, remote = _init_repo(tmp_path)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    if allow_branch:
        _push_side_branch(local)
    env = _deploy_env(tmp_path, fakebin, remote, SPAWN_TEST_REJECT_ACCEPTANCE="1")
    if missing:
        env.pop("SPAWN_RELEASE_ACCEPTANCE")
    args = [str(DEPLOY_SCRIPT), "prod"] + (["--allow-branch"] if allow_branch else [])
    result = _run(args, local, env=env)
    assert result.returncode != 0
    assert "acceptance evidence" in result.stderr
    assert _log(tmp_path, "ssh-host.log") == ""
    assert _log(tmp_path, "scp.log") == ""
    assert _log(tmp_path, "systemctl.log") == ""


def test_deploy_refuses_branch_advance_after_local_acceptance_validation(tmp_path: Path):
    origin, local, remote = _init_repo(tmp_path)
    original = _git(["rev-parse", "HEAD"], remote).stdout.strip()
    writer = tmp_path / "concurrent-writer"
    assert _run(["git", "clone", str(origin), str(writer)], tmp_path).returncode == 0
    _git(["config", "user.name", "Concurrent writer"], writer)
    _git(["config", "user.email", "writer@example.com"], writer)
    (writer / "README.md").write_text("not accepted yet\n")
    _git(["commit", "-am", "unvalidated concurrent commit"], writer)
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    env = _deploy_env(tmp_path, fakebin, remote, SPAWN_TEST_ADVANCE_CHECKOUT=str(writer))
    result = _deploy(local, env)
    assert result.returncode != 0
    assert "remote branch moved after acceptance validation" in result.stderr
    assert _git(["rev-parse", "HEAD"], remote).stdout.strip() == original
    assert _log(tmp_path, "systemctl.log") == ""
    assert f"--candidate {original}" in _log(tmp_path, "acceptance.log")


@pytest.mark.parametrize("resume", [False, True])
def test_deploy_rechecks_public_baseline_after_preparation(tmp_path: Path, resume: bool):
    _origin, local, remote = _init_repo(tmp_path)
    baseline = _git(["rev-parse", "HEAD"], local).stdout.strip()
    (local / "README.md").write_text("concurrent release\n")
    _git(["commit", "-am", "other release"], local)
    advanced = _git(["rev-parse", "HEAD"], local).stdout.strip()
    (local / "README.md").write_text("accepted candidate\n")
    _git(["commit", "-am", "candidate"], local)
    _git(["push", "origin", "master"], local)
    candidate = _git(["rev-parse", "HEAD"], local).stdout.strip()
    tree = _git(["rev-parse", f"{baseline}:daemon"], local).stdout.strip()
    remote_home = _fake_remote_home(tmp_path)
    fakebin = _fake_ssh(tmp_path, remote_home)
    env = _deploy_env(tmp_path, fakebin, remote)
    public = tmp_path / "public-release.json"
    public.write_text(
        json.dumps({"server": {"commit": baseline, "dirty": False}, "daemon": {"tree": tree}})
    )
    advanced_public = tmp_path / "advanced-release.json"
    advanced_public.write_text(
        json.dumps({"server": {"commit": advanced, "dirty": False}, "daemon": {"tree": tree}})
    )

    # Run the real validator. Only its public HTTP response is replaced; stale
    # evidence must fail because the production baseline changed, not because
    # a test stub decides that the second invocation should return an error.
    validator = tmp_path / "validator-driver.py"
    validator.write_text(
        "import importlib.util, io, json, os, sys\n"
        "from pathlib import Path\n"
        "spec = importlib.util.spec_from_file_location('gate', sys.argv[1])\n"
        "gate = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(gate)\n"
        "gate.ROOT = Path(os.environ['SPAWN_TEST_GATE_ROOT'])\n"
        "def public(url, **kwargs):\n"
        "    assert url == 'https://spawnd.dev/api/release', url\n"
        "    data = Path(os.environ['SPAWN_TEST_PUBLIC_RELEASE']).read_bytes()\n"
        "    with open(os.environ['SPAWN_DEPLOY_TEST_LOG_DIR'] + '/baseline.log', 'a') as log:\n"
        "        log.write(json.loads(data)['server']['commit'] + '\\n')\n"
        "    return io.BytesIO(data)\n"
        "gate.urllib.request.urlopen = public\n"
        "sys.argv = sys.argv[1:]\n"
        "gate.main()\n"
    )
    python = shlex.quote(shutil.which("python3"))
    _write_executable(
        fakebin / "python3",
        "#!/usr/bin/env bash\n"
        'if [[ "${1:-}" == */scripts/check-release-acceptance.py ]]; then\n'
        f'  exec {python} {shlex.quote(str(validator))} "$@"\n'
        "fi\n"
        f'exec {python} "$@"\n',
    )
    env.update(SPAWN_TEST_GATE_ROOT=str(local), SPAWN_TEST_PUBLIC_RELEASE=str(public))
    reports = {}
    native_cases = (
        "shared_transport",
        "background_short",
        "background_retire",
        "process_restart",
        "relay_udp_outage",
        "relay_udp_loss",
        "upload_interruption",
        "identity_retirement",
    )
    for name, kind, cases in (
        ("ios", "native_simulator", native_cases),
        ("android", "native_emulator", native_cases),
        (
            "canary",
            "isolated_canary",
            (
                "baseline_holdback",
                "candidate_soak",
                "update_recovery",
                "startup_rollback",
            ),
        ),
    ):
        reports[name] = {
            "schema_version": 1,
            "candidate_commit": candidate,
            "baseline_commit": baseline,
            "status": "passed",
            "evidence_kind": kind,
            "platform": name,
            "physical_device": False,
            "source_clean": True,
            "cleanup_passed": True,
            "cleanup_complete": True,
            "started_at": "2026-01-01T00:00:00+00:00",
            "completed_at": "2026-01-01T00:10:00+00:00",
            "cases": [
                {"id": case, "status": "passed", "metrics": {"soak_seconds": 120, "samples": 5}}
                for case in cases
            ],
        }
    Path(env["SPAWN_RELEASE_ACCEPTANCE"]).write_text(
        json.dumps(
            {
                "schema_version": 1,
                "candidate_commit": candidate,
                "baseline_commit": baseline,
                "status": "passed",
                "reports": reports,
            }
        )
    )

    # Another release finishes during staging. The target ref does not move,
    # so the existing target-commit guard alone cannot detect this change.
    ssh = fakebin / "ssh"
    marker = 'script="$SPAWN_DEPLOY_TEST_LOG_DIR/remote-script.sh"'
    advance = (
        'if [[ "$2" == "cat > "* && ! -f "$SPAWN_DEPLOY_TEST_LOG_DIR/baseline-advanced" ]]; then\n'
        f"  git -C {shlex.quote(str(remote))} fetch origin master\n"
        f"  git -C {shlex.quote(str(remote))} checkout -B master {advanced}\n"
        f"  cp {shlex.quote(str(advanced_public))} {shlex.quote(str(public))}\n"
        '  touch "$SPAWN_DEPLOY_TEST_LOG_DIR/baseline-advanced"\n'
        "fi\n"
    )
    ssh.write_text(ssh.read_text().replace(marker, advance + marker))
    result = _run([str(DEPLOY_SCRIPT), "prod", *(["--resume"] if resume else [])], local, env=env)
    assert result.returncode != 0
    assert "production does not match the acceptance baseline" in result.stderr
    assert "baseline advanced during preparation" in result.stderr
    assert _log(tmp_path, "baseline.log").splitlines() == [baseline, advanced]
    assert _git(["rev-parse", "HEAD"], remote).stdout.strip() == advanced
    assert _log(tmp_path, "systemctl.log") == ""
    # The only remote write from the refused deploy was its staged temp script.
    commands = _log(tmp_path, "ssh-command.log").splitlines()
    staged = next(
        command.removeprefix("cat > ").strip("'")
        for command in commands
        if command.startswith("cat > ")
    )
    assert not Path(staged).exists()
