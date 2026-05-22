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
    """Serve the locally-built daemon CLI escript for quick installs."""

    if target != "linux-x86_64":
        raise HTTPException(status_code=404, detail="unsupported daemon target")

    binary = Path(__file__).resolve().parents[3] / "daemon" / "_build" / "default" / "bin" / "spawnd"
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
        die "need root privileges to install packages; install curl, Erlang/OTP, rebar3, git, and build tools manually, then rerun"
      fi
    }

    install_runtime_prereqs() {
      if need curl; then
        return
      fi

      say "installing runtime prerequisites"
      OS_NAME=$(uname -s 2>/dev/null || printf unknown)
      if [ "$OS_NAME" = "Darwin" ]; then
        need brew || die "Homebrew is required to install missing runtime prerequisites on macOS"
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
      if need git && need erl && need rebar3 && (need cc || need gcc || need clang); then
        return
      fi

      say "installing build prerequisites"
      OS_NAME=$(uname -s 2>/dev/null || printf unknown)
      if [ "$OS_NAME" = "Darwin" ]; then
        need brew || die "Homebrew is required to install missing build prerequisites on macOS"
        brew install git erlang rebar3
        return
      fi

      if need apt-get; then
        as_root apt-get update
        as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
          git build-essential pkg-config erlang rebar3
      elif need dnf; then
        as_root dnf install -y git gcc gcc-c++ make pkgconf-pkg-config erlang rebar3
      elif need yum; then
        as_root yum install -y git gcc gcc-c++ make pkgconfig erlang rebar3
      elif need pacman; then
        as_root pacman -Sy --needed --noconfirm git base-devel pkgconf erlang rebar3
      elif need zypper; then
        as_root zypper --non-interactive install git gcc gcc-c++ make pkg-config erlang rebar3
      elif need apk; then
        as_root apk add --no-cache git build-base pkgconf erlang rebar3
      else
        die "unsupported package manager; install Erlang/OTP, rebar3, git, and build tools manually, then rerun"
      fi
    }

    install_spawnd() {
      say "building spawnd from $REPO#$BRANCH"
      export PATH="$BIN_DIR:$PATH"
      mkdir -p "$BIN_DIR"
      APP_DIR="$INSTALL_ROOT/lib/spawnd"
      STAGE_DIR="$INSTALL_ROOT/lib/spawnd.next.$$"
      PREV_DIR="$INSTALL_ROOT/lib/spawnd.previous"
      TMP_BIN="$BIN.tmp.$$"

      TMP_BASE=${TMPDIR:-/tmp}
      TMP_DIR="$TMP_BASE/spawn-install.$$"
      rm -rf "$TMP_DIR"
      mkdir -p "$TMP_DIR"
      trap 'rm -rf "$TMP_DIR" "$STAGE_DIR" "$TMP_BIN"' EXIT INT TERM

      git clone --depth 1 --branch "$BRANCH" "$REPO" "$TMP_DIR/spawn"
      (cd "$TMP_DIR/spawn/daemon" && rebar3 release && rebar3 escriptize)
      rm -rf "$STAGE_DIR"
      mkdir -p "$STAGE_DIR"
      cp -R "$TMP_DIR/spawn/daemon/_build/default/rel/spawnd" "$STAGE_DIR/rel"
      cp "$TMP_DIR/spawn/daemon/_build/default/bin/spawnd" "$STAGE_DIR/spawnd_cli"
      chmod 755 "$STAGE_DIR/spawnd_cli"
      "$STAGE_DIR/spawnd_cli" --version >/dev/null 2>&1 || die "staged spawnd CLI cannot run"
      [ -x "$STAGE_DIR/rel/bin/spawnd" ] || die "staged spawnd release is missing"

      cat > "$TMP_BIN" <<EOF
#!/bin/sh
APP_DIR="$APP_DIR"
SERVER=""
    if [ "\${1:-}" = "--server" ]; then
      SERVER=\$2
      shift 2
    fi
    if [ -n "\$SERVER" ]; then
      export SPAWN_SERVER_URL="\$SERVER"
    fi
    case "\${1:-}" in
      run)
        shift
        exec "$APP_DIR/rel/bin/spawnd" foreground
        ;;
      *)
        exec "$APP_DIR/spawnd_cli" "\$@"
        ;;
esac
EOF
      chmod 755 "$TMP_BIN"

      rm -rf "$PREV_DIR"
      if [ -d "$APP_DIR" ]; then
        mv "$APP_DIR" "$PREV_DIR"
      fi
      if ! mv "$STAGE_DIR" "$APP_DIR"; then
        if [ -d "$PREV_DIR" ]; then
          mv "$PREV_DIR" "$APP_DIR"
        fi
        die "could not promote staged spawnd release"
      fi
      if ! mv "$TMP_BIN" "$BIN"; then
        rm -rf "$APP_DIR"
        if [ -d "$PREV_DIR" ]; then
          mv "$PREV_DIR" "$APP_DIR"
        fi
        die "could not install spawnd wrapper"
      fi
      [ -x "$BIN" ] || die "spawnd did not install to $BIN"
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
Environment=PATH=$BIN_DIR:/usr/local/bin:/usr/bin:/bin

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
    install_build_prereqs
    install_spawnd
    "$BIN" --version >/dev/null 2>&1 || die "installed spawnd cannot run on this host"

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
