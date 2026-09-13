#!/usr/bin/env python3
"""Keep one-job Linux runners online; credentials stay on the operator machine."""

import argparse
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import uuid

STOP = threading.Event()
OWNER_LABEL = "dev.spawnd.ci.managed"
LOCAL_HOST = None
AUTH_SOURCE = "gh"


def validate_config(config):
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", config["repository"]):
        raise ValueError("invalid repository")
    if not re.fullmatch(r"spawnd-ci-linux:[\w.-]+", config["image"]):
        raise ValueError("only the dedicated runner image is allowed")
    labels = set()
    for pool in config["pools"]:
        label = pool["label"]
        if not re.fullmatch(r"spawn-linux-[a-z0-9-]+", label) or label in labels:
            raise ValueError("invalid or duplicate pool label")
        labels.add(label)
        if not re.fullmatch(r"[a-zA-Z0-9][\w.-]*", pool["host"]):
            raise ValueError("host must be an SSH alias")
        if pool["host"] != "minivac":
            raise ValueError("all Linux pools must run on Minivac")
        extra = pool.get("extra_labels", [])
        if extra not in ([], ["spawn-minivac"]) or (extra and pool["host"] != "minivac"):
            raise ValueError("placement label must match the Minivac host")
        if label in ("spawn-linux-build", "spawn-linux-android") and extra != ["spawn-minivac"]:
            raise ValueError("Linux x64 builders must be explicitly placed on Minivac")
        for field, low, high in [("count", 1, 4), ("cpus", 1, 8), ("memory_gib", 1, 64)]:
            if type(pool[field]) is not int or not low <= pool[field] <= high:
                raise ValueError(f"invalid {field}")
        home = pool.get("home_gib", 0)
        if type(home) is not int or home < 0 or home >= pool["memory_gib"]:
            raise ValueError("tmpfs must leave memory for the compiler and emulator")
        scratch = pool.get("tmp_gib", 0)
        if type(scratch) is not int or scratch < 0:
            raise ValueError("invalid scratch limit")
        if home + scratch and home + scratch > pool["memory_gib"] - 4:
            raise ValueError("combined tmpfs limits must leave at least 4 GiB for processes")
        if type(pool.get("kvm", False)) is not bool:
            raise ValueError("kvm must be a boolean")
        if type(pool.get("enabled", True)) is not bool:
            raise ValueError("enabled must be a boolean")
        if pool.get("architecture", "X64") not in ("X64", "ARM64"):
            raise ValueError("unsupported architecture")
    return config


def git_credential_api(repository, suffix, *, method="GET", body=None):
    # Use the operator's existing credential helper. Never persist its output or
    # put it in argv/environment; containers receive only their one-job config.
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never",
               GIT_ASKPASS="/bin/false", SSH_ASKPASS="/bin/false")
    result = subprocess.run(["git", "credential", "fill"],
                            input="protocol=https\nhost=github.com\n\n",
                            text=True, capture_output=True, timeout=30, env=env)
    credential = {}
    request = None
    try:
        if result.returncode:
            raise RuntimeError("operator Git credential lookup failed")
        credential = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        if not credential.get("password"):
            raise RuntimeError("operator Git credential has no API token")
        request = urllib.request.Request(
            f"https://api.github.com/repos/{repository}/actions/runners{suffix}",
            data=json.dumps(body).encode() if body is not None else None, method=method,
            headers={"Authorization": "Bearer " + credential["password"],
                     "Accept": "application/vnd.github+json", "Content-Type": "application/json",
                     "X-GitHub-Api-Version": "2022-11-28"})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                data = response.read()
                return json.loads(data) if data else None
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"runner API {method} failed with HTTP {exc.code}") from None
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise RuntimeError(f"runner API {method} failed: {type(exc).__name__}") from None
    finally:
        credential.clear()
        result = request = None


def gh(repository, suffix, *, method="GET", body=None):
    if AUTH_SOURCE == "git-credential":
        return git_credential_api(repository, suffix, method=method, body=body)
    command = ["gh", "api", "--method", method, f"repos/{repository}/actions/runners{suffix}"]
    if body is not None:
        command += ["--input", "-"]
    result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                            text=True, capture_output=True, timeout=45)
    if result.returncode:
        # Never print a JIT response or the calling environment.
        raise RuntimeError(f"runner API {method} failed with exit {result.returncode}")
    return json.loads(result.stdout) if result.stdout.strip() else None


def ssh_command(host, command):
    if host == LOCAL_HOST:
        return list(command)
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", host,
            shlex.join(command)]


def remote(host, command, *, check=True, timeout=45):
    return subprocess.run(ssh_command(host, command), text=True, capture_output=True,
                          check=check, timeout=timeout)


def container_command(config, pool, name, kvm_gid=None):
    if not re.fullmatch(r"spawnd-ci-[a-f0-9]{24}", name):
        raise ValueError("invalid owned container name")
    command = ["docker", "run", "--init", "--name", name, "--label", f"{OWNER_LABEL}=true",
               "--cpus", str(pool["cpus"]), "--memory", f"{pool['memory_gib']}g",
               "--memory-swap", f"{pool['memory_gib']}g", "--pids-limit", "4096",
               "--shm-size", "1g", "--interactive"]
    if pool.get("home_gib"):
        command += ["--tmpfs", f"/home/runner:rw,exec,nosuid,nodev,uid=1001,gid=1001,mode=700,size={pool['home_gib']}g"]
    if pool.get("tmp_gib"):
        command += ["--tmpfs", f"/tmp:rw,exec,nosuid,nodev,mode=1777,size={pool['tmp_gib']}g"]
    if pool.get("kvm"):
        if kvm_gid is None or not str(kvm_gid).isdigit():
            raise ValueError("Android runner requires the verified KVM group")
        command += ["--device", "/dev/kvm", "--group-add", str(kvm_gid)]
    # No host home, repository, credentials, Docker socket or privileged mode.
    return command + [config["image"]]


def cleanup_container(host, name, state):
    if not re.fullmatch(r"spawnd-ci-[a-f0-9]{24}", name):
        raise ValueError("refusing an unowned container name")
    inspection = remote(host, ["docker", "inspect", "--format",
                              '{{ index .Config.Labels "' + OWNER_LABEL + '" }}', name], check=False)
    if inspection.returncode:
        # Distinguish absence from an unreachable Docker daemon.
        remote(host, ["docker", "info", "--format", "{{.OSType}}"])
        return
    if inspection.stdout.strip() != "true":
        raise RuntimeError("refusing a container without the ownership label")
    remote(host, ["docker", "stop", "--time", "45", name], timeout=60)
    # Copy only runner diagnostics; workflows retain their normal evidence artifacts.
    diagnostic = state / (name + "-diagnostics.tar")
    with diagnostic.open("wb") as output:
        subprocess.run(ssh_command(host, ["docker", "cp", f"{name}:/opt/actions-runner/_diag", "-"]),
                       stdout=output, stderr=subprocess.DEVNULL, timeout=45, check=True)
    remote(host, ["docker", "rm", name])


def remove_registration(repository, runner_id, name):
    runners = gh(repository, "?per_page=100")["runners"]
    matching = [r for r in runners if r["id"] == runner_id]
    if not matching:
        return  # JIT runners deregister themselves after their one job.
    if matching[0]["name"] != name:
        raise RuntimeError("refusing an unrelated runner registration")
    gh(repository, f"/{runner_id}", method="DELETE")


def recover(config, state):
    # A restart must retire the recorded container before making its slot available.
    for record in sorted(state.glob("active-*.json")):
        active = json.loads(record.read_text())
        if active["repository"] != config["repository"]:
            raise RuntimeError("state belongs to a different repository")
        if active["host"] not in {p["host"] for p in config["pools"]}:
            raise RuntimeError("state belongs to an unconfigured host")
        cleanup_container(active["host"], active["name"], state)
        remove_registration(config["repository"], active["id"], active["name"])
        record.unlink()


def worker(config, pool, slot, state):
    repository = config["repository"]
    record = state / f"active-{pool['label']}-{slot}.json"
    while not STOP.is_set():
        name = "spawnd-ci-" + uuid.uuid4().hex[:24]
        runner_id = None
        process = None
        try:
            architecture = pool.get("architecture", "X64")
            expected = {"X64": "amd64", "ARM64": "arm64"}[architecture]
            observed = remote(pool["host"], ["docker", "image", "inspect", "--format", "{{.Architecture}}", config["image"]]).stdout.strip()
            if observed != expected:
                raise RuntimeError("runner image architecture does not match its label")
            gid = None
            if pool.get("kvm"):
                gid = remote(pool["host"], ["stat", "-c", "%g", "/dev/kvm"]).stdout.strip()
            command = container_command(config, pool, name, gid)
            jit = gh(repository, "/generate-jitconfig", method="POST", body={
                "name": name, "runner_group_id": 1,
                "labels": ["self-hosted", "Linux", architecture, pool["label"], *pool.get("extra_labels", [])],
                "work_folder": "/home/runner/_work",
            })
            runner_id = jit["runner"]["id"]
            record.write_text(json.dumps({"id": runner_id, "name": name,
                                         "host": pool["host"], "repository": repository}))
            with (state / (name + ".log")).open("w") as log:
                process = subprocess.Popen(ssh_command(pool["host"], command), stdin=subprocess.PIPE,
                                           stdout=log, stderr=subprocess.STDOUT, text=True)
                process.stdin.write(jit.pop("encoded_jit_config") + "\n")
                process.stdin.close()
                print(f"started {pool['label']} slot={slot} runner={name}", flush=True)
                while process.poll() is None and not STOP.wait(2):
                    pass
        except Exception as exc:
            print(f"pool {pool['label']} slot={slot}: {type(exc).__name__}: {exc}", flush=True)
        finally:
            if runner_id is not None:
                try:
                    cleanup_container(pool["host"], name, state)
                    if process is not None:
                        process.wait(timeout=15)
                    remove_registration(repository, runner_id, name)
                    record.unlink(missing_ok=True)
                except Exception as exc:
                    print(f"cleanup failed for {name}: {type(exc).__name__}; stopping pool", flush=True)
                    STOP.set()  # Do not accumulate abandoned jobs or reuse a dirty slot.
        STOP.wait(30)


def configure_execution(local_host, auth_source):
    global LOCAL_HOST, AUTH_SOURCE
    if local_host is not None:
        if (local_host != "minivac" or sys.platform != "linux"
                or socket.gethostname().split(".")[0].lower() != local_host):
            raise ValueError("local Docker execution requires the Minivac Linux host")
        if os.geteuid() == 0:
            raise ValueError("run the controller as its existing operator, not root")
        # Do not inherit an operator Docker context pointing at another machine.
        os.environ["DOCKER_HOST"] = "unix:///var/run/docker.sock"
    LOCAL_HOST, AUTH_SOURCE = local_host, auth_source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--local-host", choices=["minivac"],
                        help="execute Docker on this verified Minivac host, without SSH")
    parser.add_argument("--auth-source", choices=["gh", "git-credential"], default="gh",
                        help="use gh or the operator's existing noninteractive Git credential")
    args = parser.parse_args()
    configure_execution(args.local_host, args.auth_source)
    config = validate_config(json.loads(args.config.read_text()))
    os.umask(0o077)
    args.state.mkdir(parents=True, exist_ok=True)
    with (args.state / "pool.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: STOP.set())
        recover(config, args.state)
        enabled = [p for p in config["pools"] if p.get("enabled", True)]
        count = sum(p["count"] for p in enabled)
        if not count:
            raise ValueError("no runner pools are enabled")
        with concurrent.futures.ThreadPoolExecutor(max_workers=count) as executor:
            futures = [executor.submit(worker, config, pool, slot, args.state)
                       for pool in enabled for slot in range(pool["count"])]
            for future in futures:
                future.result()


if __name__ == "__main__":
    main()
