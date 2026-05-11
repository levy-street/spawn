"""Hosted shell installer for `spawnd`."""

from __future__ import annotations

import shlex
from pathlib import Path
from textwrap import dedent

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

from ..config import get_settings

router = APIRouter(tags=["install"])

DEFAULT_REPO = "https://github.com/levy-street/spawn.git"
DEFAULT_BRANCH = "master"


@router.get("/api/install/spawnd/{target}")
async def spawnd_binary(target: str) -> FileResponse:
    """Serve the locally-built daemon binary for quick installs."""

    if target != "linux-x86_64":
        raise HTTPException(status_code=404, detail="unsupported daemon target")

    binary = Path(__file__).resolve().parents[3] / "daemon" / "target" / "release" / "spawnd"
    if not binary.is_file():
        raise HTTPException(status_code=404, detail="daemon binary is not available")

    return FileResponse(
        binary,
        media_type="application/octet-stream",
        filename="spawnd",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/install.sh", response_class=PlainTextResponse)
async def install_script() -> PlainTextResponse:
    """Return a curl-pipeable installer for daemon hosts."""

    server = get_settings().public_url.rstrip("/") or "http://localhost:8000"
    script = INSTALL_SCRIPT.replace("__DEFAULT_SERVER__", shlex.quote(server))
    script = script.replace("__DEFAULT_REPO__", shlex.quote(DEFAULT_REPO))
    script = script.replace("__DEFAULT_BRANCH__", shlex.quote(DEFAULT_BRANCH))
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

    if [ -z "$INSTALL_ROOT" ]; then
      INSTALL_ROOT="$HOME/.local"
    fi
    BIN_DIR="$INSTALL_ROOT/bin"
    BIN="$BIN_DIR/spawnd"

    say() {
      printf '%s\n' "spawn: $*"
    }

    die() {
      printf '%s\n' "spawn: $*" >&2
      exit 1
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
        die "need root privileges to install packages; install tmux, git, curl, and build tools manually, then rerun"
      fi
    }

    install_runtime_prereqs() {
      if need tmux && need curl; then
        return
      fi

      say "installing runtime prerequisites"
      OS_NAME=$(uname -s 2>/dev/null || printf unknown)
      if [ "$OS_NAME" = "Darwin" ]; then
        need brew || die "Homebrew is required to install missing prerequisites on macOS"
        brew install tmux curl
        return
      fi

      if need apt-get; then
        as_root apt-get update
        as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
          tmux curl ca-certificates
      elif need dnf; then
        as_root dnf install -y tmux curl ca-certificates
      elif need yum; then
        as_root yum install -y tmux curl ca-certificates
      elif need pacman; then
        as_root pacman -Sy --needed --noconfirm tmux curl ca-certificates
      elif need zypper; then
        as_root zypper --non-interactive install tmux curl ca-certificates
      elif need apk; then
        as_root apk add --no-cache tmux curl ca-certificates
      else
        die "unsupported package manager; install tmux and curl manually, then rerun"
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

    ensure_rust() {
      if need cargo; then
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
    }

    host_target() {
      OS_NAME=$(uname -s 2>/dev/null || printf unknown)
      ARCH_NAME=$(uname -m 2>/dev/null || printf unknown)
      case "$OS_NAME:$ARCH_NAME" in
        Linux:x86_64|Linux:amd64)
          printf '%s\n' linux-x86_64
          ;;
        *)
          return 1
          ;;
      esac
    }

    install_prebuilt_spawnd() {
      TARGET=$(host_target) || return 1
      URL="${SERVER%/}/api/install/spawnd/$TARGET"
      TMP_BIN="$BIN.tmp.$$"
      say "downloading prebuilt spawnd for $TARGET"
      if curl -fsSL "$URL" -o "$TMP_BIN"; then
        chmod 755 "$TMP_BIN"
        mv "$TMP_BIN" "$BIN"
        return 0
      fi
      rm -f "$TMP_BIN"
      return 1
    }

    start_systemd_service() {
      [ "$USE_SERVICE" = "1" ] || return 1
      need systemctl || return 1
      systemctl --user show-environment >/dev/null 2>&1 || return 1

      SERVICE_DIR="$HOME/.config/systemd/user"
      mkdir -p "$SERVICE_DIR"
      cat > "$SERVICE_DIR/spawnd.service" <<EOF
    [Unit]
    Description=spawn daemon
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    ExecStart=$BIN --server $SERVER run
    Restart=always
    RestartSec=2
    Environment=PATH=$BIN_DIR:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin

    [Install]
    WantedBy=default.target
    EOF

      systemctl --user daemon-reload
      systemctl --user enable --now spawnd.service
      say "started user service spawnd.service"
      say "logs: journalctl --user -u spawnd.service -f"
      return 0
    }

    start_background() {
      STATE_DIR="$HOME/.local/state/spawn"
      mkdir -p "$STATE_DIR"
      nohup "$BIN" --server "$SERVER" run >> "$STATE_DIR/spawnd.log" 2>&1 &
      say "started spawnd in the background, pid $!"
      say "logs: tail -f $STATE_DIR/spawnd.log"
    }

    install_runtime_prereqs
    mkdir -p "$BIN_DIR"
    if ! install_prebuilt_spawnd; then
      say "prebuilt daemon unavailable; falling back to source build"
      install_build_prereqs
      ensure_rust
      install_spawnd
    fi

    say "installed $("$BIN" --version 2>/dev/null || printf spawnd) at $BIN"

    if [ "$LOGIN_AFTER_INSTALL" = "0" ]; then
      say "skipping login"
      exit 0
    fi

    "$BIN" --server "$SERVER" login --no-run

    if [ "$START_AFTER_LOGIN" = "0" ]; then
      say "login complete; not starting daemon because --no-start was set"
      exit 0
    fi

    if [ "$FOREGROUND" = "1" ]; then
      exec "$BIN" --server "$SERVER" run
    fi

    if ! start_systemd_service; then
      start_background
    fi

    say "done"
    """
).lstrip()
