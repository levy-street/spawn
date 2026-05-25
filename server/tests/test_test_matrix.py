"""Meta-tests for the repeatable smoke-test matrix."""

from __future__ import annotations

import stat
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
TEST_ALL = SCRIPTS_DIR / "test-all.sh"
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "test.yml"


def _script_body() -> str:
    return TEST_ALL.read_text(encoding="utf-8")


def _workflow_body() -> str:
    return CI_WORKFLOW.read_text(encoding="utf-8")


def test_all_shell_scripts_are_executable():
    missing = [
        path.relative_to(REPO_ROOT).as_posix()
        for path in sorted(SCRIPTS_DIR.glob("*.sh"))
        if not (path.stat().st_mode & stat.S_IXUSR)
    ]
    assert missing == []


def test_test_all_runs_required_local_smoke_matrix():
    body = _script_body()
    expected = [
        "smoke-install-prebuilt.sh",
        "smoke-local-http-surface.sh",
        "smoke-redis-pubsub.sh",
        "smoke-local-login.sh",
        "smoke-local-daemon.sh",
        "smoke-local-mcp-protocol.sh",
        "smoke-local-browser-live.sh",
        "smoke-service-manager.sh",
        "bun run test:e2e",
        "bun run build",
        "git diff --check",
    ]
    missing = [item for item in expected if item not in body]
    assert missing == []


def test_test_all_keeps_external_smokes_explicitly_gated():
    body = _script_body()
    expected = [
        "SPAWN_REMOTE_LINUX_HOST",
        "smoke-remote-linux-install.sh",
        "smoke-remote-linux-linger.sh",
        "SPAWN_REMOTE_REBOOT_HOST",
        "smoke-remote-systemd-reboot.sh localhost",
        "remote reboot smoke guard returned",
        "SPAWN_HTTP_SMOKE_URL",
        "SPAWN_PROD_URL",
        "smoke-http-surface.sh",
    ]
    missing = [item for item in expected if item not in body]
    assert missing == []


def test_ci_workflow_runs_the_repeatable_matrix_with_required_host_packages():
    body = _workflow_body()
    expected = [
        "pull_request:",
        "branches:",
        "- master",
        "timeout-minutes:",
        "sudo apt-get install -y redis-server tmux",
        "uv sync --frozen",
        "bun install --frozen-lockfile",
        "bunx playwright install --with-deps chromium",
        "scripts/test-all.sh",
    ]
    missing = [item for item in expected if item not in body]
    assert missing == []


def test_ci_workflow_caches_slow_dependencies():
    body = _workflow_body()
    expected = [
        "daemon/target",
        "daemon/Cargo.lock",
        "server/uv.lock",
        "~/.cache/ms-playwright",
        "web/bun.lock",
    ]
    missing = [item for item in expected if item not in body]
    assert missing == []
