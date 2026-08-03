#!/usr/bin/env bash
# Verify that a server is serving the client built from THIS source tree, on
# THIS machine.
#
# It rebuilds the web client locally and byte-compares what the target server
# returns across the surfaces a browser actually fetches:
#
#   1. /_next/static/**  -- the hashed JS/CSS build surface.
#   2. /sw.js and the other public assets (/manifest.webmanifest, /icon-*.png),
#      compared against the in-repo web/public sources. sw.js is the highest-
#      leverage file of all: it is a fetch handler that proxies every same-origin
#      GET and caches /_next/static/* cache-first, so a single backdoored /sw.js
#      compromises the client even when every hashed chunk matches byte-for-byte.
#   3. the prerendered STATIC-route HTML the build emits under
#      .next/server/app/*.html (e.g. /, /login, /agents/new), compared against
#      the fresh local build.
#
# WHAT THIS PROVES
#
# A same-machine rebuild of this commit reproduces the static surface, the
# service worker, the public assets, and the listed static HTML that the target
# serves. That detects BROAD tampering -- including a swapped service worker,
# altered/extra chunks, or a modified static page.
#
# WHAT THIS DOES *NOT* PROVE (do not overstate the result)
#
#   - Not targeted-tamper-proof: a hostile server can serve a clean bundle to
#     this script and a backdoored one to a single session keyed on cookie, IP,
#     or user-agent. Hiding an attack then requires targeting, which makes mass
#     compromise hard to conceal -- it does not make the tab trustworthy. See
#     docs/TRUST.md "client verifiability"; closing this needs an append-only
#     transparency log.
#   - NOT third-party / cross-machine reproducible, which is the case a verifier
#     actually needs. Measured against dev: 25 of 44 served assets matched
#     byte-for-byte and the other 19 differed only in webpack module ORDER inside
#     the chunk (identical byte length, same modules, emitted in a different
#     sequence) -- which changes the content hash and so the filename. The two
#     machines differed in bun (1.3.13 vs 1.3.14), node (v20.20.2 vs v22.19.0),
#     and CPU count (16 vs 12), any of which can reorder emission. A same-machine
#     rebuild is reproducible; a different-machine rebuild is not. Commit 91b9395
#     records that cross-machine reproducibility is not yet achieved. Closing it
#     needs a pinned build environment (container), not a better script.
#   - Dynamic / SSR HTML is NOT compared. Only fully-prerendered static routes
#     emit an .html file; parametric/SSR routes (e.g. /agents/[id], /hosts/[id])
#     render per-request and are an explicitly named residual gap.
#   - The comparison is one-directional: it checks that everything this build
#     produces is served identically, but it cannot enumerate EXTRA endpoints a
#     server may serve (there is no directory listing), so server-only assets
#     this build does not produce are invisible to it.
#
# The rest of .next is deliberately not compared: those files are not served
# (webpack manifest key ordering, which is upstream and not fixable from
# userland, plus draft-mode preview secrets that MUST stay random), so comparing
# them would produce permanent false positives.
#
# Both sides must use the same SPAWN_BUILD_ID (default "spawn").
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-}"
if [[ -z "$target" ]]; then
  printf 'usage: %s https://host[:port] [--keep-build]\n' "$0" >&2
  exit 2
fi
target="${target%/}"
keep_build=""
[[ "${2:-}" == "--keep-build" ]] && keep_build=1

export SPAWN_BUILD_ID="${SPAWN_BUILD_ID:-spawn}"
proxy_target="${SPAWN_API_PROXY_TARGET:-http://127.0.0.1:18330}"

printf '== rebuilding the client (SPAWN_BUILD_ID=%s) ==\n' "$SPAWN_BUILD_ID"
build_dir="$(mktemp -d)"
cleanup() { [[ -n "$keep_build" ]] || rm -rf "$build_dir"; }
trap cleanup EXIT

(
  cd "$repo_root/web"
  SPAWN_API_PROXY_TARGET="$proxy_target" bun run build >"$build_dir/build.log" 2>&1 || {
    printf 'build failed; see %s\n' "$build_dir/build.log" >&2
    exit 1
  }
)

static_root="$repo_root/web/.next/static"
public_root="$repo_root/web/public"
app_html_root="$repo_root/web/.next/server/app"
if [[ ! -d "$static_root" ]]; then
  printf 'no build output at %s\n' "$static_root" >&2
  exit 1
fi

printf '== comparing served assets against %s ==\n' "$target"
checked=0
missing=0
mismatched=0
served="$build_dir/served.bin"

# Fetch $2 and byte-compare it against local file $1; $3 is the printed label.
compare_asset() {
  local local_file="$1" url="$2" label="$3" code local_hash served_hash
  # --globoff: route paths contain [id], which curl otherwise reads as a range.
  code="$(curl -sS --globoff -o "$served" -w '%{http_code}' --max-time 30 "$url" || echo 000)"
  if [[ "$code" != "200" ]]; then
    printf 'MISSING  %s (HTTP %s)\n' "$label" "$code"
    missing=$((missing + 1))
    return
  fi
  local_hash="$(sha256sum "$local_file" | cut -d' ' -f1)"
  served_hash="$(sha256sum "$served" | cut -d' ' -f1)"
  if [[ "$local_hash" != "$served_hash" ]]; then
    printf 'MISMATCH %s\n         local  %s\n         served %s\n' "$label" "$local_hash" "$served_hash"
    mismatched=$((mismatched + 1))
  fi
  checked=$((checked + 1))
}

# 1. Hashed static build surface: /_next/static/**.
while IFS= read -r local_file; do
  rel="${local_file#"$static_root"/}"
  compare_asset "$local_file" "$target/_next/static/$rel" "_next/static/$rel"
done < <(find "$static_root" -type f | sort)

# 2. Public assets served at the site root, compared against the in-repo
#    sources: /sw.js (the proxying/caching service worker), /manifest.webmanifest,
#    and the icons. These are the served files a browser fetches that live
#    outside /_next/static and were previously never compared.
if [[ -d "$public_root" ]]; then
  while IFS= read -r local_file; do
    rel="${local_file#"$public_root"/}"
    compare_asset "$local_file" "$target/$rel" "$rel"
  done < <(find "$public_root" -type f | sort)
fi

# 3. Prerendered static-route HTML. Only fully-static routes emit an .html file;
#    dynamic/SSR routes do not and are a named residual gap. Underscore-prefixed
#    internal pages (e.g. _not-found) and any parametric [..] shells are skipped.
if [[ -d "$app_html_root" ]]; then
  while IFS= read -r local_file; do
    rel="${local_file#"$app_html_root"/}"   # e.g. login.html, agents/new.html, index.html
    case "$rel" in
      _* | */_* | *'['*) continue ;;
    esac
    route="${rel%.html}"
    if [[ "$route" == "index" ]]; then
      route=""
    fi
    compare_asset "$local_file" "$target/$route" "/$route (static html)"
  done < <(find "$app_html_root" -type f -name '*.html' | sort)
fi

printf '\n== result ==\n'
printf 'checked:    %s\n' "$checked"
printf 'mismatched: %s\n' "$mismatched"
printf 'missing:    %s\n' "$missing"

if [[ "$mismatched" -ne 0 || "$missing" -ne 0 ]]; then
  printf '\nthe served client does NOT match this source tree\n' >&2
  exit 1
fi
if [[ "$checked" -eq 0 ]]; then
  printf '\nnothing was compared; refusing to report success\n' >&2
  exit 1
fi
printf '\nsame-machine rebuild: the static surface, /sw.js, the public assets,\n'
printf 'and the listed prerendered static HTML match this source tree.\n'
printf 'NOT proven: cross-machine/third-party reproducibility; dynamic/SSR HTML;\n'
printf 'targeted per-session tampering; or extra server-only assets not built here.\n'
