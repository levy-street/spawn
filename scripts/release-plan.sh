#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/release-plan.sh [--from REF] [--to REF] [--json] [--no-fingerprint]

Work out what a release owes, from what actually changed.

docs/RELEASE.md answers this as a table keyed on *which tree changed*, because
that is what the identities at /api/release are derived from. This script is
that table, executed, so a pipeline can decide instead of a person remembering.

  --from REF    The commit currently in production. Default: the previous
                commit on this branch (HEAD^), which is what a push to master
                means.
  --to REF      The commit being released. Default: HEAD.
  --json        Machine-readable, for a workflow to branch on.
  --no-fingerprint
                Skip the EAS fingerprint check, which needs network and auth.
                mobile_native is reported as "unknown" rather than guessed.

The mobile question is the subtle one, and it is not "did mobile/ change".
An over-the-air update carries JavaScript and assets; it cannot carry native
code, and it only reaches installs whose runtimeVersion matches. So the real
question is whether this tree still fits the native shell that is already on
people's phones — and Expo answers that exactly, by fingerprint. A mismatch
means an OTA would either be refused by every install or, worse, ship
JavaScript that calls native code the shell does not have. That is when a
store build is owed, and it is the only time it is owed.
EOF
}

die() { printf 'release-plan: %s\n' "$*" >&2; exit 1; }

from=""; to="HEAD"; as_json=0; do_fingerprint=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --from) [[ $# -ge 2 ]] || die "--from needs a ref"; from="$2"; shift 2 ;;
    --to) [[ $# -ge 2 ]] || die "--to needs a ref"; to="$2"; shift 2 ;;
    --json) as_json=1; shift ;;
    --no-fingerprint) do_fingerprint=0; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

git rev-parse --verify --quiet "$to^{commit}" >/dev/null || die "unknown --to ref: $to"
if [[ -z "$from" ]]; then
  from="$(git rev-parse --verify --quiet "$to^" || true)"
  [[ -n "$from" ]] || die "no parent for $to; pass --from explicitly"
fi
git rev-parse --verify --quiet "$from^{commit}" >/dev/null || die "unknown --from ref: $from"

# A subtree's hash is the identity /api/release publishes for that piece, so
# comparing subtree hashes is exactly the question "did this piece change",
# with no path globbing to get subtly wrong.
tree_changed() { # subdir
  local path="$1"
  [[ "$(git rev-parse "$from:$path")" != "$(git rev-parse "$to:$path")" ]]
}

server_changed=false; daemon_changed=false; mobile_changed=false; desktop_changed=false
tree_changed server && server_changed=true
tree_changed web && server_changed=true
tree_changed daemon && daemon_changed=true
tree_changed mobile && mobile_changed=true
tree_changed desktop && desktop_changed=true

# The native shell question. Only asked when mobile changed at all: an
# unchanged mobile tree cannot have changed its fingerprint.
mobile_native="no"
mobile_native_reason="the mobile tree is unchanged"
if [[ "$mobile_changed" == true ]]; then
  if [[ "$do_fingerprint" != 1 ]]; then
    mobile_native="unknown"
    mobile_native_reason="the fingerprint check was skipped"
  else
    # eas-cli is not one of mobile's devDependencies, so a bare runner (the
    # release pipeline's plan job) must fetch it; same resolution as
    # update-mobile-prod.sh.
    eas_bin=(eas)
    command -v eas >/dev/null 2>&1 || eas_bin=(npx --yes eas-cli)
    build_id="$(
      cd mobile && "${eas_bin[@]}" build:list \
        --platform ios --buildProfile production --status finished \
        --limit 1 --non-interactive --json 2>/dev/null |
        python3 -c 'import json,sys
try:
    builds = json.load(sys.stdin)
except Exception:
    builds = []
print(builds[0]["id"] if builds else "")' 2>/dev/null || true
    )"
    if [[ -z "$build_id" ]]; then
      mobile_native="unknown"
      mobile_native_reason="no finished production build to compare against"
    else
      verdict="$(
        cd mobile && "${eas_bin[@]}" fingerprint:compare \
          --build-id "$build_id" --json --non-interactive 2>/dev/null |
          python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("unknown"); raise SystemExit
a = (d.get("fingerprint1") or {}).get("hash")
b = (d.get("fingerprint2") or {}).get("hash")
print("no" if a and b and a == b else ("yes" if a and b else "unknown"))' 2>/dev/null || true
      )"
      case "$verdict" in
        no)  mobile_native="no";  mobile_native_reason="the native fingerprint still matches build $build_id" ;;
        yes) mobile_native="yes"; mobile_native_reason="the native fingerprint no longer matches build $build_id" ;;
        *)   mobile_native="unknown"; mobile_native_reason="the fingerprint comparison did not answer" ;;
      esac
    fi
  fi
fi

if [[ "$as_json" == 1 ]]; then
  printf '{\n'
  printf '  "from": "%s",\n' "$(git rev-parse "$from")"
  printf '  "to": "%s",\n' "$(git rev-parse "$to")"
  printf '  "deploy": %s,\n' "$server_changed"
  printf '  "daemon_prebuilts": %s,\n' "$daemon_changed"
  printf '  "mobile_ota": %s,\n' "$mobile_changed"
  printf '  "mobile_native_build": "%s",\n' "$mobile_native"
  printf '  "mobile_native_reason": "%s",\n' "$mobile_native_reason"
  printf '  "desktop_publish": %s\n' "$desktop_changed"
  printf '}\n'
  exit 0
fi

printf 'release-plan: %s..%s\n' "$(git rev-parse --short "$from")" "$(git rev-parse --short "$to")"
printf '  deploy server + web    %s\n' "$server_changed"
printf '  daemon prebuilts       %s\n' "$daemon_changed"
printf '  mobile OTA             %s\n' "$mobile_changed"
printf '  mobile store build     %s  (%s)\n' "$mobile_native" "$mobile_native_reason"
printf '  desktop publish        %s\n' "$desktop_changed"
