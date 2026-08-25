"""Mobile OTA publish script behavior with real temp git repos and fake tools.

The script under test exists because a bare `eas update` once shipped a
production bundle with no API URL baked in (eas.json env applies to builds,
not updates). These tests pin the refusal paths and the API URL/mobile tree
bake proofs.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
UPDATE_SCRIPT = REPO_ROOT / "scripts" / "update-mobile-prod.sh"

API_URL = "https://spawnd.dev"
UPDATE_ID = "01a03315-5d3c-7dd7-89e6-4b750ba1d299"
_EXPECTED_TREE = object()


def _run(cmd: list[str], cwd: Path, **kwargs) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=60,
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


def _init_repo(tmp_path: Path) -> Path:
    origin = tmp_path / "origin.git"
    local = tmp_path / "local"
    assert (
        _run(
            ["git", "init", "--bare", "--initial-branch=master", str(origin)], tmp_path
        ).returncode
        == 0
    )
    assert _run(["git", "clone", str(origin), str(local)], tmp_path).returncode == 0
    _git(["config", "user.email", "test@example.com"], local)
    _git(["config", "user.name", "Test User"], local)
    mobile = local / "mobile"
    mobile.mkdir()
    (mobile / "app.json").write_text(
        json.dumps(
            {
                "expo": {
                    "version": "0.1.0",
                    "extra": {"eas": {"projectId": "test-project-id"}},
                }
            }
        )
    )
    _git(["add", "."], local)
    _git(["commit", "-m", "init"], local)
    _git(["push", "origin", "master"], local)
    return local


def _manifest_body(
    update_id: str, api_url: str | None, mobile_tree: str | None
) -> str:
    extra: dict[str, object] = {"eas": {"projectId": "test-project-id"}}
    if api_url is not None:
        extra["apiUrl"] = api_url
    if mobile_tree is not None:
        extra["mobileTree"] = mobile_tree
    manifest = {"id": update_id, "extra": {"expoClient": {"extra": extra}}}
    # The real endpoint answers multipart; the script must cope with framing.
    return (
        "--boundary\r\n"
        'Content-Disposition: form-data; name="manifest"\r\n'
        "Content-Type: application/json\r\n\r\n"
        + json.dumps(manifest)
        + "\r\n--boundary--\r\n"
    )


def _stub_tools(
    tmp_path: Path,
    *,
    baked_api_url: str | None = API_URL,
    served_api_url: str | None = API_URL,
    baked_mobile_tree: str | None | object = _EXPECTED_TREE,
    served_mobile_tree: str | None | object = _EXPECTED_TREE,
    served_update_id: str = UPDATE_ID,
) -> tuple[Path, Path]:
    """Fake npx/eas/curl on PATH; git and node stay real."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    mobile_tree = _git(["rev-parse", "HEAD:mobile"], tmp_path / "local").stdout.strip()
    if baked_mobile_tree is _EXPECTED_TREE:
        baked_mobile_tree = mobile_tree
    if served_mobile_tree is _EXPECTED_TREE:
        served_mobile_tree = mobile_tree

    expo_extra: dict[str, object] = {"eas": {}}
    if baked_api_url is not None:
        expo_extra["apiUrl"] = baked_api_url
    if isinstance(baked_mobile_tree, str):
        expo_extra["mobileTree"] = baked_mobile_tree
    expo_config = json.dumps({"name": "SPAWN D", "extra": expo_extra})
    _write_executable(
        bin_dir / "npx",
        "#!/usr/bin/env bash\n"
        f'echo "npx $*" >> "{log}"\n'
        f"cat <<'JSON'\n"
        f"{expo_config}\n"
        f"JSON\n",
    )
    _write_executable(
        bin_dir / "eas",
        "#!/usr/bin/env bash\n"
        f'echo "eas $* EXPO_PUBLIC_API_URL=${{EXPO_PUBLIC_API_URL:-}} EXPO_PUBLIC_SPAWN_MOBILE_TREE=${{EXPO_PUBLIC_SPAWN_MOBILE_TREE:-}}" >> "{log}"\n'
        f"cat <<'JSON'\n"
        f'[{{"id": "{UPDATE_ID}", "platform": "ios"}}]\n'
        f"JSON\n",
    )
    body_file = tmp_path / "manifest.body"
    body_file.write_text(
        _manifest_body(
            served_update_id,
            served_api_url,
            served_mobile_tree if isinstance(served_mobile_tree, str) else None,
        )
    )
    _write_executable(
        bin_dir / "curl",
        "#!/usr/bin/env bash\n"
        f'echo "curl $*" >> "{log}"\n'
        f'cat "{body_file}"\n',
    )
    return bin_dir, log


def _env(bin_dir: Path) -> dict[str, str]:
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in {"EXPO_PUBLIC_API_URL", "EXPO_PUBLIC_SPAWN_MOBILE_TREE"}
    }
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["SPAWN_UPDATE_VERIFY_ATTEMPTS"] = "2"
    env["SPAWN_UPDATE_VERIFY_DELAY"] = "0"
    return env


def test_update_refuses_missing_message(tmp_path: Path):
    local = _init_repo(tmp_path)
    bin_dir, _ = _stub_tools(tmp_path)
    result = _run([str(UPDATE_SCRIPT)], local, env=_env(bin_dir))
    assert result.returncode != 0
    assert "missing -m message" in result.stderr


def test_update_refuses_dirty_checkout(tmp_path: Path):
    local = _init_repo(tmp_path)
    (local / "mobile" / "scratch.ts").write_text("dirty\n")
    bin_dir, _ = _stub_tools(tmp_path)
    result = _run([str(UPDATE_SCRIPT), "-m", "msg"], local, env=_env(bin_dir))
    assert result.returncode != 0
    assert "dirty checkout" in result.stderr


def test_update_refuses_non_master_branch_without_opt_in(tmp_path: Path):
    local = _init_repo(tmp_path)
    _git(["checkout", "-b", "feature"], local)
    _git(["push", "-u", "origin", "feature"], local)
    bin_dir, _ = _stub_tools(tmp_path)
    result = _run([str(UPDATE_SCRIPT), "-m", "msg"], local, env=_env(bin_dir))
    assert result.returncode != 0
    assert "phones track master" in result.stderr

    allowed = _run(
        [str(UPDATE_SCRIPT), "-m", "msg", "--allow-branch"], local, env=_env(bin_dir)
    )
    assert allowed.returncode == 0, allowed.stderr


def test_update_refuses_unpushed_commits(tmp_path: Path):
    local = _init_repo(tmp_path)
    (local / "mobile" / "new.ts").write_text("code\n")
    _git(["add", "."], local)
    _git(["commit", "-m", "local only"], local)
    bin_dir, _ = _stub_tools(tmp_path)
    result = _run([str(UPDATE_SCRIPT), "-m", "msg"], local, env=_env(bin_dir))
    assert result.returncode != 0
    assert "unpushed" in result.stderr


def test_update_refuses_inherited_disagreeing_env(tmp_path: Path):
    local = _init_repo(tmp_path)
    bin_dir, _ = _stub_tools(tmp_path)
    env = _env(bin_dir)
    env["EXPO_PUBLIC_API_URL"] = "http://192.168.1.50:3000"
    result = _run([str(UPDATE_SCRIPT), "-m", "msg"], local, env=env)
    assert result.returncode != 0
    assert "disagrees" in result.stderr


def test_update_refuses_when_config_does_not_bake_the_url(tmp_path: Path):
    local = _init_repo(tmp_path)
    bin_dir, log = _stub_tools(tmp_path, baked_api_url=None)
    result = _run([str(UPDATE_SCRIPT), "-m", "msg"], local, env=_env(bin_dir))
    assert result.returncode != 0
    assert "fix that before publishing" in result.stderr
    # The guard must fire before any publish happens.
    if log.exists():
        assert "eas update" not in log.read_text()


def test_update_refuses_when_config_does_not_bake_the_mobile_tree(tmp_path: Path):
    local = _init_repo(tmp_path)
    bin_dir, log = _stub_tools(tmp_path, baked_mobile_tree=None)
    result = _run([str(UPDATE_SCRIPT), "-m", "msg"], local, env=_env(bin_dir))
    assert result.returncode != 0
    assert "extra.mobileTree" in result.stderr
    if log.exists():
        assert "eas update" not in log.read_text()


def test_update_publishes_with_the_url_baked_and_verifies_the_manifest(tmp_path: Path):
    local = _init_repo(tmp_path)
    bin_dir, log = _stub_tools(tmp_path)
    result = _run([str(UPDATE_SCRIPT), "-m", "ship it"], local, env=_env(bin_dir))
    assert result.returncode == 0, result.stderr
    calls = log.read_text()
    # The publish ran with the URL present in its environment, not inherited.
    assert f"EXPO_PUBLIC_API_URL={API_URL}" in calls
    expected_tree = _git(["rev-parse", "HEAD:mobile"], local).stdout.strip()
    assert f"EXPO_PUBLIC_SPAWN_MOBILE_TREE={expected_tree}" in calls
    assert "--branch production" in calls
    assert "verified" in result.stdout


def test_update_fails_when_served_manifest_lacks_the_url(tmp_path: Path):
    local = _init_repo(tmp_path)
    bin_dir, _ = _stub_tools(tmp_path, served_api_url=None)
    result = _run([str(UPDATE_SCRIPT), "-m", "msg"], local, env=_env(bin_dir))
    assert result.returncode != 0
    assert "phones may be broken" in result.stderr


def test_update_fails_when_served_manifest_lacks_the_mobile_tree(tmp_path: Path):
    local = _init_repo(tmp_path)
    bin_dir, _ = _stub_tools(tmp_path, served_mobile_tree=None)
    result = _run([str(UPDATE_SCRIPT), "-m", "msg"], local, env=_env(bin_dir))
    assert result.returncode != 0
    assert "phones may be broken" in result.stderr


def test_update_fails_when_served_manifest_is_a_different_update(tmp_path: Path):
    local = _init_repo(tmp_path)
    bin_dir, _ = _stub_tools(
        tmp_path, served_update_id="00000000-0000-0000-0000-000000000000"
    )
    result = _run([str(UPDATE_SCRIPT), "-m", "msg"], local, env=_env(bin_dir))
    assert result.returncode != 0
    assert "phones may be broken" in result.stderr
