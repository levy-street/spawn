#!/usr/bin/env python3
"""Refuse Mac runner startup unless the account and release policy are isolated."""

import argparse
import os
from pathlib import Path
import platform
import subprocess


HOOK = Path("/Library/Application Support/SPAWN D CI/release-job-hook.sh")


def check_hook(path=HOOK):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"Missing regular protected release hook: {path}")
    for entry in (path, *path.parents):
        if entry.is_symlink() or entry.stat().st_uid != 0 or os.access(entry, os.W_OK):
            raise RuntimeError(f"Release hook or ancestor is not protected from the job account: {entry}")
    base = {"PATH": "/usr/bin:/bin", "GITHUB_REPOSITORY": "levy-street/spawn",
            "GITHUB_REF": "refs/heads/master", "GITHUB_EVENT_NAME": "push"}
    for workflow in ("prebuilt", "desktop"):
        approved = {**base, "GITHUB_WORKFLOW_REF":
                    f"levy-street/spawn/.github/workflows/{workflow}.yml@refs/heads/master"}
        cases = [(approved, True),
                 ({**approved, "GITHUB_REF": "refs/heads/transport/device-daemon"}, False),
                 ({**approved, "GITHUB_REF": "refs/pull/87/merge", "GITHUB_EVENT_NAME": "pull_request"}, False),
                 ({**approved, "GITHUB_EVENT_NAME": "pull_request_target"}, False),
                 ({**approved, "GITHUB_REPOSITORY": "another/repository"}, False),
                 ({**approved, "GITHUB_WORKFLOW_REF":
                   "levy-street/spawn/.github/workflows/windows.yml@refs/heads/master"}, False),
                 ({}, False)]
        for environment, expected in cases:
            result = subprocess.run(["/bin/bash", str(path)], env=environment,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if (result.returncode == 0) != expected:
                raise RuntimeError("Installed release hook failed its allow/deny checks")


def check_identity(role):
    import pwd

    identity = pwd.getpwuid(os.getuid())
    expected = f"spawnd-ci-{role}"
    if identity.pw_name != expected or identity.pw_uid == 0:
        raise RuntimeError(f"Run this installer only as the dedicated standard account {expected}")
    groups = subprocess.check_output(["/usr/bin/id", "-Gn"], text=True).split()
    if "admin" in groups:
        raise RuntimeError("A CI identity must not be an administrator")
    home = Path(identity.pw_dir)
    if home != Path("/Users", expected) or home != Path.home() or home.is_symlink():
        raise RuntimeError("Unexpected or shared CI account home")
    if home.stat().st_uid != identity.pw_uid or home.stat().st_mode & 0o077:
        raise RuntimeError("The CI account home must be owned by it with mode 0700")
    other = Path("/Users", "spawnd-ci-release" if role == "build" else "spawnd-ci-build")
    if not other.exists() or os.access(other, os.R_OK) or os.access(other, os.X_OK):
        raise RuntimeError("The two CI homes must exist and be isolated from one another")
    for tool in (Path("/opt/homebrew/bin"), Path("/opt/homebrew/Cellar")):
        if not tool.is_dir() or os.access(tool, os.W_OK):
            raise RuntimeError(f"CI must not own or be able to modify shared tooling: {tool}")
    if role == "release":
        check_hook()
    result = subprocess.run(["/bin/launchctl", "print", f"gui/{identity.pw_uid}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise RuntimeError(f"Log into {expected} locally before installing its official LaunchAgent")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--role", choices=("build", "release"))
    mode.add_argument("--hook-only", action="store_true")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64" or os.geteuid() == 0:
        raise RuntimeError("Run this check as a standard user on native ARM64 macOS")
    if args.hook_only:
        check_hook()
    else:
        check_identity(args.role)
    print("Mac runner account/policy checks passed")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        raise SystemExit(f"Mac runner preflight: {exc}") from None
