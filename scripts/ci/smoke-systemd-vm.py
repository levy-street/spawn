#!/usr/bin/env python3
"""Exercise the real user service manager in a disposable, networkless VM."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid


def run(*args):
    subprocess.run(args, check=True)


def main():
    if (os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
            or os.environ.get("RUNNER_OS") != "Linux" or os.geteuid() == 0):
        raise SystemExit("systemd VM smoke requires an unprivileged hosted Linux runner")
    root = Path(__file__).resolve().parents[2]
    output = Path(os.environ["RUNNER_TEMP"]) / "spawnd-systemd-smoke-serial.log"
    with tempfile.TemporaryDirectory(prefix="spawnd-systemd-vm-", dir=os.environ["RUNNER_TEMP"]) as directory:
        scratch = Path(directory)
        base = "https://cloud-images.ubuntu.com/jammy/current/"
        image = "jammy-server-cloudimg-amd64.img"
        for name in ("SHA256SUMS", "SHA256SUMS.gpg", image):
            run("curl", "-fsSL", "--retry", "3", base + name, "-o", str(scratch / name))
        run("gpgv", "--keyring", "/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg",
            str(scratch / "SHA256SUMS.gpg"), str(scratch / "SHA256SUMS"))
        expected = [line.split()[0] for line in (scratch / "SHA256SUMS").read_text().splitlines()
                    if line.split()[-1].lstrip("*") == image]
        with (scratch / image).open("rb") as stream:
            observed = hashlib.file_digest(stream, "sha256").hexdigest()
        if expected != [observed]:
            raise SystemExit("Ubuntu cloud image checksum mismatch")
        print(f"Verified Ubuntu 22.04 cloud image SHA256={observed}", flush=True)
        guest = """#!/bin/bash
exec >/dev/ttyS0 2>&1
set -euo pipefail
finish() {
  result=$?
  trap - EXIT
  printf '\\nSPAWND_SYSTEMD_SMOKE_RESULT=%s\\n' "$result"
  systemctl poweroff
}
trap finish EXIT
uid="$(id -u spawnd-ci)"
loginctl enable-linger spawnd-ci
systemctl start "user@$uid.service"
export XDG_RUNTIME_DIR="/run/user/$uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
as_ci() {
  runuser -u spawnd-ci -- env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \\
    DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" "$@"
}
# Refuse a skip: the guest must have a running, real systemd user manager.
as_ci systemctl --user show-environment
as_ci bash /opt/spawnd-service-smoke.sh systemd-user
"""
        config = {
            "users": [{"name": "spawnd-ci", "groups": "users", "shell": "/bin/bash",
                       "lock_passwd": True, "sudo": False}],
            "ssh_pwauth": False, "disable_root": True,
            "package_update": False, "package_upgrade": False,
            "write_files": [
                {"path": "/opt/spawnd-service-smoke.sh", "permissions": "0755",
                 "content": (root / "scripts/smoke-service-manager.sh").read_text()},
                {"path": "/opt/spawnd-run-smoke.sh", "permissions": "0700", "content": guest},
            ],
            "runcmd": [["bash", "/opt/spawnd-run-smoke.sh"]],
        }
        (scratch / "user-data").write_text("#cloud-config\n" + json.dumps(config))
        (scratch / "meta-data").write_text(json.dumps({"instance-id": "spawnd-ci-" + uuid.uuid4().hex,
                                                     "local-hostname": "spawnd-systemd-smoke"}))
        (scratch / "network-config").write_text(json.dumps({"version": 2, "ethernets": {}}))
        run("cloud-localds", "--network-config=" + str(scratch / "network-config"),
            str(scratch / "seed.img"), str(scratch / "user-data"), str(scratch / "meta-data"))
        run("qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(scratch / image),
            str(scratch / "guest.qcow2"), "4G")
        try:
            subprocess.run([
                "qemu-system-x86_64", "-accel", "tcg,thread=multi", "-cpu", "max",
                "-smp", "2", "-m", "1024", "-display", "none", "-monitor", "none",
                "-serial", "file:" + str(output), "-nic", "none", "-no-reboot",
                "-drive", f"file={scratch / 'guest.qcow2'},format=qcow2,if=virtio",
                "-drive", f"file={scratch / 'seed.img'},format=raw,if=virtio",
            ], check=True, timeout=900)
        finally:
            if output.exists():
                print(output.read_text(errors="replace")[-24000:], flush=True)
        report = output.read_text(errors="replace")
        if ("\nSPAWND_SYSTEMD_SMOKE_RESULT=0\n" not in report.replace("\r", "")
                or "smoke-service-manager: systemd user restart smoke passed" not in report):
            raise SystemExit("guest did not prove the systemd restart smoke passed")
        print("Networkless systemd VM smoke passed", flush=True)


if __name__ == "__main__":
    main()
