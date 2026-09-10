"""Hosted Unix and Windows installers for `spawnd`."""

from __future__ import annotations

import hashlib
import shlex
import sys
from pathlib import Path
from textwrap import dedent
from typing import Literal
from urllib.parse import urlsplit

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
    "windows-x86_64": "x86_64-pc-windows-msvc",
}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _local_target() -> str | None:
    if sys.platform == "darwin":
        os_name = "darwin"
    elif sys.platform.startswith("linux"):
        os_name = "linux"
    elif sys.platform == "win32":
        os_name = "windows"
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


def _binary_filename(kind: Literal["spawnd", "spawn-worker"], target: str) -> str:
    suffix = ".exe" if target.startswith("windows-") else ""
    return f"{kind}{suffix}"


def _binary_candidates(
    target: str, name: Literal["spawnd", "spawn-worker"], variant: str | None = None
) -> list[Path]:
    """Where a served binary may come from, in order: what the deploy
    published, then a cross-built cargo output, then — for this machine's
    own target — a plain local build. A variant's published copy sits under
    the target's directory, and its local builds under the cargo profile of
    the same name, which is what `--profile <variant>` writes."""
    triple = SUPPORTED_TARGETS[target]
    root = _repo_root()
    filename = _binary_filename(name, target)
    published = release.prebuilt_root(repo_root=root) / target
    profile = "release"
    if variant is not None:
        published = published / variant
        profile = variant
    candidates = [
        published / filename,
        root / "daemon" / "target" / triple / profile / filename,
    ]
    if target == _local_target():
        candidates.append(root / "daemon" / "target" / profile / filename)
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
            arms.append(
                f"        spawnd:{target}) printf %s {target_release.spawnd_sha256.lower()} ;;"
            )
            arms.append(
                "        spawn-worker:"
                f"{target}) printf %s {target_release.spawn_worker_sha256.lower()} ;;"
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


def _serve_binary(
    kind: Literal["spawnd", "spawn-worker"], target: str, variant: str | None
) -> FileResponse:
    noun = "daemon" if kind == "spawnd" else "worker"
    if target not in SUPPORTED_TARGETS:
        raise HTTPException(status_code=404, detail=f"unsupported {noun} target")
    if variant is not None and variant not in release.SUPPORTED_DAEMON_VARIANTS:
        raise HTTPException(status_code=404, detail=f"unsupported {noun} variant")

    candidates = (
        _binary_candidates(target, kind)
        if variant is None
        else _binary_candidates(target, kind, variant)
    )
    binary = next((path for path in candidates if path.is_file()), None)
    if binary is None:
        what = f"{noun} binary" if variant is None else f"{variant} {noun} binary"
        raise HTTPException(status_code=404, detail=f"{what} is not available for {target}")

    # A variant installs under the plain name: it replaces the daemon, it
    # does not sit beside it, so the download filename is the same.
    return FileResponse(
        binary,
        media_type="application/octet-stream",
        filename=_binary_filename(kind, target),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/install/spawnd/{target}")
async def spawnd_binary(target: str) -> FileResponse:
    """Serve the locally-built daemon binary for quick installs."""

    return _serve_binary("spawnd", target, None)


@router.get("/api/install/spawn-worker/{target}")
async def spawn_worker_binary(target: str) -> FileResponse:
    """Serve the worker paired with the locally-built daemon binary."""

    return _serve_binary("spawn-worker", target, None)


@router.get("/api/install/spawnd/{target}/{variant}")
async def spawnd_variant_binary(target: str, variant: str) -> FileResponse:
    """Serve a variant build of the daemon — the diagnostics build a host
    that already runs it updates to. The signed manifest's `variants` map is
    what authorizes the bytes; this route only hands them over."""

    return _serve_binary("spawnd", target, variant)


@router.get("/api/install/spawn-worker/{target}/{variant}")
async def spawn_worker_variant_binary(target: str, variant: str) -> FileResponse:
    """Serve the worker paired with a variant build of the daemon."""

    return _serve_binary("spawn-worker", target, variant)


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


def _windows_prebuilt_hashes() -> tuple[str, str] | None:
    manifest = release.read_prebuilt_manifest(repo_root=_repo_root())
    if manifest is None:
        return None
    target = manifest.targets.get("windows-x86_64")
    if target is None:
        return None
    spawnd_sha = target.spawnd_sha256.lower()
    worker_sha = target.spawn_worker_sha256.lower()
    if (
        len(spawnd_sha) != 64
        or len(worker_sha) != 64
        or any(character not in "0123456789abcdef" for character in spawnd_sha + worker_sha)
    ):
        return None
    return spawnd_sha, worker_sha


def _powershell_single_quote(value: str) -> str:
    return value.replace("'", "''")


@router.get("/install.ps1", response_class=PlainTextResponse)
async def install_powershell_script() -> PlainTextResponse:
    """Return a hash-pinned native Windows installer."""

    hashes = _windows_prebuilt_hashes()
    if hashes is None:
        raise HTTPException(status_code=503, detail="Windows daemon release is not available")

    server = get_settings().public_url.rstrip("/") or "http://localhost:8000"
    parsed = urlsplit(server)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or any(ord(character) < 32 for character in server)
    ):
        raise HTTPException(status_code=503, detail="public server URL is not an absolute HTTP URL")

    script = INSTALL_PS1.replace("__DEFAULT_SERVER__", _powershell_single_quote(server))
    script = script.replace("__WINDOWS_X86_64_SPAWND_SHA256__", hashes[0])
    script = script.replace("__WINDOWS_X86_64_WORKER_SHA256__", hashes[1])
    return PlainTextResponse(
        script,
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


INSTALL_PS1 = dedent(
    r"""
    [CmdletBinding()]
    param(
        [string] $Server = '',
        [string] $Repo = '',
        [string] $Branch = '',
        [switch] $NewAccount,
        [switch] $NoService,
        [switch] $Foreground,
        [switch] $PrebuiltOnly,
        [switch] $NoLogin,
        [switch] $NoStart,
        [string] $Setup = ''
    )

    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version 2.0
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $DefaultServer = '__DEFAULT_SERVER__'
    $PinnedSpawndSha256 = '__WINDOWS_X86_64_SPAWND_SHA256__'
    $PinnedWorkerSha256 = '__WINDOWS_X86_64_WORKER_SHA256__'
    $Target = 'windows-x86_64'

    function Write-Spawn([string] $Message) {
        Write-Host "SPAWN D: $Message"
    }

    function Invoke-Native([scriptblock] $Command, [string] $Description) {
        & $Command
        if ($LASTEXITCODE -ne 0) {
            throw "$Description failed with exit code $LASTEXITCODE"
        }
    }

    function Get-NativeArchitecture {
        try {
            $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
            if ($architecture) { return $architecture.ToUpperInvariant() }
        } catch {
            # Windows PowerShell on an older .NET Framework: use the native-process hint.
        }
        if ($env:PROCESSOR_ARCHITEW6432) {
            return $env:PROCESSOR_ARCHITEW6432.ToUpperInvariant()
        }
        if ($env:PROCESSOR_ARCHITECTURE) {
            return $env:PROCESSOR_ARCHITECTURE.ToUpperInvariant()
        }
        return 'UNKNOWN'
    }

    function Get-Sha256([string] $Path) {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    function Assert-Sha256([string] $Path, [string] $Expected, [string] $Kind) {
        $actual = Get-Sha256 $Path
        if ($actual -ne $Expected.ToLowerInvariant()) {
            throw "$Kind sha256 mismatch (want $Expected, got $actual)"
        }
    }

    function Publish-Pair([string] $StagedSpawnd, [string] $InstallRoot) {
        # spawnd publishes the staged pair as one immutable release under
        # <root>\releases\<version>-<hash> and points <root>\bin at it, unless
        # a daemon on this machine still starts from the old shared pair there,
        # in which case that pair is left alone and follows once it restarts.
        # Nothing here renames or replaces a file a running daemon may be
        # using, and no daemon is stopped to make room.
        $lines = & $StagedSpawnd __publish-release --install-root $InstallRoot --json
        if ($LASTEXITCODE -ne 0) {
            throw "spawnd could not publish the downloaded pair into $InstallRoot (exit code $LASTEXITCODE)"
        }
        $result = (($lines | Out-String).Trim() -split "`n" | Select-Object -Last 1) | ConvertFrom-Json
        if (-not $result.dir) { throw 'spawnd did not report where it published the release' }
        return $result
    }

    function Add-UserPath([string] $Directory) {
        if ($env:SPAWN_INSTALL_NO_PATH -eq '1') { return }
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $entries = @()
        if ($userPath) { $entries = @($userPath -split ';' | Where-Object { $_ }) }
        $alreadyPresent = $entries | Where-Object {
            $_.TrimEnd('\') -ieq $Directory.TrimEnd('\')
        }
        if (-not $alreadyPresent) {
            $newPath = (@($Directory) + $entries) -join ';'
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
            Write-Spawn "saved $Directory in the user PATH; this session is updated too"
        }
        $sessionEntries = @($env:Path -split ';')
        if (-not ($sessionEntries | Where-Object {
            $_.TrimEnd('\') -ieq $Directory.TrimEnd('\')
        })) {
            $env:Path = "$Directory;$env:Path"
        }
    }

    if (-not $Server) { $Server = $DefaultServer }
    $spawnPlatformIsWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
    if (-not $spawnPlatformIsWindows) { throw 'install.ps1 requires native Windows; use install.sh on Unix or WSL' }
    $serverUri = $null
    if (-not [Uri]::TryCreate($Server, [UriKind]::Absolute, [ref] $serverUri) -or
        $serverUri.Scheme -notin @('http', 'https')) {
        throw '-Server must be an absolute http:// or https:// URL'
    }
    $Server = $serverUri.AbsoluteUri.TrimEnd('/')

    $architecture = Get-NativeArchitecture
    if ($architecture -notin @('X64', 'AMD64', 'X86_64')) {
        throw "native Windows architecture $architecture is not supported; v1 requires x86_64 Windows"
    }
    if ($PinnedSpawndSha256 -notmatch '^[0-9a-f]{64}$' -or
        $PinnedWorkerSha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'install.ps1 was rendered without valid Windows release hashes'
    }
    if ($Repo -or $Branch) {
        throw '-Repo and -Branch are Unix source-build options; native Windows installation is prebuilt-only'
    }
    if ($Setup) {
        Write-Spawn '-Setup is no longer needed; approval uses the link spawnd prints'
    }
    if ($PrebuiltOnly) {
        Write-Spawn '-PrebuiltOnly is accepted; Windows installation is always prebuilt-only'
    }

    $installRoot = $env:SPAWN_INSTALL_ROOT
    if (-not $installRoot) {
        if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set' }
        $installRoot = Join-Path $env:LOCALAPPDATA 'spawn'
    }
    $binDir = Join-Path $installRoot 'bin'
    $spawndPath = Join-Path $binDir 'spawnd.exe'
    $workerPath = Join-Path $binDir 'spawn-worker.exe'
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null

    # The live manifest must agree with the pins baked into the exact script that
    # arrived over HTTPS. The daemon updater separately verifies manifest.sig.
    $manifest = Invoke-RestMethod -UseBasicParsing -Uri "$Server/api/install/manifest.json"
    $targetProperty = $manifest.targets.PSObject.Properties[$Target]
    if (-not $targetProperty) { throw "release manifest has no $Target target" }
    $manifestSpawnd = [string] $targetProperty.Value.spawnd_sha256
    $manifestWorker = [string] $targetProperty.Value.spawn_worker_sha256
    if ($manifestSpawnd.ToLowerInvariant() -ne $PinnedSpawndSha256 -or
        $manifestWorker.ToLowerInvariant() -ne $PinnedWorkerSha256) {
        throw 'the live manifest does not match the hashes baked into install.ps1; fetch the installer again'
    }

    # Stage under the install root so the published copy can be a hard link.
    $nonce = [Guid]::NewGuid().ToString('N')
    $stageDir = Join-Path $installRoot "staging-$nonce"
    New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
    $stagedSpawnd = Join-Path $stageDir 'spawnd.exe'
    $stagedWorker = Join-Path $stageDir 'spawn-worker.exe'
    try {
        Write-Spawn "downloading the SPAWN D daemon pair for $Target"
        Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/install/spawnd/$Target" -OutFile $stagedSpawnd
        Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/install/spawn-worker/$Target" -OutFile $stagedWorker
        Assert-Sha256 $stagedSpawnd $PinnedSpawndSha256 'spawnd.exe'
        Assert-Sha256 $stagedWorker $PinnedWorkerSha256 'spawn-worker.exe'
        Unblock-File -LiteralPath $stagedSpawnd -ErrorAction SilentlyContinue
        Unblock-File -LiteralPath $stagedWorker -ErrorAction SilentlyContinue
        Invoke-Native { & $stagedSpawnd --version } 'downloaded spawnd.exe validation'
        Invoke-Native { & $stagedWorker --version } 'downloaded spawn-worker.exe validation'
        $release = Publish-Pair $stagedSpawnd $installRoot
    } finally {
        Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    # The release is what this run installed and what it runs from here on.
    $releaseSpawnd = Join-Path $release.dir 'spawnd.exe'
    $releaseWorker = Join-Path $release.dir 'spawn-worker.exe'
    Assert-Sha256 $releaseSpawnd $PinnedSpawndSha256 'published spawnd.exe'
    Assert-Sha256 $releaseWorker $PinnedWorkerSha256 'published spawn-worker.exe'
    Add-UserPath $binDir
    Write-Spawn "installed SPAWN D release $($release.release) at $($release.dir)"
    if ($release.cli_replaced) {
        Write-Spawn "$spawndPath now runs this release"
    } else {
        Write-Spawn "$spawndPath was left as it is: $($release.cli_note)"
    }
    $spawndPath = $releaseSpawnd

    if ($NoLogin) {
        Write-Spawn 'skipping login'
        return
    }
    if ($NoStart) {
        Invoke-Native { & $spawndPath --server $Server login --no-run } 'SPAWN D login'
        Write-Spawn 'login complete; not starting the daemon because -NoStart was set'
        return
    }
    if ($Foreground) {
        Invoke-Native { & $spawndPath --server $Server login --no-run } 'SPAWN D login'
        Invoke-Native { & $spawndPath --server $Server run } 'SPAWN D foreground run'
        return
    }
    if ($NoService) {
        Invoke-Native { & $spawndPath --server $Server login --no-run } 'SPAWN D login'
        $stateDir = Join-Path $env:LOCALAPPDATA 'spawn\state'
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        Start-Process -FilePath $spawndPath -ArgumentList @('--server', $Server, 'run') `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $stateDir 'spawnd.stdout.log') `
            -RedirectStandardError (Join-Path $stateDir 'spawnd.stderr.log') | Out-Null
        Write-Spawn "started SPAWN D in the background; logs are in $stateDir"
        return
    }

    # The call operator keeps possession/login prompts attached to this console.
    if ($NewAccount) {
        Invoke-Native { & $spawndPath --server $Server possess --new-account } 'SPAWN D possession'
    } else {
        Invoke-Native { & $spawndPath --server $Server possess } 'SPAWN D possession'
    }
    """
).lstrip()


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
    # The release this run publishes; set by publish_pair. Everything the
    # installer runs afterwards runs this exact build.
    RELEASE_DIR=""
    RUN_BIN=""

    # Everything downloaded or built lands here and never in $BIN_DIR. The
    # daemon publishes the pair from here into the release store itself.
    TMP_BASE=${TMPDIR:-/tmp}
    TMP_DIR="$TMP_BASE/spawn-install.$$"
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"
    trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

    say() {
      printf '%s\n' "SPAWN D: $*"
    }

    die() {
      printf '%s\n' "SPAWN D: $*" >&2
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
      --server URL       spawnd server URL. Default: $DEFAULT_SERVER
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

    # Hand a pair to spawnd itself. It publishes the two files as one immutable
    # release under $INSTALL_ROOT/lib/spawn/releases/<version>-<hash> and points
    # $BIN at it — unless a daemon on this machine still starts from the old
    # shared pair in $BIN_DIR, in which case that pair is left exactly as it is
    # and follows once that daemon restarts. Nothing in this script writes a
    # file a running daemon could be using; that is what took a host's
    # sessions down on 2026-09-09. A second account installed here gets its own
    # release directory beside this one, never this one's files.
    publish_pair() {
      _pair_dir=$1
      _out=$("$_pair_dir/spawnd" __publish-release --install-root "$INSTALL_ROOT") \
        || die "spawnd could not publish the downloaded pair into $INSTALL_ROOT"
      printf '%s\n' "$_out"
      RELEASE_DIR=$(printf '%s\n' "$_out" | sed -n 's/^spawn: published .* to //p' | head -n 1)
      [ -n "$RELEASE_DIR" ] && [ -x "$RELEASE_DIR/spawnd" ] \
        || die "spawnd did not report where it published the release"
      RUN_BIN="$RELEASE_DIR/spawnd"
    }

    install_spawnd() {
      say "building spawnd from $REPO#$BRANCH"
      export PATH="$BIN_DIR:$HOME/.cargo/bin:$PATH"

      git clone --depth 1 --branch "$BRANCH" "$REPO" "$TMP_DIR/spawn"
      cargo install --path "$TMP_DIR/spawn/daemon" --locked --root "$TMP_DIR/build" --force
      [ -x "$TMP_DIR/build/bin/spawnd" ] || die "spawnd did not build"
      [ -x "$TMP_DIR/build/bin/spawn-worker" ] || die "spawn-worker did not build"
      publish_pair "$TMP_DIR/build/bin"
    }

    host_target() {
      OS_NAME=$(uname -s 2>/dev/null || printf unknown)
      ARCH_NAME=$(uname -m 2>/dev/null || printf unknown)
      case "$OS_NAME:$ARCH_NAME" in
        MINGW*:*|MSYS*:*|CYGWIN*:*)
          return 2
          ;;
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
      if TARGET=$(host_target); then
        :
      else
        host_status=$?
        if [ "$host_status" -eq 2 ]; then
          die "native Windows uses PowerShell: irm ${SERVER%/}/install.ps1 | iex"
        fi
        return 1
      fi
      need curl || return 1
      URL="${SERVER%/}/api/install/spawnd/$TARGET"
      WORKER_URL="${SERVER%/}/api/install/spawn-worker/$TARGET"
      STAGE="$TMP_DIR/prebuilt"
      mkdir -p "$STAGE"
      TMP_BIN="$STAGE/spawnd"
      TMP_WORKER="$STAGE/spawn-worker"
      rule "INSTALLING SPAWN D"
      say "downloading prebuilt spawnd + spawn-worker for $TARGET"
      if curl -fsSL "$URL" -o "$TMP_BIN" && curl -fsSL "$WORKER_URL" -o "$TMP_WORKER"; then
        if ! verify_prebuilt "$TMP_BIN" spawnd || ! verify_prebuilt "$TMP_WORKER" spawn-worker; then
          rm -rf "$STAGE"
          say "prebuilt checksum verification failed; falling back to source"
          return 1
        fi
        say "verified both binaries against the server's signed manifest"
        chmod 755 "$TMP_BIN"
        chmod 755 "$TMP_WORKER"
        if "$TMP_BIN" --version >/dev/null 2>&1; then
          publish_pair "$STAGE"
          return 0
        fi
        rm -rf "$STAGE"
        say "prebuilt daemon is not compatible with this host"
        return 1
      fi
      rm -rf "$STAGE"
      return 1
    }

    start_background() {
      STATE_DIR="$HOME/.local/state/spawn"
      mkdir -p "$STATE_DIR"
      nohup "$RUN_BIN" --server "$SERVER" run >> "$STATE_DIR/spawnd.log" 2>&1 &
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
    have_tty() { ( : < /dev/tty ) 2>/dev/null; }

    run_attached() {
      if have_tty; then
        "$@" < /dev/tty
      else
        "$@"
      fi
    }

    # exec replaces this shell, so the EXIT trap never fires: clean up first.
    exec_attached() {
      rm -rf "$TMP_DIR"
      if have_tty; then
        exec "$@" < /dev/tty
      fi
      exec "$@"
    }

    if ! install_prebuilt_spawnd; then
      [ "$PREBUILT_ONLY" = "0" ] || die "prebuilt daemon unavailable for this host"
      say "prebuilt daemon unavailable; falling back to source build"
      install_runtime_prereqs
      install_build_prereqs
      ensure_rust
      install_spawnd
    fi
    install_runtime_prereqs
    "$RUN_BIN" --version >/dev/null 2>&1 || die "installed spawnd cannot run on this host"
    [ -x "$BIN" ] || die "spawnd is not on PATH at $BIN"
    [ -x "$WORKER_BIN" ] || die "installed spawn-worker is missing"

    say "installed $("$RUN_BIN" --version 2>/dev/null || printf spawnd) at $BIN with $WORKER_BIN"
    say "release: $RELEASE_DIR"

    if [ "$LOGIN_AFTER_INSTALL" = "0" ]; then
      say "skipping login"
      exit 0
    fi

    # Every command below runs the release just published, whatever $BIN
    # resolves to: a host whose daemon still starts from the old shared pair
    # keeps that pair on PATH until the daemon restarts, and must still be
    # possessed by the new build.

    # --no-start: register the host but do not start it.
    if [ "$START_AFTER_LOGIN" = "0" ]; then
      run_attached "$RUN_BIN" --server "$SERVER" login --no-run
      say "login complete; not starting daemon because --no-start was set"
      exit 0
    fi

    # --foreground: register, then run in the foreground.
    if [ "$FOREGROUND" = "1" ]; then
      run_attached "$RUN_BIN" --server "$SERVER" login --no-run
      rm -rf "$TMP_DIR"
      exec "$RUN_BIN" --server "$SERVER" run
    fi

    # --no-service: register, then background without a service manager.
    if [ "$USE_SERVICE" = "0" ]; then
      run_attached "$RUN_BIN" --server "$SERVER" login --no-run
      start_background
      say "done"
      exit 0
    fi

    # Default: possess runs the login flow (if needed) and installs a supervised
    # background service, idempotently — it owns the service lifecycle now, and
    # points the service at this instance's release, never at $BIN.
    if [ "$NEW_ACCOUNT" = "1" ]; then
      exec_attached "$RUN_BIN" --server "$SERVER" possess --new-account
    fi
    exec_attached "$RUN_BIN" --server "$SERVER" possess
    """
).lstrip()
