"""Hosted shell installer for `spawnd`."""

from __future__ import annotations

import hashlib
import shlex
import sys
from pathlib import Path
from textwrap import dedent

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse, PlainTextResponse

from .. import release
from ..config import get_settings

router = APIRouter(tags=["install"])

DEFAULT_REPO = "https://github.com/levy-street/spawn.git"
DEFAULT_BRANCH = "master"
SUPPORTED_TARGETS = {
    "darwin-aarch64": "aarch64-apple-darwin",
    "darwin-x86_64": "x86_64-apple-darwin",
    "linux-aarch64": "aarch64-unknown-linux-gnu",
    "linux-x86_64": "x86_64-unknown-linux-gnu",
}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _local_target() -> str | None:
    if sys.platform == "darwin":
        os_name = "darwin"
    elif sys.platform.startswith("linux"):
        os_name = "linux"
    else:
        return None

    import platform

    machine = platform.machine().lower()
    if machine in {"arm64", "aarch64"}:
        arch = "aarch64"
    elif machine in {"x86_64", "amd64"}:
        arch = "x86_64"
    else:
        return None
    return f"{os_name}-{arch}"


def _binary_candidates(target: str, name: str) -> list[Path]:
    triple = SUPPORTED_TARGETS[target]
    root = _repo_root()
    candidates = [
        release.prebuilt_root(repo_root=root) / target / name,
        root / "daemon" / "target" / triple / "release" / name,
    ]
    if target == _local_target():
        candidates.append(root / "daemon" / "target" / "release" / name)
    return candidates


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _prebuilt_sha256_cases() -> str:
    """Shell `case` arms mapping "<kind>:<target>" to the sha256 of the binary
    this server will actually serve, for every prebuilt present. Absent targets
    emit no arm, so the installer skips verification on a source-build host
    (there is nothing to pin against). Templated into `install.sh` at render."""
    manifest = release.read_prebuilt_manifest(repo_root=_repo_root())
    if manifest is not None:
        arms: list[str] = []
        for target, target_release in manifest.targets.items():
            arms.append(f"        spawnd:{target}) printf %s {target_release.spawnd_sha256} ;;")
            arms.append(
                f"        spawn-worker:{target}) printf %s {target_release.spawn_worker_sha256} ;;"
            )
        return "\n".join(arms)

    arms = []
    for target in SUPPORTED_TARGETS:
        for kind in ("spawnd", "spawn-worker"):
            binary = next((p for p in _binary_candidates(target, kind) if p.is_file()), None)
            if binary is None:
                continue
            arms.append(f"        {kind}:{target}) printf %s {_sha256_file(binary)} ;;")
    return "\n".join(arms)


@router.get("/api/install/spawnd/{target}")
async def spawnd_binary(target: str) -> FileResponse:
    """Serve the locally-built daemon binary for quick installs."""

    if target not in SUPPORTED_TARGETS:
        raise HTTPException(status_code=404, detail="unsupported daemon target")

    binary = next((path for path in _binary_candidates(target, "spawnd") if path.is_file()), None)
    if binary is None:
        raise HTTPException(status_code=404, detail=f"daemon binary is not available for {target}")

    return FileResponse(
        binary,
        media_type="application/octet-stream",
        filename="spawnd",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/install/spawn-worker/{target}")
async def spawn_worker_binary(target: str) -> FileResponse:
    """Serve the worker paired with the locally-built daemon binary."""

    if target not in SUPPORTED_TARGETS:
        raise HTTPException(status_code=404, detail="unsupported worker target")

    binary = next(
        (path for path in _binary_candidates(target, "spawn-worker") if path.is_file()), None
    )
    if binary is None:
        raise HTTPException(status_code=404, detail=f"worker binary is not available for {target}")

    return FileResponse(
        binary,
        media_type="application/octet-stream",
        filename="spawn-worker",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/install/manifest.json")
async def prebuilt_manifest() -> Response:
    path = release.manifest_path(repo_root=_repo_root())
    if release.read_prebuilt_manifest(repo_root=_repo_root(), manifest_path=path) is None:
        raise HTTPException(status_code=404, detail="daemon manifest is not available")
    try:
        body = path.read_bytes()
    except OSError as exc:
        raise HTTPException(status_code=404, detail="daemon manifest is not available") from exc
    return Response(
        content=body,
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/install/manifest.json.sig")
async def prebuilt_manifest_signature() -> Response:
    path = release.manifest_signature_path(repo_root=_repo_root())
    try:
        body = path.read_bytes()
    except OSError as exc:
        raise HTTPException(
            status_code=404, detail="daemon manifest signature is not available"
        ) from exc
    return Response(
        content=body,
        media_type="text/plain",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/install.sh", response_class=PlainTextResponse)
async def install_script() -> PlainTextResponse:
    """Return a curl-pipeable installer for daemon hosts."""

    server = get_settings().public_url.rstrip("/") or "http://localhost:8000"
    script = INSTALL_SCRIPT.replace("__DEFAULT_SERVER__", shlex.quote(server))
    script = script.replace("__DEFAULT_REPO__", shlex.quote(DEFAULT_REPO))
    script = script.replace("__DEFAULT_BRANCH__", shlex.quote(DEFAULT_BRANCH))
    # Injected as case arms, so this must land after the literal-string replaces.
    script = script.replace("__PREBUILT_SHA256__", _prebuilt_sha256_cases())
    return PlainTextResponse(
        script,
        media_type="text/x-shellscript; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


INSTALL_SCRIPT = dedent(
    r"""
    #!/bin/sh
    set -eu

    DEFAULT_SERVER=__DEFAULT_SERVER__
    DEFAULT_REPO=__DEFAULT_REPO__
    DEFAULT_BRANCH=__DEFAULT_BRANCH__

    SERVER=$DEFAULT_SERVER
    REPO=${SPAWN_REPO:-$DEFAULT_REPO}
    BRANCH=${SPAWN_BRANCH:-$DEFAULT_BRANCH}
    INSTALL_ROOT=${SPAWN_INSTALL_ROOT:-}
    START_AFTER_LOGIN=1
    LOGIN_AFTER_INSTALL=1
    USE_SERVICE=1
    FOREGROUND=0
    PREBUILT_ONLY=0
    NEW_ACCOUNT=0
    unset SPAWN_SETUP_TOKEN

    if [ -z "$INSTALL_ROOT" ]; then
      INSTALL_ROOT="$HOME/.local"
    fi
    BIN_DIR="$INSTALL_ROOT/bin"
    BIN="$BIN_DIR/spawnd"
    WORKER_BIN="$BIN_DIR/spawn-worker"

    say() {
      printf '%s\n' "spawn: $*"
    }

    die() {
      printf '%s\n' "spawn: $*" >&2
      exit 1
    }

    # A phase heading, so the installer's lines and the daemon's own frame read
    # as one sequence. Accented only on a terminal; piped output stays plain.
    rule() {
      if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
        printf '\033[31m── %s ──────────────────────────────────────────\033[0m\n' "$1"
      else
        printf '%s\n' "-- $1 --"
      fi
    }

    need() {
      command -v "$1" >/dev/null 2>&1
    }

    usage() {
      cat <<EOF
    Usage: sh install.sh [options]

    Options:
      --server URL       Spawn server URL. Default: $DEFAULT_SERVER
      --repo URL         Git repo to build from. Default: $DEFAULT_REPO
      --branch NAME      Git branch to build. Default: $DEFAULT_BRANCH
      --no-login         Install only; do not run the device-code login flow.
      --no-start         Login but do not start spawnd afterwards.
      --no-service       Do not create a user systemd service; use background run fallback.
      --foreground       Run spawnd in the foreground after login.
      --prebuilt-only    Do not fall back to building from source.
      --setup TOKEN      Ignored (older apps); approval uses the printed link.
      --new-account      Possess as a separate account on an already-used machine.
      -h, --help         Show this help.

    Environment:
      SPAWN_INSTALL_ROOT Install root. Default: ~/.local
      SPAWN_REPO         Same as --repo.
      SPAWN_BRANCH       Same as --branch.
    EOF
    }

    while [ "$#" -gt 0 ]; do
      case "$1" in
        --server)
          [ "$#" -ge 2 ] || die "--server requires a URL"
          SERVER=$2
          shift 2
          ;;
        --server=*)
          SERVER=${1#--server=}
          shift
          ;;
        --repo)
          [ "$#" -ge 2 ] || die "--repo requires a URL"
          REPO=$2
          shift 2
          ;;
        --repo=*)
          REPO=${1#--repo=}
          shift
          ;;
        --branch)
          [ "$#" -ge 2 ] || die "--branch requires a name"
          BRANCH=$2
          shift 2
          ;;
        --branch=*)
          BRANCH=${1#--branch=}
          shift
          ;;
        --no-login)
          LOGIN_AFTER_INSTALL=0
          START_AFTER_LOGIN=0
          shift
          ;;
        --no-start)
          START_AFTER_LOGIN=0
          shift
          ;;
        --no-service)
          USE_SERVICE=0
          shift
          ;;
        --foreground)
          FOREGROUND=1
          USE_SERVICE=0
          shift
          ;;
        --prebuilt-only)
          PREBUILT_ONLY=1
          shift
          ;;
        --setup)
          [ "$#" -ge 2 ] || die "--setup requires a token"
          [ -n "$2" ] || die "--setup requires a token"
          say "the --setup flag is no longer needed; approval happens through the link spawnd prints"
          shift 2
          ;;
        --setup=*)
          [ -n "${1#--setup=}" ] || die "--setup requires a token"
          say "the --setup flag is no longer needed; approval happens through the link spawnd prints"
          shift
          ;;
        --new-account)
          NEW_ACCOUNT=1
          shift
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "unknown option: $1"
          ;;
      esac
    done

    case "$SERVER" in
      http://*|https://*) ;;
      *) die "--server must start with http:// or https://" ;;
    esac

    as_root() {
      if [ "$(id -u)" -eq 0 ]; then
        "$@"
      elif need sudo; then
        sudo "$@"
      else
        die "need root privileges to install packages; install git, curl, and build tools manually, then rerun"
      fi
    }

    install_runtime_prereqs() {
      if need curl; then
        return
      fi

      say "installing runtime prerequisites"
      OS_NAME=$(uname -s 2>/dev/null || printf unknown)
      if [ "$OS_NAME" = "Darwin" ]; then
        need brew || die "Homebrew is required to install missing prerequisites on macOS"
        brew install curl
        return
      fi

      if need apt-get; then
        as_root apt-get update
        as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
          curl ca-certificates
      elif need dnf; then
        as_root dnf install -y curl ca-certificates
      elif need yum; then
        as_root yum install -y curl ca-certificates
      elif need pacman; then
        as_root pacman -Sy --needed --noconfirm curl ca-certificates
      elif need zypper; then
        as_root zypper --non-interactive install curl ca-certificates
      elif need apk; then
        as_root apk add --no-cache curl ca-certificates
      else
        die "unsupported package manager; install curl manually, then rerun"
      fi
    }

    install_build_prereqs() {
      if need git && (need cc || need gcc || need clang); then
        return
      fi

      say "installing build prerequisites"
      OS_NAME=$(uname -s 2>/dev/null || printf unknown)
      if [ "$OS_NAME" = "Darwin" ]; then
        need brew || die "Homebrew is required to install missing build prerequisites on macOS"
        brew install git
        return
      fi

      if need apt-get; then
        as_root apt-get update
        as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
          git build-essential pkg-config
      elif need dnf; then
        as_root dnf install -y git gcc gcc-c++ make pkgconf-pkg-config
      elif need yum; then
        as_root yum install -y git gcc gcc-c++ make pkgconfig
      elif need pacman; then
        as_root pacman -Sy --needed --noconfirm git base-devel pkgconf
      elif need zypper; then
        as_root zypper --non-interactive install git gcc gcc-c++ make pkg-config
      elif need apk; then
        as_root apk add --no-cache git build-base pkgconf
      else
        die "unsupported package manager; install git and build tools manually, then rerun"
      fi
    }

    # A from-source build has a rising rustc floor: the lock file is format v4
    # (Cargo >= 1.78) and its pinned deps push it further (home 0.5.12 needs
    # rustc 1.88). Chasing exact versions is a losing game, so when rustup is
    # present we just refresh stable to latest before building; hosts without
    # rustup get a clear error when their existing cargo is too old.
    MIN_CARGO_MINOR=88

    ensure_cargo_recent() {
      if need rustup; then
        say "ensuring a current Rust toolchain"
        rustup update stable || die "failed to update Rust; run 'rustup update' and rerun"
        return 0
      fi
      # No rustup to self-update: fail early when the existing cargo is too old
      # for the lock file or a dependency's MSRV, with actionable guidance.
      _ver=$(cargo --version 2>/dev/null | awk '{print $2}')
      _major=$(printf '%s' "$_ver" | cut -d. -f1)
      _minor=$(printf '%s' "$_ver" | cut -d. -f2)
      # Unparseable or non-1.x version (custom/nightly builds): let it try.
      case "$_major:$_minor" in
        1:[0-9]*) ;;
        *) return 0 ;;
      esac
      case "$_minor" in *[!0-9]*) return 0 ;; esac
      [ "$_minor" -ge "$MIN_CARGO_MINOR" ] && return 0
      die "cargo $_ver is too old (need >= 1.$MIN_CARGO_MINOR); update Rust (e.g. 'brew upgrade rust') and rerun"
    }

    ensure_rust() {
      if need cargo; then
        ensure_cargo_recent
        return
      fi

      say "installing Rust toolchain"
      need curl || die "curl is required to install Rust"
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
      if [ -f "$HOME/.cargo/env" ]; then
        # shellcheck disable=SC1090
        . "$HOME/.cargo/env"
      fi
      need cargo || die "cargo was not found after rustup install"
    }

    install_spawnd() {
      say "building spawnd from $REPO#$BRANCH"
      export PATH="$BIN_DIR:$HOME/.cargo/bin:$PATH"
      mkdir -p "$BIN_DIR"

      TMP_BASE=${TMPDIR:-/tmp}
      TMP_DIR="$TMP_BASE/spawn-install.$$"
      rm -rf "$TMP_DIR"
      mkdir -p "$TMP_DIR"
      trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

      git clone --depth 1 --branch "$BRANCH" "$REPO" "$TMP_DIR/spawn"
      cargo install --path "$TMP_DIR/spawn/daemon" --locked --root "$INSTALL_ROOT" --force
      [ -x "$BIN" ] || die "spawnd did not install to $BIN"
      [ -x "$WORKER_BIN" ] || die "spawn-worker did not install to $WORKER_BIN"
    }

    host_target() {
      OS_NAME=$(uname -s 2>/dev/null || printf unknown)
      ARCH_NAME=$(uname -m 2>/dev/null || printf unknown)
      case "$OS_NAME:$ARCH_NAME" in
        Darwin:arm64|Darwin:aarch64)
          printf '%s\n' darwin-aarch64
          ;;
        Darwin:x86_64|Darwin:amd64)
          printf '%s\n' darwin-x86_64
          ;;
        Linux:x86_64|Linux:amd64)
          printf '%s\n' linux-x86_64
          ;;
        Linux:aarch64|Linux:arm64)
          printf '%s\n' linux-aarch64
          ;;
        *)
          return 1
          ;;
      esac
    }

    prebuilt_sha256() {
      # Expected sha256 for "<kind> <target>", templated from the binaries this
      # server serves. No arm ⇒ nothing to verify (source-build host).
      case "$1:$2" in
        __PREBUILT_SHA256__
        *) return 1 ;;
      esac
    }

    sha256_of() {
      if need shasum; then
        shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
      elif need sha256sum; then
        sha256sum "$1" 2>/dev/null | awk '{print $1}'
      else
        return 1
      fi
    }

    verify_prebuilt() {
      # $1 = downloaded file, $2 = kind. Fails only on a real mismatch; a missing
      # pin or absent hash tool skips verification (fail-open — the binary still
      # arrives over the server's TLS, and gets a `--version` sanity check).
      _want=$(prebuilt_sha256 "$2" "$TARGET") || return 0
      [ -n "$_want" ] || return 0
      _got=$(sha256_of "$1") || { say "no sha256 tool; skipping prebuilt verification"; return 0; }
      if [ "$_got" = "$_want" ]; then
        return 0
      fi
      say "prebuilt $2 sha256 mismatch (want $_want, got $_got)"
      return 1
    }

    install_prebuilt_spawnd() {
      TARGET=$(host_target) || return 1
      need curl || return 1
      URL="${SERVER%/}/api/install/spawnd/$TARGET"
      WORKER_URL="${SERVER%/}/api/install/spawn-worker/$TARGET"
      TMP_BIN="$BIN.tmp.$$"
      TMP_WORKER="$WORKER_BIN.tmp.$$"
      rule "INSTALLING SPAWN D"
      say "downloading prebuilt spawnd + spawn-worker for $TARGET"
      if curl -fsSL "$URL" -o "$TMP_BIN" && curl -fsSL "$WORKER_URL" -o "$TMP_WORKER"; then
        if ! verify_prebuilt "$TMP_BIN" spawnd || ! verify_prebuilt "$TMP_WORKER" spawn-worker; then
          rm -f "$TMP_BIN" "$TMP_WORKER"
          say "prebuilt checksum verification failed; falling back to source"
          return 1
        fi
        say "verified both binaries against the server's signed manifest"
        chmod 755 "$TMP_BIN"
        chmod 755 "$TMP_WORKER"
        if "$TMP_BIN" --version >/dev/null 2>&1; then
          mv "$TMP_BIN" "$BIN"
          mv "$TMP_WORKER" "$WORKER_BIN"
          return 0
        fi
        rm -f "$TMP_BIN" "$TMP_WORKER"
        say "prebuilt daemon is not compatible with this host"
        return 1
      fi
      rm -f "$TMP_BIN" "$TMP_WORKER"
      return 1
    }

    xml_escape() {
      printf '%s' "$1" | sed \
        -e 's/&/\&amp;/g' \
        -e 's/</\&lt;/g' \
        -e 's/>/\&gt;/g' \
        -e 's/"/\&quot;/g'
    }

    start_launchd_service() {
      [ "$USE_SERVICE" = "1" ] || return 1
      [ "$(uname -s 2>/dev/null || printf unknown)" = "Darwin" ] || return 1
      need launchctl || return 1

      LABEL="app.spawn.spawnd"
      PLIST_DIR="$HOME/Library/LaunchAgents"
      STATE_DIR="$HOME/.local/state/spawn"
      PLIST="$PLIST_DIR/$LABEL.plist"
      mkdir -p "$PLIST_DIR" "$STATE_DIR"

      BIN_XML=$(xml_escape "$BIN")
      SERVER_XML=$(xml_escape "$SERVER")
      PATH_XML=$(xml_escape "$BIN_DIR:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
      OUT_XML=$(xml_escape "$STATE_DIR/spawnd.out.log")
      ERR_XML=$(xml_escape "$STATE_DIR/spawnd.err.log")

      cat > "$PLIST" <<EOF
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
      "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>Label</key>
      <string>$LABEL</string>
      <key>ProgramArguments</key>
      <array>
        <string>$BIN_XML</string>
        <string>--server</string>
        <string>$SERVER_XML</string>
        <string>run</string>
      </array>
      <key>EnvironmentVariables</key>
      <dict>
        <key>PATH</key>
        <string>$PATH_XML</string>
      </dict>
      <key>RunAtLoad</key>
      <true/>
      <key>KeepAlive</key>
      <true/>
      <key>StandardOutPath</key>
      <string>$OUT_XML</string>
      <key>StandardErrorPath</key>
      <string>$ERR_XML</string>
    </dict>
    </plist>
    EOF

      launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
      if launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1; then
        :
      else
        launchctl load "$PLIST" >/dev/null 2>&1 || return 1
      fi
      launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
      say "started LaunchAgent $LABEL"
      say "logs: tail -f $STATE_DIR/spawnd.err.log"
      return 0
    }

    start_systemd_service() {
      [ "$USE_SERVICE" = "1" ] || return 1
      need systemctl || return 1
      systemctl --user show-environment >/dev/null 2>&1 || return 1
      enable_systemd_linger

      SERVICE_DIR="$HOME/.config/systemd/user"
      mkdir -p "$SERVICE_DIR"
      cat > "$SERVICE_DIR/spawnd.service" <<EOF
    [Unit]
    Description=spawn daemon
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    ExecStart="$BIN" --server "$SERVER" run
    Restart=always
    RestartSec=2
    # Only kill spawnd itself on stop/restart: the per-session workers live in
    # this cgroup and must survive supervisor updates.
    KillMode=process
    # Headroom against fd exhaustion taking the host offline.
    LimitNOFILE=65536
    Environment="PATH=$BIN_DIR:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
    # Signed signaling is enforced by default: this daemon refuses RTC offers
    # that are not signed by a browser identity it pins. Approve new devices
    # from a browser that already works (Settings -> Browser devices) or pair
    # them here. Recovery escape hatch, accepting unauthenticated offers:
    # Environment="SPAWND_REQUIRE_SIGNED_RTC=0"

    [Install]
    WantedBy=default.target
    EOF

      systemctl --user daemon-reload
      systemctl --user enable --now spawnd.service
      say "started user service spawnd.service"
      say "logs: journalctl --user -u spawnd.service -f"
      return 0
    }

    enable_systemd_linger() {
      need loginctl || return 0
      USER_NAME=$(id -un 2>/dev/null || printf '')
      [ -n "$USER_NAME" ] || return 0
      if loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null | grep -qx yes; then
        return 0
      fi
      if loginctl enable-linger "$USER_NAME" >/dev/null 2>&1; then
        say "enabled systemd linger for $USER_NAME"
      else
        say "systemd linger is not enabled; spawnd may start after login rather than boot"
      fi
    }

    start_background() {
      STATE_DIR="$HOME/.local/state/spawn"
      mkdir -p "$STATE_DIR"
      nohup "$BIN" --server "$SERVER" run >> "$STATE_DIR/spawnd.log" 2>&1 &
      say "started spawnd in the background, pid $!"
      say "logs: tail -f $STATE_DIR/spawnd.log"
    }

    # `curl … | sh` leaves stdin pointing at the pipe the script itself came
    # down, so a prompt in spawnd would read EOF instead of the operator. Hand
    # it the controlling terminal where there is one; a headless or CI install
    # has no /dev/tty and keeps the old non-interactive behaviour.
    # `[ -r /dev/tty ]` is not the question. The node exists and is readable on
    # any Unix; what matters is whether this process has a *controlling*
    # terminal behind it, and opening it is the only way to find out — without
    # one the open fails with ENXIO ("Device not configured"), which under
    # `set -e` took the whole install down instead of falling back. So try the
    # redirect, quietly, and let the answer decide.
    have_tty() { { : < /dev/tty; } 2>/dev/null; }

    run_attached() {
      if have_tty; then
        "$@" < /dev/tty
      else
        "$@"
      fi
    }

    exec_attached() {
      if have_tty; then
        exec "$@" < /dev/tty
      fi
      exec "$@"
    }

    mkdir -p "$BIN_DIR"
    if ! install_prebuilt_spawnd; then
      [ "$PREBUILT_ONLY" = "0" ] || die "prebuilt daemon unavailable for this host"
      say "prebuilt daemon unavailable; falling back to source build"
      install_runtime_prereqs
      install_build_prereqs
      ensure_rust
      install_spawnd
    fi
    install_runtime_prereqs
    "$BIN" --version >/dev/null 2>&1 || die "installed spawnd cannot run on this host"
    [ -x "$WORKER_BIN" ] || die "installed spawn-worker is missing"

    say "installed $("$BIN" --version 2>/dev/null || printf spawnd) at $BIN with $WORKER_BIN"

    if [ "$LOGIN_AFTER_INSTALL" = "0" ]; then
      say "skipping login"
      exit 0
    fi

    # --no-start: register the host but do not start it.
    if [ "$START_AFTER_LOGIN" = "0" ]; then
      run_attached "$BIN" --server "$SERVER" login --no-run
      say "login complete; not starting daemon because --no-start was set"
      exit 0
    fi

    # --foreground: register, then run in the foreground.
    if [ "$FOREGROUND" = "1" ]; then
      run_attached "$BIN" --server "$SERVER" login --no-run
      exec "$BIN" --server "$SERVER" run
    fi

    # --no-service: register, then background without a service manager.
    if [ "$USE_SERVICE" = "0" ]; then
      run_attached "$BIN" --server "$SERVER" login --no-run
      start_background
      say "done"
      exit 0
    fi

    # Default: possess runs the login flow (if needed) and installs a supervised
    # background service, idempotently — it owns the service lifecycle now.
    if [ "$NEW_ACCOUNT" = "1" ]; then
      exec_attached "$BIN" --server "$SERVER" possess --new-account
    fi
    exec_attached "$BIN" --server "$SERVER" possess
    """
).lstrip()
