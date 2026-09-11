#!/usr/bin/env python3
"""Remove ephemeral fixture credentials before uploading native evidence."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re


def redact(value: str, secrets: list[str]) -> str:
    for secret in sorted(secrets, key=len, reverse=True):
        if secret:
            value = value.replace(secret, "[REDACTED]")
    value = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED_JWT]", value)
    return re.sub(r"(?i)(Bearer\s+)[A-Za-z0-9._~+-]+", r"\1[REDACTED]", value)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ready-file", type=Path, required=True)
    args = parser.parse_args()
    if not args.output.exists():
        return
    secrets = []
    if args.ready_file.exists():
        ready = json.loads(args.ready_file.read_text())
        secrets.append(ready["token"])
        secrets.extend(str(server["credential"]) for server in ready.get("iceServers", [])
                       if "credential" in server)
    if args.ready_file.resolve().is_relative_to(args.output.resolve()):
        raise ValueError("Private ready file must be outside the artifact directory")
    for path in args.output.rglob("*"):
        if path.is_symlink():
            raise ValueError("Evidence artifacts must not follow symlinks")
        if path.is_file() and path.suffix in {".json", ".jsonl", ".log", ".txt"}:
            original = path.read_text(errors="replace")
            sanitized = redact(original, secrets)
            if sanitized != original:
                path.write_text(sanitized)


if __name__ == "__main__":
    main()
