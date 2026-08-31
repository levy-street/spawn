#!/usr/bin/env bash
set -euo pipefail

# Build the Mac app the way a release does — Developer ID signature, notarized
# by Apple, stapled — and stage it where the local server serves /desktop/
# from. This is the rehearsal for the real thing: a disk image built this way
# survives a browser download and opens with no Gatekeeper prompt at all,
# which is the only way to see locally what a user actually sees.
#
# The ordinary `npm run dev --onboarding` build is ad-hoc signed, which is
# enough to install by hand and not enough to download. Use this when the
# download path itself is what you are testing, or before a release, to prove
# the credentials still work outside CI.
#
#   scripts/dev-desktop-signed.sh
#   SPAWN_DEV_DESKTOP_SIGNED=1 npm run dev --onboarding   # the same, in a run
#
# Credentials live outside the repo, in ~/.spawn/apple (docs/RELEASE.md):
#   spawn-developer-id.p12 + .p12.password   the Developer ID Application key
#   AuthKey_<KEYID>.p8                       the App Store Connect API key
#   notary.env                               KEY_ID and ISSUER for that key
# Nothing here is printed, and nothing is written into the repo.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

apple_dir="${SPAWN_APPLE_DIR:-$HOME/.spawn/apple}"
identity="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Dreamhome AI Limited (9RT4S4TGA3)}"

say() { printf 'desktop-signed: %s\n' "$*"; }
die() { printf 'desktop-signed: %s\n' "$*" >&2; exit 1; }

need_file() { [[ -f "$1" ]] || die "missing $1 — see docs/RELEASE.md for where credentials live"; }

command -v xcrun >/dev/null 2>&1 || die "xcrun is missing; install the Xcode command line tools"
xcrun --find notarytool >/dev/null 2>&1 || die "notarytool is missing; it ships with Xcode, not the CLT alone"

p12="$apple_dir/spawn-developer-id.p12"
p12_password_file="$apple_dir/spawn-developer-id.p12.password"
need_file "$p12"
need_file "$p12_password_file"

# KEY_ID and ISSUER identify the notarization key; the .p8 beside them is the
# secret. Keep all three out of the repo.
notary_env="$apple_dir/notary.env"
if [[ -f "$notary_env" ]]; then
  # shellcheck source=/dev/null
  source "$notary_env"
fi
key_id="${SPAWN_NOTARY_KEY_ID:-${KEY_ID:-}}"
issuer="${SPAWN_NOTARY_ISSUER:-${ISSUER:-}}"
[[ -n "$key_id" && -n "$issuer" ]] || die "set KEY_ID and ISSUER in $notary_env (the App Store Connect key id and issuer)"
key_path="$apple_dir/AuthKey_${key_id}.p8"
need_file "$key_path"

version="$(python3 -c 'import json; print(json.load(open("desktop/src-tauri/tauri.conf.json"))["version"])')"
case "$(uname -m)" in
  arm64) arch="darwin-aarch64" ;;
  x86_64) arch="darwin-x86_64" ;;
  *) die "no SPAWN D build for $(uname -m)" ;;
esac
staged="web/public/desktop/SPAWN-D_${version}_${arch}.dmg"

# Tauri imports the p12 into a keychain of its own for the build, so the
# signature never depends on what happens to be in the login keychain — and
# nothing prompts.
APPLE_CERTIFICATE="$(base64 < "$p12" | tr -d '\n')"
APPLE_CERTIFICATE_PASSWORD="$(cat "$p12_password_file")"
export APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
export APPLE_SIGNING_IDENTITY="$identity"
# With these set, Tauri notarizes the .app it bundles. The disk image around it
# is signed but never notarized by Tauri, which is why this script does it.
export APPLE_API_KEY="$key_id"
export APPLE_API_ISSUER="$issuer"
export APPLE_API_KEY_PATH="$key_path"

say "building and signing $version ($arch) as $identity"
[[ -d desktop/node_modules ]] || (cd desktop && npm install --no-audit --no-fund)
(cd desktop && npx tauri build --config src-tauri/tauri.ci.conf.json)

built="$(ls -t desktop/src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1)"
[[ -n "$built" ]] || die "the build produced no disk image"

say "notarizing the disk image — Apple usually answers in a minute or two"
xcrun notarytool submit "$built" \
  --key "$key_path" --key-id "$key_id" --issuer "$issuer" \
  --wait --timeout 30m
xcrun stapler staple "$built"

# `spctl -a` reports "rejected" even for notarized output; the ticket and the
# distribution check are what actually answer the question.
xcrun stapler validate "$built" || die "the notarization ticket did not staple"
if command -v syspolicy_check >/dev/null 2>&1; then
  syspolicy_check distribution "$built" || say "syspolicy_check had something to say about the image; read it above"
fi

mkdir -p web/public/desktop
rm -f web/public/desktop/SPAWN-D_*.dmg
cp "$built" "$staged"
say "staged $staged — notarized and stapled"
say "download it from the local site and it will open with no prompt at all"
