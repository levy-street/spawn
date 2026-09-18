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
from .config import get_settings, is_local_deployment

if TYPE_CHECKING:
    from .models import Host

log = logging.getLogger("spawn.release")

REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_REPO_ROOT = REPO_ROOT
# Tests may point this at an isolated manifest without having to reproduce the
# whole repository layout. When unset, it follows REPO_ROOT dynamically.
MANIFEST_PATH: Path | None = None
SUPPORTED_DAEMON_TARGETS = (
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
    "linux-aarch64",
    "windows-x86_64",
)
#: Alternative builds of a daemon release, cut from the same tree at the same
#: counter and listed in the manifest under `variants`. Their binaries live
#: under `prebuilt/<target>/<variant>/` and are served from
#: `/api/install/<kind>/<target>/<variant>`. The daemon picks one by the build
#: it already is, so the server only has to publish and prove them. Kept in
#: step with `PREBUILT_VARIANTS` in scripts/release-lib.sh.
SUPPORTED_DAEMON_VARIANTS = ("diagnostics",)
DESKTOP_PLATFORMS = ("darwin-aarch64", "darwin-x86_64", "windows-x86_64")

#: What an unreadable desktop directory may still claim. Failing open is
#: defensible for a platform that has shipped: the 404s it produces are the
#: point, and they make a broken mount loud instead of letting it look like a
#: quiet release. It is not defensible for one that has not shipped — claiming
#: Windows before it launches invents a download rather than exposing a fault,
#: and every surface that reads this would stop saying "coming soon" and start
#: offering a file that has never existed. Windows joins this the day it ships.
FAIL_OPEN_DESKTOP_PLATFORMS = ("darwin-aarch64", "darwin-x86_64")

#: The one every download surface links to. `useDesktopRelease` in
#: `web/src/hooks/useDesktopRelease.ts` builds the primary button's URL for
#: Apple silicon regardless of what `platforms` says, so a block whose
#: aarch64 image is missing is a 404 no matter how the list reads.
PRIMARY_DESKTOP_PLATFORM = "darwin-aarch64"

#: Where `scripts/publish-desktop.sh` uploads the notarized disk images and
#: what nginx aliases `/desktop/` onto. Same value as that script's own
#: `SPAWN_DESKTOP_DIR` default, and the same one
#: `infra/nginx-spawnd.conf.example` tells the operator to create.
DEFAULT_DESKTOP_DIR = Path("/var/www/spawnd/desktop")
DAEMON_UPDATE_TIMEOUT = timedelta(minutes=3)

_HEX_40 = re.compile(r"^[0-9a-f]{40}$")
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_DAEMON_TREE = re.compile(r"^[0-9a-f]{40}(?:-dirty)?$")
_sha256_cache: dict[tuple[Path, int, int], str] = {}
_manifest_errors_logged: set[str] = set()
_desktop_dir_warned = False


@dataclass(frozen=True)
class _ReleaseIdentity:
    server_commit: str | None
    server_dirty: bool
    web_build_id: str | None
    mobile_tree: str | None
    mobile_runtime_version: str | None
    # Identity only. Whether the images this names were ever published is a
    # question about the static origin, not about the checkout, and it is
    # asked per request — see `desktop_release`.
    desktop_version: str | None
    desktop_tree: str | None


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


def _clean_desktop_version(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _read_desktop_version() -> str | None:
    try:
        raw = json.loads((REPO_ROOT / "desktop" / "src-tauri" / "tauri.conf.json").read_text())
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    return _clean_desktop_version(raw.get("version"))


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

    if settings.desktop_version is not None:
        desktop_version = _clean_desktop_version(settings.desktop_version)
    else:
        desktop_version = _read_desktop_version()

    if settings.desktop_tree is not None:
        desktop_tree = _clean_hex_40(settings.desktop_tree)
    elif _git_path_is_clean("desktop") is True:
        desktop_tree = _clean_hex_40(_git_output("rev-parse", "HEAD:desktop"))
    else:
        desktop_tree = None

    return _ReleaseIdentity(
        server_commit=server_commit,
        server_dirty=server_dirty,
        web_build_id=_read_web_build_id(),
        mobile_tree=mobile_tree,
        mobile_runtime_version=_read_mobile_runtime_version(),
        desktop_version=desktop_version,
        desktop_tree=desktop_tree,
    )


_identity = _compute_identity()


def refresh() -> None:
    """Refresh cached checkout identity after a test or deployment fixture changes."""

    global _identity, _desktop_dir_warned
    _identity = _compute_identity()
    _sha256_cache.clear()
    _manifest_errors_logged.clear()
    _desktop_dir_warned = False


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


def prebuilt_root(*, repo_root: Path | None = None) -> Path:
    if MANIFEST_PATH is not None:
        return MANIFEST_PATH.parent
    root = repo_root or REPO_ROOT
    configured = getattr(get_settings(), "prebuilt_dir", None)
    default = _DEFAULT_REPO_ROOT / "daemon" / "target" / "prebuilt"
    # Unit tests historically replace REPO_ROOT. Preserve that seam unless a
    # genuinely custom SPAWN_PREBUILT_DIR was supplied.
    if configured is not None and Path(configured) != default:
        base = Path(configured)
    else:
        base = root / "daemon" / "target" / "prebuilt"
    current = base / "current"
    # Resolve once per request so a concurrent publication cannot mix a
    # generation's manifest with another generation's binaries. Legacy flat
    # releases remain readable until the first complete snapshot is activated.
    if current.is_symlink() or current.exists():
        return current.resolve()
    return base


def _manifest_path_for_root(*, repo_root: Path | None = None) -> Path:
    return MANIFEST_PATH or prebuilt_root(repo_root=repo_root) / "manifest.json"


def manifest_path(*, repo_root: Path | None = None) -> Path:
    return _manifest_path_for_root(repo_root=repo_root)


def manifest_signature_path(*, repo_root: Path | None = None) -> Path:
    path = _manifest_path_for_root(repo_root=repo_root)
    return Path(f"{path}.sig")


def _daemon_binary_filename(kind: str, target: str) -> str:
    suffix = ".exe" if target.startswith("windows-") else ""
    return f"{kind}{suffix}"


def variant_version(version: str, variant: str) -> str:
    """The version a variant binary reports: the release version with the
    variant as one more build-metadata segment, as daemon/build.rs stamps it
    and scripts/release-lib.sh renders it."""
    return f"{version}.{variant}"


def _verified_target_pair(
    prebuilt_root: Path,
    target: str,
    target_raw: object,
    *,
    path: Path,
    label: str,
    variant: str | None = None,
) -> schemas.DaemonTargetOut | None:
    """One target's pair, proven: two lower-hex hashes in the manifest and two
    files on disk that hash to them. `None` names the reason once and means
    the whole manifest is refused, for a variant exactly as for the release —
    a manifest that lists bytes this server cannot hand out is not a release."""
    if target not in SUPPORTED_DAEMON_TARGETS or not isinstance(target_raw, dict):
        _log_manifest_error_once(f"{path} has invalid {label} target {target!r}")
        return None
    spawnd_sha = target_raw.get("spawnd_sha256")
    worker_sha = target_raw.get("spawn_worker_sha256")
    if not isinstance(spawnd_sha, str) or not isinstance(worker_sha, str):
        _log_manifest_error_once(f"{path} has missing {label} hashes for {target}")
        return None
    spawnd_sha = spawnd_sha.lower()
    worker_sha = worker_sha.lower()
    if not _HEX_64.fullmatch(spawnd_sha) or not _HEX_64.fullmatch(worker_sha):
        _log_manifest_error_once(f"{path} has invalid {label} hashes for {target}")
        return None

    directory = prebuilt_root / target
    if variant is not None:
        directory = directory / variant
    binaries = (
        (directory / _daemon_binary_filename("spawnd", target), spawnd_sha),
        (directory / _daemon_binary_filename("spawn-worker", target), worker_sha),
    )
    for binary, expected in binaries:
        actual = _sha256_file(binary)
        if actual != expected:
            _log_manifest_error_once(f"sha256 mismatch for {binary}")
            return None
    return schemas.DaemonTargetOut(spawnd_sha256=spawnd_sha, spawn_worker_sha256=worker_sha)


def read_prebuilt_manifest(
    *,
    repo_root: Path | None = None,
    manifest_path: Path | None = None,
) -> schemas.DaemonReleaseOut | None:
    """Read and fully verify the prebuilt manifest currently on disk."""

    root = repo_root or REPO_ROOT
    path = manifest_path or _manifest_path_for_root(repo_root=root)
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
    release_counter = raw.get("release_counter")
    signing_key_id = raw.get("signing_key_id")
    targets_raw = raw.get("targets")
    if (
        commit is None
        or tree is None
        or not isinstance(version, str)
        or not version.strip()
        or len(version) > 64
        or not isinstance(targets_raw, dict)
        or (
            release_counter is not None
            and (isinstance(release_counter, bool) or not isinstance(release_counter, int))
        )
        or (isinstance(release_counter, int) and release_counter < 0)
        or (signing_key_id is not None and not isinstance(signing_key_id, str))
    ):
        _log_manifest_error_once(f"{path} has invalid release fields")
        return None

    prebuilt_root = path.parent
    targets: dict[str, schemas.DaemonTargetOut] = {}
    for target, target_raw in targets_raw.items():
        pair = _verified_target_pair(prebuilt_root, target, target_raw, path=path, label="release")
        if pair is None:
            return None
        targets[target] = pair

    # The variants, held to the same proof. Absent or empty is the ordinary
    # case for a release with no variant builds; a manifest older than the
    # key has none. A variant may only cover a target whose release pair is
    # listed, and must report the release version with its own suffix — the
    # daemon refuses a downloaded binary that says anything else, so a
    # manifest that promised otherwise would only ever produce failed updates.
    variants_raw = raw.get("variants")
    if variants_raw is None:
        variants_raw = {}
    if not isinstance(variants_raw, dict):
        _log_manifest_error_once(f"{path} has an invalid variants map")
        return None
    variants: dict[str, schemas.DaemonVariantOut] = {}
    for variant, variant_raw in variants_raw.items():
        if variant not in SUPPORTED_DAEMON_VARIANTS or not isinstance(variant_raw, dict):
            _log_manifest_error_once(f"{path} has invalid variant {variant!r}")
            return None
        expected_version = variant_version(version.strip(), variant)
        variant_targets_raw = variant_raw.get("targets")
        if variant_raw.get("version") != expected_version or not isinstance(
            variant_targets_raw, dict
        ):
            _log_manifest_error_once(f"{path} has invalid release fields for variant {variant}")
            return None
        variant_targets: dict[str, schemas.DaemonTargetOut] = {}
        for target, target_raw in variant_targets_raw.items():
            if target not in targets:
                _log_manifest_error_once(
                    f"{path} lists variant {variant} for {target!r} without its release pair"
                )
                return None
            pair = _verified_target_pair(
                prebuilt_root, target, target_raw, path=path, label=variant, variant=variant
            )
            if pair is None:
                return None
            variant_targets[target] = pair
        variants[variant] = schemas.DaemonVariantOut(
            version=expected_version, targets=variant_targets
        )

    return schemas.DaemonReleaseOut(
        version=version.strip(),
        commit=commit,
        tree=tree,
        release_counter=release_counter,
        signed=Path(f"{path}.sig").is_file(),
        targets=targets,
        variants=variants,
    )


def desktop_image_name(version: str, platform: str) -> str:
    """The filename `scripts/publish-desktop.sh` uploads, and the one
    `desktopDownloadUrl` in `web/src/lib/platform.ts` builds a URL to. Held in
    one place on this side so the check and the link cannot disagree."""
    if platform == "windows-x86_64":
        return f"SPAWN-D_{version}_{platform}-setup.exe"
    return f"SPAWN-D_{version}_{platform}.dmg"


def desktop_release_dir() -> Path:
    """The directory `/desktop/` is served from on this deployment.

    Not derivable from the checkout: in production it is nginx's alias over
    `/var/www/spawnd/desktop` (`infra/nginx-spawnd.conf.example`), which the
    server's own tree knows nothing about. `SPAWN_DESKTOP_DIR` is the same
    variable name `scripts/publish-desktop.sh` uses for the upload target, on
    purpose — the publisher and the server are naming one directory.
    """
    configured = getattr(get_settings(), "desktop_dir", None)
    return Path(configured) if configured is not None else DEFAULT_DESKTOP_DIR


def published_desktop_platforms(version: str, *, root: Path | None = None) -> list[str] | None:
    """Which desktop images this deployment can actually hand over.

    `None` and `[]` are different answers and the distinction is the whole
    point. `[]` means the release directory is right there and this version is
    not in it — evidence, and the reason to stay quiet. `None` means there is
    nowhere to look, which is evidence of nothing at all.
    """
    directory = root if root is not None else desktop_release_dir()
    try:
        if not directory.is_dir():
            return None
        return [
            platform
            for platform in DESKTOP_PLATFORMS
            if _published_desktop_artifact_exists(directory / desktop_image_name(version, platform))
        ]
    except OSError:
        return None


def _published_desktop_artifact_exists(path: Path) -> bool:
    """A zero-byte placeholder is not a published desktop build."""
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _latest_published_desktop_version(directory: Path) -> str | None:
    """The version `scripts/publish-desktop.sh` last uploaded, read from the
    Tauri updater manifest it writes beside the images. Only the version is
    taken on faith — whether that version's images are still present is
    re-proven against the directory exactly like the checkout's own."""
    try:
        raw = json.loads((directory / "latest.json").read_text())
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    return _clean_desktop_version(raw.get("version"))


def _warn_missing_desktop_dir_once(directory: Path) -> None:
    global _desktop_dir_warned
    if is_local_deployment(getattr(get_settings(), "public_url", "")):
        # A laptop has no static release origin. `/desktop/` there is Next
        # serving `web/public/desktop`, and `/desktop-build` already answers
        # for it, so an absent `/var/www/...` means nothing worth saying.
        return
    if _desktop_dir_warned:
        return
    _desktop_dir_warned = True
    log.error(
        "desktop release directory %s does not exist, so /api/release advertises a "
        "desktop version without proof that its images were ever published. Set "
        "SPAWN_DESKTOP_DIR to the static root nginx serves at /desktop/ "
        "(docs/RELEASE.md, The desktop app).",
        directory,
    )


def desktop_release(identity: _ReleaseIdentity | None = None) -> schemas.ReleaseDesktop | None:
    """The desktop block, advertised only for images that are really there.

    The daemon block has been provable since it existed: `/api/release` names
    a daemon only when `manifest.json` validates and every binary it lists is
    on disk with the advertised hash. The desktop block was not, and the gap
    had teeth — the version here is computed from the deployed checkout's
    `tauri.conf.json`, `web/src/lib/platform.ts` builds each download URL
    straight out of it, and a deploy that lands before
    `scripts/publish-desktop.sh` therefore points the download button at a
    file that does not exist.

    Two absences, deliberately not treated alike:

    - **The release directory exists and the image is not in it.** That is a
      release which has not been published yet. Advertise the build
      `publish-desktop.sh` last uploaded instead: its `latest.json` names the
      version, and the directory still has to prove that version's images the
      usual way. The old build's tree is unknowable from disk, so it goes out
      as None. With no readable manifest, or one whose images are also gone,
      say nothing, exactly as the daemon block says nothing without a
      manifest — the download surfaces fall through to `/desktop-build` and
      then to "Coming soon".
    - **The release directory does not exist.** Then nothing has been
      established, and withholding the block would trade a 404 for a Mac
      download that quietly disappears — which reads as a product decision
      rather than a broken deploy, and would go unnoticed far longer. So it is
      advertised exactly as before and the server says loudly, once, that it
      could not check. Failing open is only defensible when it is not silent.
    """
    identity = _current_identity() if identity is None else identity
    version, tree = identity.desktop_version, identity.desktop_tree
    if version is None or tree is None:
        return None

    directory = desktop_release_dir()
    published = published_desktop_platforms(version, root=directory)
    if published is None:
        _warn_missing_desktop_dir_once(directory)
        return schemas.ReleaseDesktop(
            version=version, tree=tree, platforms=list(FAIL_OPEN_DESKTOP_PLATFORMS)
        )
    if PRIMARY_DESKTOP_PLATFORM not in published:
        # A deploy that landed before its publish. The gap is real but it is
        # not a reason to pull a download that was fine yesterday.
        previous = _latest_published_desktop_version(directory)
        if previous is None:
            return None
        previous_published = published_desktop_platforms(previous, root=directory)
        if previous_published is None or PRIMARY_DESKTOP_PLATFORM not in previous_published:
            return None
        return schemas.ReleaseDesktop(version=previous, tree=None, platforms=previous_published)
    # Narrowed to what is on disk, so the Intel link on /download appears only
    # when the Intel image does. A finished `publish-desktop.sh` uploads both
    # or neither, so a real release still lists both.
    return schemas.ReleaseDesktop(version=version, tree=tree, platforms=published)


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
        desktop=desktop_release(identity),
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
    os_part = {
        "darwin": "darwin",
        "macos": "darwin",
        "linux": "linux",
        "windows": "windows",
    }.get((os_name or "").lower())
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
        "invalid_variant": "SPAWND_RELEASE_VARIANT names a release variant that does not exist",
        "task_breakaway_unconfirmed": (
            "Task Scheduler has not confirmed that session workers survive updates"
        ),
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
    def result(value: schemas.HostUpdateOut) -> schemas.HostUpdateOut:
        if host.worker_mismatch:
            value.error = "worker_mismatch"
        return value

    if manifest is None:
        manifest = read_prebuilt_manifest()
    if manifest is None or (host.daemon_tree or "").endswith("-dirty"):
        return result(schemas.HostUpdateOut(state="unknown"))
    if host.daemon_tree is None:
        return result(
            schemas.HostUpdateOut(
                state="unsupported",
                latest_version=manifest.version,
                error="This daemon is too old to update itself",
            )
        )
    if host.daemon_tree == manifest.tree:
        return result(schemas.HostUpdateOut(state="current", latest_version=manifest.version))

    requested_at = _aware_utc(host.update_requested_at)
    current_time = now or datetime.now(UTC)
    if (
        host.update_state == "updating"
        and requested_at is not None
        and current_time - requested_at <= DAEMON_UPDATE_TIMEOUT
    ):
        return result(
            schemas.HostUpdateOut(
                state="updating",
                latest_version=manifest.version,
                requested_at=requested_at,
            )
        )
    if host.update_state == "failed" and host.update_tree == manifest.tree:
        return result(
            schemas.HostUpdateOut(
                state="failed",
                latest_version=manifest.version,
                error=host.update_error,
                requested_at=requested_at,
            )
        )
    if not host.self_update:
        return result(
            schemas.HostUpdateOut(
                state="unsupported",
                latest_version=manifest.version,
                error=humanize_self_update_blocked(host.self_update_blocked),
            )
        )
    return result(schemas.HostUpdateOut(state="available", latest_version=manifest.version))


def daemon_update_payload(
    host: Host,
    manifest: schemas.DaemonReleaseOut,
    *,
    request_id: str | None = None,
    allow_downgrade: bool = False,
) -> dict[str, Any] | None:
    target = daemon_target(host.os, host.arch)
    target_release = manifest.targets.get(target or "")
    if target is None or target_release is None:
        return None
    payload: dict[str, Any] = {
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
    if allow_downgrade:
        payload["allow_downgrade"] = True
    return payload


def mark_update_requested(
    host: Host,
    manifest: schemas.DaemonReleaseOut,
    *,
    now: datetime | None = None,
    allow_downgrade: bool = False,
) -> dict[str, Any] | None:
    payload = daemon_update_payload(host, manifest, allow_downgrade=allow_downgrade)
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
