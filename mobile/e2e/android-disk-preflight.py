#!/usr/bin/env python3
"""Measure Android headroom; tool reclamation is limited to hosted runners."""

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

GIB = 1024**3
MIN_FREE = {"prepare": 15 * GIB, "build": 15 * GIB, "emulator": 16 * GIB}
# Preserve ample build/emulator space without walking or deleting preinstalled
# tool trees on hosted images that already have more than enough free space.
PREPARE_RESERVE = 40 * GIB
# Verified against actions/runner-images ubuntu24/20260907.300 installation
# scripts. No Android, Java, Node, Rust, Python, shared compiler or user paths.
UNUSED_TOOLS = (
    Path("/usr/share/dotnet"),
    Path("/usr/local/.ghcup"),
    Path("/opt/hostedtoolcache/CodeQL"),
    Path("/usr/share/swift"),
)


def require_hosted_android() -> None:
    required = {
        "GITHUB_ACTIONS": "true",
        "RUNNER_ENVIRONMENT": "github-hosted",
        "RUNNER_OS": "Linux",
        "ImageOS": "ubuntu24",
        "NATIVE_PLATFORM": "android",
    }
    for name, value in required.items():
        if os.environ.get(name) != value:
            raise RuntimeError(f"Disk preflight requires {name}={value}")
    release = platform.freedesktop_os_release()
    if platform.system() != "Linux" or (release.get("ID"), release.get("VERSION_ID")) != ("ubuntu", "24.04"):
        raise RuntimeError("Disk preflight requires the hosted Ubuntu 24.04 image")


def require_self_hosted_android() -> None:
    for name, value in {
        "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "self-hosted",
        "RUNNER_OS": "Linux", "NATIVE_PLATFORM": "android",
    }.items():
        if os.environ.get(name) != value:
            raise RuntimeError(f"Disk preflight requires {name}={value}")
    if platform.system() != "Linux":
        raise RuntimeError("Android runner must use Linux")


def disk_snapshot(stage: str, event: str) -> dict[str, int]:
    paths = [Path("/")]
    for name in ("RUNNER_TEMP", "GITHUB_WORKSPACE", "ANDROID_HOME"):
        path = Path(os.environ[name])
        if not path.is_absolute() or not path.is_dir():
            raise RuntimeError(f"Disk preflight requires an existing absolute {name}")
        paths.append(path.resolve(strict=True))
    free = {str(path): shutil.disk_usage(path).free for path in paths}
    print(json.dumps({"stage": stage, "event": event, "free_bytes": free}), flush=True)
    return free


def reclaim_tools() -> None:
    # Check every root before the first mutation. In particular, do not follow
    # a future image's relocated tool installation through a symlink.
    present = []
    for path in UNUSED_TOOLS:
        if path.is_symlink() or path.resolve() != path:
            raise RuntimeError(f"Refusing redirected preinstalled tool path: {path}")
        if path.exists():
            if not path.is_dir() or path.is_mount():
                raise RuntimeError(f"Refusing non-directory or mounted tool path: {path}")
            present.append(path)
    for path in present:
        print(json.dumps({"event": "reclaim_tool", "path": str(path)}), flush=True)
        subprocess.run(
            ["sudo", "-n", "rm", "-rf", "--one-file-system", "--preserve-root=all", "--", str(path)],
            check=True, timeout=90,
        )


def preflight(stage: str, *, self_hosted: bool = False) -> None:
    if self_hosted:
        require_self_hosted_android()
    else:
        require_hosted_android()
    minimum = MIN_FREE[stage]
    before = disk_snapshot(stage, "before")
    if stage == "prepare" and not self_hosted and min(before.values()) < PREPARE_RESERVE:
        reclaim_tools()
    free = disk_snapshot(stage, "after")
    insufficient = {path: value for path, value in free.items() if value < minimum}
    if insufficient:
        raise RuntimeError(
            f"Android {stage} needs at least {minimum // GIB} GiB free on every involved filesystem; "
            f"available bytes: {insufficient}"
        )
    print(json.dumps({"stage": stage, "event": "headroom_passed", "minimum_free_bytes": minimum}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=MIN_FREE)
    parser.add_argument("--self-hosted", action="store_true", help="Measure only; never delete host tooling")
    args = parser.parse_args()
    preflight(args.stage, self_hosted=args.self_hosted)
