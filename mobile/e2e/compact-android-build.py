#!/usr/bin/env python3
"""Keep the hosted acceptance APK and discard only its disposable build trees."""

import argparse
import json
from pathlib import Path
import re
import shutil


def compact(build: Path, runner_temp: Path) -> None:
    expected = runner_temp.resolve(strict=True) / "native-app"
    if build.is_symlink() or build.resolve(strict=True) != expected:
        raise ValueError("Cleanup requires RUNNER_TEMP/native-app without a symlink")
    build = expected
    manifest_file = build / "acceptance-build.json"
    artifact_file = build / "native-artifact.txt"
    for metadata in (manifest_file, artifact_file):
        if metadata.is_symlink() or not metadata.is_file():
            raise ValueError("Build metadata must be owned regular files")
    manifest = json.loads(manifest_file.read_text())
    if (
        manifest.get("platform") != "android"
        or manifest.get("app_id") != "dev.spawnd.acceptance"
        or manifest.get("configuration") != "Release"
        or manifest.get("source_clean") is not True
        or not re.fullmatch(r"[0-9a-f]{40}", manifest.get("candidate_commit", ""))
    ):
        raise ValueError("Cleanup requires an exact candidate Android acceptance build")
    generated = [build / "android", build / "node_modules"]
    for directory in generated:
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError("Generated build directories must be owned real directories")
    entries = artifact_file.read_text().splitlines()
    if len(entries) != 1:
        raise ValueError("Exactly one built APK is required before cleanup")
    artifact = Path(entries[0])
    release = build / "android/app/build/outputs/apk/release"
    if (
        artifact.is_symlink()
        or not artifact.is_file()
        or artifact.suffix != ".apk"
        or artifact.resolve().parent != release
    ):
        raise ValueError("The built APK must belong to this disposable Release output")
    staged = build / "native-build"
    if staged.exists() or staged.is_symlink():
        raise ValueError("APK staging directory must be new")
    before = shutil.disk_usage(build).free
    staged.mkdir()
    destination = staged / "acceptance.apk"
    # Rename on the same filesystem: staging needs no second APK-sized copy
    # when the runner is already close to full.
    artifact.rename(destination)
    artifact_file.write_text(str(destination) + "\n")
    for directory in generated:
        shutil.rmtree(directory)
    after = shutil.disk_usage(build).free
    print(f"Android build cleanup: reclaimed {after - before} bytes; {after} bytes free")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", type=Path)
    parser.add_argument("runner_temp", type=Path)
    args = parser.parse_args()
    compact(args.build, args.runner_temp)
