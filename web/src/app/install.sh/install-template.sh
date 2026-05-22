#!/bin/sh
set -eu

DEFAULT_SERVER=__DEFAULT_SERVER__
DEFAULT_REPO=__DEFAULT_REPO__
DEFAULT_BRANCH=__DEFAULT_BRANCH__

SERVER=$DEFAULT_SERVER
REPO=${SPAWN_REPO:-$DEFAULT_REPO}
BRANCH=${SPAWN_BRANCH:-$DEFAULT_BRANCH}
INSTALL_ROOT=${SPAWN_INSTALL_ROOT:-}
ARTIFACT_URL=${SPAWN_ARTIFACT_URL:-}
TARGET=${SPAWN_TARGET:-}
BUILD_FROM_SOURCE=0
START_AFTER_LOGIN=1
LOGIN_AFTER_INSTALL=1
USE_SERVICE=1
FOREGROUND=0

if [ -z "$INSTALL_ROOT" ]; then
  INSTALL_ROOT="$HOME/.local"
fi
BIN_DIR="$INSTALL_ROOT/bin"
BIN="$BIN_DIR/spawnd"
APP_DIR="$INSTALL_ROOT/lib/spawnd"

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
  --server URL          Spawn server URL. Default: $DEFAULT_SERVER
  --artifact-url URL    Prebuilt daemon tarball URL.
  --target TARGET       Artifact target. Default: detected OS/arch.
  --build-from-source   Clone and build with Erlang/rebar3 instead of downloading a prebuilt release.
  --repo URL            Git repo for --build-from-source. Default: $DEFAULT_REPO
  --branch NAME         Git branch for --build-from-source. Default: $DEFAULT_BRANCH
  --no-login            Install only; do not run the device-code login flow.
  --no-start            Login but do not start spawnd afterwards.
  --no-service          Do not create a user systemd service; use background run fallback.
  --foreground          Run spawnd in the foreground after login.
  -h, --help            Show this help.

Environment:
  SPAWN_INSTALL_ROOT    Install root. Default: ~/.local
  SPAWN_ARTIFACT_URL    Same as --artifact-url.
  SPAWN_TARGET          Same as --target.
  SPAWN_REPO            Same as --repo.
  SPAWN_BRANCH          Same as --branch.
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
    --artifact-url)
      [ "$#" -ge 2 ] || die "--artifact-url requires a URL"
      ARTIFACT_URL=$2
      shift 2
      ;;
    --artifact-url=*)
      ARTIFACT_URL=${1#--artifact-url=}
      shift
      ;;
    --target)
      [ "$#" -ge 2 ] || die "--target requires a target"
      TARGET=$2
      shift 2
      ;;
    --target=*)
      TARGET=${1#--target=}
      shift
      ;;
    --build-from-source)
      BUILD_FROM_SOURCE=1
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
    die "need root privileges to install packages; install curl, tar, and CA certificates manually, then rerun"
  fi
}

detect_target() {
  OS_NAME=$(uname -s 2>/dev/null || printf unknown)
  ARCH_NAME=$(uname -m 2>/dev/null || printf unknown)

  case "$OS_NAME" in
    Linux) TARGET_OS=linux ;;
    Darwin) TARGET_OS=darwin ;;
    CYGWIN*|MINGW*|MSYS*)
      die "native Windows shells are not supported; run this installer inside WSL so spawnd can use the Linux daemon"
      ;;
    *) die "unsupported OS for prebuilt spawnd: $OS_NAME; pass --build-from-source to build locally" ;;
  esac

  case "$ARCH_NAME" in
    x86_64|amd64) TARGET_ARCH=x86_64 ;;
    arm64|aarch64) TARGET_ARCH=arm64 ;;
    *) die "unsupported architecture for prebuilt spawnd: $ARCH_NAME; pass --build-from-source to build locally" ;;
  esac

  printf '%s-%s\n' "$TARGET_OS" "$TARGET_ARCH"
}

install_runtime_prereqs() {
  if need curl && need tar; then
    return
  fi

  say "installing runtime prerequisites"
  OS_NAME=$(uname -s 2>/dev/null || printf unknown)
  if [ "$OS_NAME" = "Darwin" ]; then
    need brew || die "Homebrew is required to install missing runtime prerequisites on macOS"
    need curl || brew install curl
    need tar || die "tar is required but was not found"
    return
  fi

  if need apt-get; then
    as_root apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
      curl ca-certificates tar
  elif need dnf; then
    as_root dnf install -y curl ca-certificates tar
  elif need yum; then
    as_root yum install -y curl ca-certificates tar
  elif need pacman; then
    as_root pacman -Sy --needed --noconfirm curl ca-certificates tar
  elif need zypper; then
    as_root zypper --non-interactive install curl ca-certificates tar
  elif need apk; then
    as_root apk add --no-cache curl ca-certificates tar
  else
    die "unsupported package manager; install curl, tar, and CA certificates manually, then rerun"
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

erlang_otp_major() {
  erl -noshell -eval 'io:format("~s", [erlang:system_info(otp_release)]), halt().' 2>/dev/null
}

require_erlang_otp() {
  OTP_MAJOR=$(erlang_otp_major || true)
  case "$OTP_MAJOR" in
    ''|*[!0-9]*)
      die "Erlang/OTP 27+ is required for --build-from-source; could not determine the installed OTP release"
      ;;
  esac

  if [ "$OTP_MAJOR" -lt 27 ]; then
    die "Erlang/OTP 27+ is required for --build-from-source; this host has OTP $OTP_MAJOR. Use a prebuilt spawnd artifact or install Erlang/OTP 27 or newer and rerun."
  fi
}

install_wrapper() {
  APP_DIR=$1
  TMP_BIN=$2

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
if [ -z "\${SHELL:-}" ]; then
  export SHELL=/bin/sh
fi
case "\${1:-}" in
  run)
    shift
    exec "\$APP_DIR/rel/bin/spawnd" foreground "\$@"
    ;;
  ping|stop|daemon|foreground|console)
    exec "\$APP_DIR/rel/bin/spawnd" "\$@"
    ;;
  *)
    exec "\$APP_DIR/rel/bin/spawnd" escript spawnd_cli "\$@"
    ;;
esac
EOF
  chmod 755 "$TMP_BIN"
}

promote_stage() {
  STAGE_DIR=$1
  PREV_DIR="$INSTALL_ROOT/lib/spawnd.previous"
  TMP_BIN="$BIN.tmp.$$"

  install_wrapper "$APP_DIR" "$TMP_BIN"

  if [ -x "$APP_DIR/rel/bin/spawnd" ]; then
    "$APP_DIR/rel/bin/spawnd" stop >/dev/null 2>&1 || true
  fi

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

verify_stage() {
  STAGE_DIR=$1
  [ -x "$STAGE_DIR/rel/bin/spawnd" ] || die "staged spawnd release is missing"
  [ -f "$STAGE_DIR/rel/spawnd_cli" ] || die "staged spawnd CLI is missing"
  "$STAGE_DIR/rel/bin/spawnd" escript spawnd_cli --version >/dev/null 2>&1 ||
    die "staged spawnd cannot run on this host"
}

install_prebuilt() {
  if [ -z "$TARGET" ]; then
    TARGET=$(detect_target)
  fi
  if [ -z "$ARTIFACT_URL" ]; then
    ARTIFACT_URL="$SERVER/install/spawnd/$TARGET.tar.gz"
  fi

  say "installing prebuilt spawnd for $TARGET"
  export PATH="$BIN_DIR:$PATH"
  mkdir -p "$BIN_DIR"

  TMP_BASE=${TMPDIR:-/tmp}
  TMP_DIR="$TMP_BASE/spawn-install.$$"
  STAGE_DIR="$INSTALL_ROOT/lib/spawnd.next.$$"
  ARCHIVE="$TMP_DIR/spawnd.tar.gz"
  rm -rf "$TMP_DIR" "$STAGE_DIR"
  mkdir -p "$TMP_DIR" "$STAGE_DIR"
  trap 'rm -rf "$TMP_DIR" "$STAGE_DIR" "$BIN.tmp.$$"' EXIT INT TERM

  if ! curl -fsSL "$ARTIFACT_URL" -o "$ARCHIVE"; then
    die "could not download prebuilt spawnd from $ARTIFACT_URL; pass --build-from-source to build locally"
  fi

  tar -xzf "$ARCHIVE" -C "$STAGE_DIR"
  if [ -d "$STAGE_DIR/spawnd" ]; then
    mv "$STAGE_DIR/spawnd" "$STAGE_DIR/rel"
  fi
  verify_stage "$STAGE_DIR"
  promote_stage "$STAGE_DIR"
}

install_from_source() {
  say "building spawnd from $REPO#$BRANCH"
  export PATH="$BIN_DIR:$PATH"
  mkdir -p "$BIN_DIR"
  STAGE_DIR="$INSTALL_ROOT/lib/spawnd.next.$$"

  TMP_BASE=${TMPDIR:-/tmp}
  TMP_DIR="$TMP_BASE/spawn-install.$$"
  rm -rf "$TMP_DIR" "$STAGE_DIR"
  mkdir -p "$TMP_DIR"
  trap 'rm -rf "$TMP_DIR" "$STAGE_DIR" "$BIN.tmp.$$"' EXIT INT TERM

  git clone --depth 1 --branch "$BRANCH" "$REPO" "$TMP_DIR/spawn"
  (cd "$TMP_DIR/spawn/daemon" && rebar3 release && rebar3 escriptize)
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  cp -R "$TMP_DIR/spawn/daemon/_build/default/rel/spawnd" "$STAGE_DIR/rel"
  cp "$TMP_DIR/spawn/daemon/_build/default/bin/spawnd" "$STAGE_DIR/rel/spawnd_cli"
  chmod 755 "$STAGE_DIR/rel/spawnd_cli"
  verify_stage "$STAGE_DIR"
  promote_stage "$STAGE_DIR"
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
  SPAWN_SERVER_URL="$SERVER" "$APP_DIR/rel/bin/spawnd" daemon
  say "started spawnd in release daemon mode"
  say "logs: tail -f $APP_DIR/rel/log/erlang.log.1"
}

install_runtime_prereqs
mkdir -p "$BIN_DIR"
if [ "$BUILD_FROM_SOURCE" = "1" ]; then
  install_build_prereqs
  require_erlang_otp
  install_from_source
else
  install_prebuilt
fi
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
