"""Pure release-contract checks embedded in the production deploy script."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = REPO_ROOT / "scripts" / "deploy-prod.sh"


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def test_deploy_self_test_covers_release_contract_without_remote_calls(tmp_path: Path):
    """The renderer, tree gate, and API comparison run without ssh/scp/gh."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    forbidden_log = tmp_path / "forbidden.log"
    for tool in ("ssh", "scp", "gh"):
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
    assert not forbidden_log.exists()
