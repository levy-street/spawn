"""Release identities, prebuilt validation, and daemon update state."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import subprocess
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import schemas
from .config import get_settings

if TYPE_CHECKING:
    from .models import Host

log = logging.getLogger("spawn.release")

REPO_ROOT = Path(__file__).resolve().parents[2]
# Tests may point this at an isolated manifest without having to reproduce the
# whole repository layout. When unset, it follows REPO_ROOT dynamically.
MANIFEST_PATH: Path | None = None
SUPPORTED_DAEMON_TARGETS = (
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
    "linux-aarch64",
)
DAEMON_UPDATE_TIMEOUT = timedelta(minutes=3)

_HEX_40 = re.compile(r"^[0-9a-f]{40}$")
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_DAEMON_TREE = re.compile(r"^[0-9a-f]{40}(?:-dirty)?$")
_sha256_cache: dict[tuple[Path, int, int], str] = {}
_manifest_errors_logged: set[str] = set()


@dataclass(frozen=True)
class _ReleaseIdentity:
    server_commit: str | None
    server_dirty: bool
    web_build_id: str | None
    mobile_tree: str | None
    mobile_runtime_version: str | None


_identity: _ReleaseIdentity | None = None


def _git_output(*args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    return value or None


def _git_path_is_clean(path: str) -> bool | None:
    try:
        result = subprocess.run(
            ["git", "diff", "--quiet", "HEAD", "--", path],
            cwd=REPO_ROOT,
            capture_output=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    return None


def _clean_hex_40(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    return normalized if _HEX_40.fullmatch(normalized) else None


def valid_daemon_tree(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > 64:
        return None
    normalized = value.strip().lower()
    return normalized if _DAEMON_TREE.fullmatch(normalized) else None


def _read_mobile_runtime_version() -> str | None:
    try:
        raw = json.loads((REPO_ROOT / "mobile" / "app.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None
    expo = raw.get("expo") if isinstance(raw, dict) else None
    version = expo.get("version") if isinstance(expo, dict) else None
    return version.strip() if isinstance(version, str) and version.strip() else None


def _read_web_build_id() -> str | None:
    try:
        value = (REPO_ROOT / "web" / ".next" / "BUILD_ID").read_text().strip()
    except OSError:
        return None
    return value or None


def _compute_identity() -> _ReleaseIdentity:
    settings = get_settings()
    if settings.release_commit is not None:
        server_commit = _clean_hex_40(settings.release_commit)
        server_dirty = False
    else:
        server_commit = _clean_hex_40(_git_output("rev-parse", "HEAD"))
        server_dirty = _git_path_is_clean(".") is False

    if settings.mobile_tree is not None:
        mobile_tree = _clean_hex_40(settings.mobile_tree)
    elif _git_path_is_clean("mobile") is True:
        mobile_tree = _clean_hex_40(_git_output("rev-parse", "HEAD:mobile"))
    else:
        mobile_tree = None

    return _ReleaseIdentity(
        server_commit=server_commit,
        server_dirty=server_dirty,
        web_build_id=_read_web_build_id(),
        mobile_tree=mobile_tree,
        mobile_runtime_version=_read_mobile_runtime_version(),
    )


_identity = _compute_identity()


def refresh() -> None:
    """Refresh cached checkout identity after a test or deployment fixture changes."""

    global _identity
    _identity = _compute_identity()
    _sha256_cache.clear()
    _manifest_errors_logged.clear()


def _current_identity() -> _ReleaseIdentity:
    global _identity
    if _identity is None:
        _identity = _compute_identity()
    return _identity


def _log_manifest_error_once(message: str) -> None:
    if message in _manifest_errors_logged:
        return
    _manifest_errors_logged.add(message)
    log.error("prebuilt manifest ignored: %s", message)


def _sha256_file(path: Path) -> str | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    if not path.is_file():
        return None
    key = (path, stat.st_mtime_ns, stat.st_size)
    cached = _sha256_cache.get(key)
    if cached is not None:
        return cached
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    value = digest.hexdigest()
    _sha256_cache[key] = value
    return value


def _manifest_location(repo_root: Path) -> Path:
    return MANIFEST_PATH or repo_root / "daemon" / "target" / "prebuilt" / "manifest.json"


def read_prebuilt_manifest(
    *,
    repo_root: Path | None = None,
    manifest_path: Path | None = None,
) -> schemas.DaemonReleaseOut | None:
    """Read and fully verify the prebuilt manifest currently on disk."""

    root = repo_root or REPO_ROOT
    path = manifest_path or _manifest_location(root)
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        _log_manifest_error_once(f"cannot read {path}: {type(exc).__name__}")
        return None
    if not isinstance(raw, dict):
        _log_manifest_error_once(f"{path} is not a JSON object")
        return None

    commit = _clean_hex_40(raw.get("commit") if isinstance(raw.get("commit"), str) else None)
    tree = _clean_hex_40(raw.get("tree") if isinstance(raw.get("tree"), str) else None)
    version = raw.get("version")
    targets_raw = raw.get("targets")
    if (
        commit is None
        or tree is None
        or not isinstance(version, str)
        or not version.strip()
        or len(version) > 64
        or not isinstance(targets_raw, dict)
    ):
        _log_manifest_error_once(f"{path} has invalid release fields")
        return None

    prebuilt_root = path.parent
    targets: dict[str, schemas.DaemonTargetOut] = {}
    for target, target_raw in targets_raw.items():
        if target not in SUPPORTED_DAEMON_TARGETS or not isinstance(target_raw, dict):
            _log_manifest_error_once(f"{path} has invalid target {target!r}")
            return None
        spawnd_sha = target_raw.get("spawnd_sha256")
        worker_sha = target_raw.get("spawn_worker_sha256")
        if not isinstance(spawnd_sha, str) or not isinstance(worker_sha, str):
            _log_manifest_error_once(f"{path} has missing hashes for {target}")
            return None
        spawnd_sha = spawnd_sha.lower()
        worker_sha = worker_sha.lower()
        if not _HEX_64.fullmatch(spawnd_sha) or not _HEX_64.fullmatch(worker_sha):
            _log_manifest_error_once(f"{path} has invalid hashes for {target}")
            return None

        binaries = (
            (prebuilt_root / target / "spawnd", spawnd_sha),
            (prebuilt_root / target / "spawn-worker", worker_sha),
        )
        for binary, expected in binaries:
            actual = _sha256_file(binary)
            if actual != expected:
                _log_manifest_error_once(f"sha256 mismatch for {binary}")
                return None
        targets[target] = schemas.DaemonTargetOut(
            spawnd_sha256=spawnd_sha,
            spawn_worker_sha256=worker_sha,
        )

    return schemas.DaemonReleaseOut(
        version=version.strip(),
        commit=commit,
        tree=tree,
        targets=targets,
    )


def release_info() -> schemas.ReleaseOut:
    identity = _current_identity()
    return schemas.ReleaseOut(
        server=schemas.ServerReleaseOut(
            commit=identity.server_commit,
            dirty=identity.server_dirty,
        ),
        web=schemas.WebReleaseOut(build_id=identity.web_build_id),
        daemon=read_prebuilt_manifest(),
        mobile=schemas.MobileReleaseOut(
            tree=identity.mobile_tree,
            runtime_version=identity.mobile_runtime_version,
        ),
        protocols=schemas.ReleaseProtocolsOut(
            daemon="spawn.control.v3",
            browser="spawn.v3",
            alerts="spawn.alerts.v1",
        ),
    )


def _aware_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def daemon_target(os_name: str | None, arch: str | None) -> str | None:
    os_part = {"darwin": "darwin", "macos": "darwin", "linux": "linux"}.get(
        (os_name or "").lower()
    )
    arch_part = {
        "aarch64": "aarch64",
        "arm64": "aarch64",
        "x86_64": "x86_64",
        "amd64": "x86_64",
    }.get((arch or "").lower())
    return f"{os_part}-{arch_part}" if os_part and arch_part else None


def humanize_self_update_blocked(reason: str | None) -> str:
    messages = {
        "disabled": "Self-update is disabled",
        "unwritable": "The daemon install directory is not writable",
        "unsupported_target": "This daemon target is unsupported",
        "worker_missing": "The SPAWN D worker binary is missing",
    }
    if reason in messages:
        return messages[reason]
    if reason:
        return reason.replace("_", " ").capitalize()
    return "This daemon cannot update itself"


def host_update_state(
    host: Host,
    manifest: schemas.DaemonReleaseOut | None = None,
    *,
    now: datetime | None = None,
) -> schemas.HostUpdateOut:
    if manifest is None:
        manifest = read_prebuilt_manifest()
    if manifest is None or (host.daemon_tree or "").endswith("-dirty"):
        return schemas.HostUpdateOut(state="unknown")
    if host.daemon_tree is None:
        return schemas.HostUpdateOut(
            state="unsupported",
            latest_version=manifest.version,
            error="This daemon is too old to update itself",
        )
    if host.daemon_tree == manifest.tree:
        return schemas.HostUpdateOut(state="current", latest_version=manifest.version)

    requested_at = _aware_utc(host.update_requested_at)
    current_time = now or datetime.now(UTC)
    if (
        host.update_state == "updating"
        and requested_at is not None
        and current_time - requested_at <= DAEMON_UPDATE_TIMEOUT
    ):
        return schemas.HostUpdateOut(
            state="updating",
            latest_version=manifest.version,
            requested_at=requested_at,
        )
    if host.update_state == "failed" and host.update_tree == manifest.tree:
        return schemas.HostUpdateOut(
            state="failed",
            latest_version=manifest.version,
            error=host.update_error,
            requested_at=requested_at,
        )
    if not host.self_update:
        return schemas.HostUpdateOut(
            state="unsupported",
            latest_version=manifest.version,
            error=humanize_self_update_blocked(host.self_update_blocked),
        )
    return schemas.HostUpdateOut(state="available", latest_version=manifest.version)


def daemon_update_payload(
    host: Host,
    manifest: schemas.DaemonReleaseOut,
    *,
    request_id: str | None = None,
) -> dict[str, Any] | None:
    target = daemon_target(host.os, host.arch)
    target_release = manifest.targets.get(target or "")
    if target is None or target_release is None:
        return None
    return {
        "type": "daemon.update",
        "request_id": request_id or str(uuid.uuid4()),
        "version": manifest.version,
        "tree": manifest.tree,
        "target": target,
        "spawnd": {
            "path": f"/api/install/spawnd/{target}",
            "sha256": target_release.spawnd_sha256,
        },
        "spawn_worker": {
            "path": f"/api/install/spawn-worker/{target}",
            "sha256": target_release.spawn_worker_sha256,
        },
    }


def mark_update_requested(
    host: Host,
    manifest: schemas.DaemonReleaseOut,
    *,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    payload = daemon_update_payload(host, manifest)
    if payload is None:
        return None
    host.update_state = "updating"
    host.update_tree = manifest.tree
    host.update_error = None
    host.update_requested_at = now or datetime.now(UTC)
    return payload


def humanize_update_result_error(stage: str | None, error: str | None) -> str:
    if stage and error:
        return f"{stage.replace('_', ' ')}: {error.replace('_', ' ')}"[:500]
    if stage:
        return stage.replace("_", " ")[:500]
    if error:
        return error.replace("_", " ")[:500]
    return "update failed"
