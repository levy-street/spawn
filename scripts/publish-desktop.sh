#!/usr/bin/env bash
# Publish one promoted SPAWN D desktop release to the static origin that nginx
# serves at <origin>/desktop/ (the `location /desktop/` block in
# infra/nginx-spawnd.conf.example, backed by /var/www/spawnd/desktop on the
# host).
#
# The updater private key never touches this script. Payloads arrive already
# signed (`cargo tauri signer sign`, offline) and latest.json already
# assembled, so all this does is refuse a bad set and then upload in the one
# order that can never strand an installed app: updater payloads and public
# downloads first, the manifest last, and the manifest atomically.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/publish-desktop.sh [ssh-host] <artifact-dir>

<artifact-dir> must hold, for the version V in desktop/src-tauri/tauri.conf.json:

  SPAWN-D_V_darwin-aarch64.dmg                SPAWN-D_V_darwin-x86_64.dmg
  SPAWN-D_V_darwin-aarch64.app.tar.gz         SPAWN-D_V_darwin-x86_64.app.tar.gz
  SPAWN-D_V_darwin-aarch64.app.tar.gz.sig     SPAWN-D_V_darwin-x86_64.app.tar.gz.sig
  SPAWN-D_V_windows-x86_64-setup.exe
  SPAWN-D_V_windows-x86_64-setup.exe.sig
  latest.json

Before anything is uploaded the script proves that latest.json names exactly
that version and all three platforms, that every URL points into this origin's
desktop tree at the payload being uploaded, that each embedded signature is the
matching .sig file, that each signature verifies its payload against the
committed desktop/updater.pubkey, and that the Windows setup EXE carries an
Authenticode certificate table at all. Then the payloads and DMGs go up,
latest.json goes up last through a rename, and every URL is fetched back over
HTTPS.

Environment:
  SPAWN_DEPLOY_HOST      SSH host alias/name. Overridden by [ssh-host].
  SPAWN_DESKTOP_ORIGIN   Public origin. Default: https://spawnd.dev
  SPAWN_DESKTOP_DIR      Static root on the host. Default: /var/www/spawnd/desktop
  SPAWN_DESKTOP_CHANNEL  stable (default) or beta; beta publishes under desktop/beta/.
EOF
}

die() {
  printf 'publish-desktop: %s\n' "$*" >&2
  exit 1
}

host=""
artifact_dir=""
case "$#" in
  1) artifact_dir="$1" ;;
  2) host="$1"; artifact_dir="$2" ;;
  *) usage >&2; exit 2 ;;
esac
case "$artifact_dir" in -h|--help) usage; exit 0 ;; esac

host="${host:-${SPAWN_DEPLOY_HOST:-}}"
[[ -n "$host" ]] || die "missing SSH host; pass one or set SPAWN_DEPLOY_HOST"
[[ -d "$artifact_dir" ]] || die "not a directory: $artifact_dir"

origin="${SPAWN_DESKTOP_ORIGIN:-https://spawnd.dev}"
origin="${origin%/}"
[[ "$origin" == https://* ]] || die "SPAWN_DESKTOP_ORIGIN must be an https:// origin (the app updater refuses anything else)"
remote_root="${SPAWN_DESKTOP_DIR:-/var/www/spawnd/desktop}"
[[ "$remote_root" =~ ^/[A-Za-z0-9/._-]+$ ]] || die "SPAWN_DESKTOP_DIR must be a plain absolute path"
channel="${SPAWN_DESKTOP_CHANNEL:-stable}"
case "$channel" in
  stable) remote_dir="$remote_root"; url_base="$origin/desktop" ;;
  beta) remote_dir="$remote_root/beta"; url_base="$origin/desktop/beta" ;;
  *) die "SPAWN_DESKTOP_CHANNEL must be stable or beta" ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v uv >/dev/null 2>&1 || die "uv is required (the signature check runs in the server venv)"

version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"].strip())' \
  "$repo_root/desktop/src-tauri/tauri.conf.json")" || die "could not read the desktop version"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || die "unexpected desktop version: $version"

platform_specs=(
  "darwin-aarch64:dmg:app.tar.gz"
  "darwin-x86_64:dmg:app.tar.gz"
  "windows-x86_64:-setup.exe:-setup.exe"
)

artifact_name() {
  local platform="$1"
  local suffix="$2"
  if [[ "$suffix" == -* ]]; then
    printf 'SPAWN-D_%s_%s%s' "$version" "$platform" "$suffix"
  else
    printf 'SPAWN-D_%s_%s.%s' "$version" "$platform" "$suffix"
  fi
}

payloads=()
for spec in "${platform_specs[@]}"; do
  IFS=: read -r platform download_suffix updater_suffix <<< "$spec"
  download_name="$(artifact_name "$platform" "$download_suffix")"
  updater_name="$(artifact_name "$platform" "$updater_suffix")"
  [[ -s "$artifact_dir/$download_name" ]] || die "missing or empty: $artifact_dir/$download_name"
  [[ -s "$artifact_dir/$updater_name" ]] || die "missing or empty: $artifact_dir/$updater_name"
  [[ -s "$artifact_dir/$updater_name.sig" ]] || die "missing or empty: $artifact_dir/$updater_name.sig"
  payloads+=("$download_name")
  if [[ "$updater_name" != "$download_name" ]]; then
    payloads+=("$updater_name")
  fi
done
manifest="$artifact_dir/latest.json"
[[ -s "$manifest" ]] || die "missing or empty: $manifest"

printf 'publish-desktop: checking %s for %s %s -> %s/\n' "$artifact_dir" "$version" "$channel" "$url_base"

# One pass over the manifest: shape, version, URLs, embedded-vs-.sig equality,
# and a real minisign verification of every payload against the committed
# public key — the same check scripts/verify-release.sh performs after the
# fact, run before anything leaves this machine.
if ! UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/spawn-release-uv-cache}" \
  uv run --project "$repo_root/server" --frozen python - \
    "$manifest" "$version" "$url_base" "$artifact_dir" "$repo_root/desktop/updater.pubkey" <<'PY'
import base64
import hashlib
import json
import struct
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

manifest_path, version, url_base, artifact_dir, pubkey_path = sys.argv[1:6]
expected_platforms = ("darwin-aarch64", "darwin-x86_64", "windows-x86_64")
updater_suffixes = {
    "darwin-aarch64": ".app.tar.gz",
    "darwin-x86_64": ".app.tar.gz",
    "windows-x86_64": "-setup.exe",
}


def fail(message: str) -> None:
    print(f"publish-desktop: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_authenticode(path: Path) -> None:
    """Refuse a Windows payload that carries no embedded certificate table.

    Chain, subject and RFC 3161 timestamp are proved on Windows in CI, where
    signtool exists. This is the floor underneath that: an unsigned build --
    the windows-package rehearsal installer, or a local `tauri build` -- can
    never be promoted to the public origin from this machine, however
    convincingly it is named.
    """
    data = path.read_bytes()
    if data[:2] != b"MZ":
        raise ValueError("is not a PE image")
    (pe_offset,) = struct.unpack_from("<I", data, 0x3C)
    if data[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise ValueError("has no PE header")
    optional = pe_offset + 24
    (magic,) = struct.unpack_from("<H", data, optional)
    if magic == 0x10B:
        directories = optional + 96
    elif magic == 0x20B:
        directories = optional + 112
    else:
        raise ValueError(f"has an unrecognised PE optional header magic {magic:#x}")
    (count,) = struct.unpack_from("<I", data, directories - 4)
    if count < 5:
        raise ValueError("has no certificate data directory")
    offset, size = struct.unpack_from("<II", data, directories + 4 * 8)
    if offset == 0 or size == 0:
        raise ValueError("is not Authenticode-signed")
    if offset + size > len(data):
        raise ValueError("has a certificate table running past the end of the file")


def decode64(value: str) -> bytes:
    raw = base64.b64decode(value, validate=True)
    if base64.b64encode(raw).decode("ascii") != value:
        raise ValueError("non-canonical base64")
    return raw


def verify(artifact: bytes, signature_outer: str, public_outer: str) -> None:
    lines = decode64(signature_outer).decode("ascii").splitlines()
    if len(lines) != 4 or not lines[0].startswith("untrusted comment: "):
        raise ValueError("invalid minisign signature box")
    if not lines[2].startswith("trusted comment: "):
        raise ValueError("invalid trusted comment")
    blob = decode64(lines[1])
    global_signature = decode64(lines[3])
    if len(blob) != 74 or len(global_signature) != 64:
        raise ValueError("invalid minisign signature lengths")
    if blob[:2] != b"ED":
        raise ValueError("desktop updater signatures must be prehashed")
    public_lines = decode64(public_outer).decode("ascii").splitlines()
    if len(public_lines) != 2 or not public_lines[0].startswith("untrusted comment: "):
        raise ValueError("invalid minisign public key")
    public_blob = decode64(public_lines[1])
    if len(public_blob) != 42 or public_blob[:2] != b"Ed":
        raise ValueError("invalid minisign public key body")
    if blob[2:10] != public_blob[2:10]:
        raise ValueError("signature was made with a different key than desktop/updater.pubkey")
    verifier = Ed25519PublicKey.from_public_bytes(public_blob[10:])
    verifier.verify(blob[10:], hashlib.blake2b(artifact, digest_size=64).digest())
    # minisign's global signature covers the raw signature plus the trusted
    # comment text, without its "trusted comment: " label.
    trusted_comment = lines[2][len("trusted comment: "):]
    verifier.verify(global_signature, blob[10:] + trusted_comment.encode("ascii"))


try:
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
except (OSError, UnicodeError, ValueError) as error:
    fail(f"latest.json is not valid JSON: {error}")
if not isinstance(manifest, dict):
    fail("latest.json must be an object")
if manifest.get("version") != version:
    fail(f"latest.json version {manifest.get('version')!r} is not the desktop version {version!r}")
for key in ("notes", "pub_date"):
    if not isinstance(manifest.get(key), str) or not manifest[key].strip():
        fail(f"latest.json needs a non-empty {key!r}")
platforms = manifest.get("platforms")
if not isinstance(platforms, dict) or tuple(sorted(platforms)) != expected_platforms:
    fail(f"latest.json platforms must be exactly {list(expected_platforms)}")

public_outer = Path(pubkey_path).read_text(encoding="ascii").strip()
for platform in expected_platforms:
    entry = platforms[platform]
    name = f"SPAWN-D_{version}_{platform}{updater_suffixes[platform]}"
    if not isinstance(entry, dict):
        fail(f"{platform}: entry must be an object")
    if entry.get("url") != f"{url_base}/{name}":
        fail(f"{platform}: url must be {url_base}/{name}, got {entry.get('url')!r}")
    signature = entry.get("signature")
    on_disk = (Path(artifact_dir) / f"{name}.sig").read_text(encoding="ascii").strip()
    if not isinstance(signature, str) or signature.strip() != on_disk:
        fail(f"{platform}: embedded signature differs from {name}.sig")
    try:
        verify((Path(artifact_dir) / name).read_bytes(), on_disk, public_outer)
    except (InvalidSignature, OSError, UnicodeError, ValueError) as error:
        fail(f"{platform}: signature does not verify against desktop/updater.pubkey ({error})")
    if platform.startswith("windows-"):
        try:
            require_authenticode(Path(artifact_dir) / name)
        except (OSError, ValueError, struct.error) as error:
            fail(f"{platform}: {name} {error}")
        print(f"publish-desktop: {platform}: Authenticode certificate table present")
    print(f"publish-desktop: {platform}: signature verified")
PY
then
  die "latest.json failed validation; nothing was uploaded"
fi

(cd "$artifact_dir" && shasum -a 256 "${payloads[@]}" latest.json)

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=20)
if [[ "$channel" == "beta" ]]; then
  ssh "${ssh_opts[@]}" "$host" "test -d '$remote_root' && mkdir -p '$remote_dir'" ||
    die "$remote_root is missing on $host; set up the nginx static origin first (docs/RELEASE.md, The desktop app)"
else
  ssh "${ssh_opts[@]}" "$host" "test -d '$remote_dir' && test -w '$remote_dir'" ||
    die "$remote_dir is missing or not writable on $host; set up the nginx static origin first (docs/RELEASE.md, The desktop app)"
fi

printf 'publish-desktop: uploading updater payloads and public downloads to %s:%s\n' "$host" "$remote_dir"
upload_paths=()
for name in "${payloads[@]}"; do
  upload_paths+=("$artifact_dir/$name")
done
scp -q "${ssh_opts[@]}" "${upload_paths[@]}" "$host:$remote_dir/"
ssh "${ssh_opts[@]}" "$host" "cd '$remote_dir' && chmod 644 $(printf '%q ' "${payloads[@]}")"

printf 'publish-desktop: uploading latest.json last\n'
staged=".latest.json.$$"
scp -q "${ssh_opts[@]}" "$manifest" "$host:$remote_dir/$staged"
ssh "${ssh_opts[@]}" "$host" "cd '$remote_dir' && chmod 644 '$staged' && mv -f '$staged' latest.json"

printf 'publish-desktop: reading everything back from %s\n' "$url_base"
for name in "${payloads[@]}"; do
  curl -fsSI --max-time 30 "$url_base/$name" -o /dev/null || die "$url_base/$name is not being served"
done
served="$(mktemp)"
trap 'rm -f -- "$served"' EXIT
curl -fsS --max-time 30 "$url_base/latest.json" -o "$served" || die "$url_base/latest.json is not being served"
cmp -s "$served" "$manifest" || die "served latest.json differs from $manifest"

printf 'publish-desktop: %s %s is live at %s/latest.json\n' "$version" "$channel" "$url_base"
