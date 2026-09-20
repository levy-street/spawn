#!/usr/bin/env python3
"""Verify a staged daemon snapshot, then atomically select it for serving."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from spawn_server.release import read_prebuilt_manifest  # noqa: E402


def activate(
    root: Path, stage: Path, tree: str, manifest_sha: str, signature_sha: str
) -> Path:
    root = root.resolve()
    stage = stage.absolute()
    if (
        stage.parent != root / "releases"
        or not stage.name.startswith(".staging-")
        or stage.resolve() != stage
        or not stage.is_dir()
    ):
        raise ValueError("snapshot must be a private staging directory under releases")
    if any(path.is_symlink() for path in stage.rglob("*")):
        raise ValueError("snapshot must not contain mutable symlink targets")
    for name, expected in (
        ("manifest.json", manifest_sha),
        ("manifest.json.sig", signature_sha),
    ):
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError("expected digest must be a complete SHA256")
        if hashlib.sha256((stage / name).read_bytes()).hexdigest() != expected:
            raise ValueError(f"{name} differs from the locally signed release")
    manifest = read_prebuilt_manifest(manifest_path=stage / "manifest.json")
    if manifest is None or not manifest.targets or manifest.tree != tree:
        raise ValueError("snapshot binaries or daemon identity failed verification")

    published = stage.with_name(stage.name.replace(".staging-", "release-", 1))
    # The old generation is never modified or deleted. Interruption before the
    # pointer swap leaves it live; interruption after the swap leaves the entire
    # verified new generation live. Abandoned stages are safe to inspect later.
    stage.rename(published)
    pointer = root / (".current-" + published.name)
    try:
        pointer.symlink_to(published.relative_to(root), target_is_directory=True)
        os.replace(pointer, root / "current")
    finally:
        pointer.unlink(missing_ok=True)
    return published


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("stage", type=Path)
    parser.add_argument("tree")
    parser.add_argument("manifest_sha")
    parser.add_argument("signature_sha")
    args = parser.parse_args()
    print(
        activate(
            args.root, args.stage, args.tree, args.manifest_sha, args.signature_sha
        )
    )
