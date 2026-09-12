#!/usr/bin/env python3
"""Restore the release account's keychain list after one daemon signing job."""

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess


def paths():
    root = Path(os.environ["RUNNER_TEMP"])
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise ValueError("RUNNER_TEMP must be an existing absolute directory")
    snapshot = root / "spawnd-keychain-search-list.json"
    keychain = root / "spawnd-signing.keychain-db"
    if snapshot.is_symlink() or keychain.is_symlink():
        raise ValueError("refusing redirected signing state")
    return snapshot, keychain


def save():
    snapshot, _ = paths()
    search = shlex.split(subprocess.check_output(["security", "list-keychains", "-d", "user"], text=True))
    with snapshot.open("x") as output:
        json.dump(search, output)


def restore():
    snapshot, keychain = paths()
    search = json.loads(snapshot.read_text())
    if not isinstance(search, list) or not all(isinstance(p, str) and p.startswith("/") and "\0" not in p for p in search):
        raise ValueError("invalid saved keychain search list")
    try:
        if keychain.exists():
            subprocess.run(["security", "delete-keychain", str(keychain)], check=True)
    finally:
        subprocess.run(["security", "list-keychains", "-d", "user", "-s", *search], check=True)
    snapshot.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("save", "restore"))
    args = parser.parse_args()
    (save if args.operation == "save" else restore)()
