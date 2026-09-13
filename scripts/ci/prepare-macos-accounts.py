#!/usr/bin/env python3
"""Create isolated Mac CI accounts; keep generated passwords in the operator Keychain."""

import argparse
import ctypes
import json
import os
from pathlib import Path
import platform
import re
import secrets
import select
import shutil
import signal
import stat
import subprocess
import sys
import time

if os.name == "posix":
    import pwd


ACCOUNTS = ("spawnd-ci-build", "spawnd-ci-release")
SERVICE = b"dev.spawnd.ci.local-service-account"
PROTECTED = Path("/Library/Application Support/SPAWN D CI")


class Keychain:
    def __init__(self, home):
        self.api = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
        pointer, uint = ctypes.c_void_p, ctypes.c_uint32
        signatures = {
            "SecKeychainSetUserInteractionAllowed": [ctypes.c_bool],
            "SecKeychainOpen": [ctypes.c_char_p, ctypes.POINTER(pointer)],
            "SecKeychainFindGenericPassword": [pointer, uint, pointer, uint, pointer,
                                              ctypes.POINTER(uint), ctypes.POINTER(pointer), pointer],
            "SecKeychainAddGenericPassword": [pointer, uint, pointer, uint, pointer,
                                             uint, pointer, pointer],
            "SecKeychainItemFreeContent": [pointer, pointer],
        }
        for name, arguments in signatures.items():
            function = getattr(self.api, name)
            function.argtypes = arguments
            function.restype = ctypes.c_int32
        self.check(self.api.SecKeychainSetUserInteractionAllowed(False))
        self.handle = ctypes.c_void_p()
        path = str(Path(home) / "Library/Keychains/login.keychain-db").encode()
        self.check(self.api.SecKeychainOpen(path, ctypes.byref(self.handle)))

    @staticmethod
    def check(status):
        if status:
            raise RuntimeError(f"Keychain status {status}; unlock the operator login Keychain locally")

    def read(self, account):
        name = account.encode()
        length = ctypes.c_uint32()
        data = ctypes.c_void_p()
        status = self.api.SecKeychainFindGenericPassword(
            self.handle, len(SERVICE), SERVICE, len(name), name,
            ctypes.byref(length), ctypes.byref(data), None,
        )
        if status == -25300:
            return None
        self.check(status)
        try:
            return ctypes.string_at(data, length.value).decode()
        finally:
            self.api.SecKeychainItemFreeContent(None, data)

    def create(self, account, password):
        name, value = account.encode(), password.encode()
        self.check(self.api.SecKeychainAddGenericPassword(
            self.handle, len(SERVICE), SERVICE, len(name), name,
            len(value), value, None,
        ))


def require_new_accounts():
    for account in ACCOUNTS:
        try:
            pwd.getpwnam(account)
        except KeyError:
            pass
        else:
            raise RuntimeError(f"{account} already exists; inspect the partial setup before proceeding")
        if os.path.lexists(Path("/Users", account)):
            raise RuntimeError(f"Refusing to overwrite /Users/{account}")


def password_prompt(command, password, timeout=60):
    """Answer the native secure prompt through a private PTY, never argv or logs."""
    import pty
    import termios

    child, descriptor = pty.fork()
    if child == 0:
        settings = termios.tcgetattr(0)
        settings[3] &= ~(termios.ECHO | termios.ECHONL)
        termios.tcsetattr(0, termios.TCSANOW, settings)
        os.execv(command[0], command)
    pending = b""
    sent = False
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([descriptor], [], [], 0.2)
            if ready:
                try:
                    block = os.read(descriptor, 4096)
                except OSError:
                    block = b""
                pending = (pending + block)[-8192:]
                if not sent and re.search(rb"(?i)(?:^|[\r\n])[^\r\n]*password[^\r\n]*:\s*$", pending):
                    os.write(descriptor, password.encode() + b"\n")
                    sent = True
            observed, result = os.waitpid(child, os.WNOHANG)
            if observed:
                return os.waitstatus_to_exitcode(result), sent
        os.kill(child, signal.SIGKILL)
        os.waitpid(child, 0)
        raise RuntimeError("Account command timed out; inspect its state before retrying")
    finally:
        os.close(descriptor)


def prepare(operator):
    if os.getuid() != operator.pw_uid or os.geteuid() == 0:
        raise RuntimeError("Prepare credentials as the operator, without sudo")
    require_new_accounts()
    keychain = Keychain(operator.pw_dir)
    for account in ACCOUNTS:
        existing = keychain.read(account)
        if existing is None:
            value = secrets.token_urlsafe(36)
            keychain.create(account, value)
            if keychain.read(account) != value:
                raise RuntimeError("Keychain round-trip verification failed")
        print(f"Prepared protected Keychain credential for {account}")


def provide_secrets(operator, descriptor):
    if os.getuid() != operator.pw_uid or descriptor < 3:
        raise RuntimeError("Internal credential handoff requires the operator and an inherited pipe")
    if not stat.S_ISFIFO(os.fstat(descriptor).st_mode):
        raise RuntimeError("Credential handoff must use an anonymous pipe")
    keychain = Keychain(operator.pw_dir)
    values = {account: keychain.read(account) for account in ACCOUNTS}
    if not all(values.values()):
        raise RuntimeError("Run --prepare as the operator first")
    with os.fdopen(descriptor, "w") as stream:
        json.dump(values, stream)


def apply(operator):
    if os.geteuid() != 0:
        raise RuntimeError("Creating local accounts requires a local sudo authentication")
    require_new_accounts()
    if os.path.lexists(PROTECTED):
        raise RuntimeError(f"{PROTECTED} already exists; inspect before resuming")
    source = Path(__file__).resolve().parent
    inputs = ("install-macos-runner.sh", "runner-versions.json", "check-macos-runner.py")
    for name in (*inputs, "release-job-hook.sh"):
        path = source / name
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"Missing regular setup input: {path}")
    read_end, write_end = os.pipe()
    environment = {**os.environ, "HOME": operator.pw_dir, "USER": operator.pw_name,
                   "LOGNAME": operator.pw_name}
    child = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--operator", operator.pw_name,
         "--provide-secrets-fd", str(write_end)],
        user=operator.pw_uid, group=operator.pw_gid, extra_groups=[],
        pass_fds=(write_end,), env=environment,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    os.close(write_end)
    with os.fdopen(read_end) as stream:
        payload = stream.read()
    child.communicate()
    if child.returncode:
        raise RuntimeError("Cannot read prepared operator Keychain credentials; run --prepare locally")
    values = json.loads(payload)
    if any(not re.fullmatch(r"[A-Za-z0-9_-]{48}", values.get(name, "")) for name in ACCOUNTS):
        raise RuntimeError("Prepared CI credentials do not match the generated password format")
    for account in ACCOUNTS:
        result, sent = password_prompt([
            "/usr/sbin/sysadminctl", "-addUser", account,
            "-fullName", f"SPAWN D CI {account.rsplit('-', 1)[-1]}",
            "-home", f"/Users/{account}", "-shell", "/bin/bash", "-password", "-",
        ], values[account])
        if result or not sent:
            raise RuntimeError(f"Account creation failed for {account}; inspect before retrying")
        groups = subprocess.check_output(["/usr/bin/id", "-Gn", account], text=True).split()
        if "admin" in groups or pwd.getpwnam(account).pw_uid == 0:
            raise RuntimeError(f"Refusing an administrator CI identity: {account}")
        subprocess.run(["/usr/sbin/createhomedir", "-c", "-u", account],
                       check=True, stdout=subprocess.DEVNULL)
        home = Path("/Users", account)
        identity = pwd.getpwnam(account)
        if home.is_symlink() or home.stat().st_uid != identity.pw_uid:
            raise RuntimeError(f"Unexpected home ownership for {account}")
        os.chmod(home, 0o700)
        # Deny only the newly created CI identity; preserve existing operator
        # permissions and every unrelated account/service's access.
        subprocess.run(["/bin/chmod", "+a", f"user:{account} deny read,execute",
                        operator.pw_dir], check=True)
        setup = home / "spawnd-ci/setup"
        setup.mkdir(parents=True, mode=0o700)
        for directory in (setup.parent, setup):
            os.chown(directory, identity.pw_uid, identity.pw_gid)
            os.chmod(directory, 0o700)
        for name in inputs:
            target = setup / name
            shutil.copyfile(source / name, target)
            os.chown(target, identity.pw_uid, identity.pw_gid)
            os.chmod(target, 0o600)
        print(f"Created standard account {account} with a private home")
    PROTECTED.mkdir(mode=0o755)
    hook = PROTECTED / "release-job-hook.sh"
    shutil.copyfile(source / hook.name, hook)
    os.chown(PROTECTED, 0, 0)
    os.chown(hook, 0, 0)
    os.chmod(PROTECTED, 0o755)
    os.chmod(hook, 0o755)
    for account in ACCOUNTS:
        other = next(name for name in ACCOUNTS if name != account)
        for protected in (operator.pw_dir, f"/Users/{other}"):
            probe = subprocess.run(["/usr/bin/sudo", "-H", "-u", account,
                                    "/bin/test", "-r", protected])
            if probe.returncode != 1:
                raise RuntimeError(f"{account} can read a protected profile; no services may start")
        subprocess.run(["/usr/bin/sudo", "-H", "-u", account, "/opt/homebrew/bin/python3",
                        f"/Users/{account}/spawnd-ci/setup/check-macos-runner.py", "--hook-only"], check=True)
    print("Account passwords remain in the operator login Keychain; no runner services have started.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operator", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--provide-secrets-fd", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("This bootstrap requires native ARM64 macOS")
    operator = pwd.getpwnam(args.operator)
    if operator.pw_uid == 0 or operator.pw_name in ACCOUNTS:
        raise RuntimeError("The operator must be separate from root and the CI accounts")
    if Path(operator.pw_dir).parent != Path("/Users"):
        raise RuntimeError("The operator must have a normal local Mac home")
    os.umask(0o077)
    if args.prepare:
        prepare(operator)
    elif args.apply:
        apply(operator)
    else:
        provide_secrets(operator, args.provide_secrets_fd)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Mac CI account setup: {exc}", file=sys.stderr)
        raise SystemExit(1)
