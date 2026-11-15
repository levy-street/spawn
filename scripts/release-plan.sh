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
  --to REF      The commit being released. Default: HEAD. The fingerprint is
                computed from the checkout, so --to must be checked out, clean
                under mobile/, for the mobile store row to answer.
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

It is asked per platform, against the last finished production build of that
platform, because a store build is per platform. The two fingerprints differ
only in platform-specific native inputs: native module code and autolinking
for that platform, and its own icon, splash and service files. Everything
else is in both: the whole app config (ios and android sections alike), config
plugin code, mobile/package.json scripts, mobile/.gitignore, eas.json and
patches/. So only a native module or asset change can owe one platform alone;
a config, eas.json or patch change owes both. Each answer is yes/no/unknown,
and mobile_native_build is "yes" if either is yes, else "unknown" if either is.

It also reports the runtime version this tree's OTA would carry and the one
each platform's last build has. Every install on a runtime receives every OTA
published for it, so a native change on an unchanged runtime reaches the
phones that lack it with the next JavaScript-only release.
Owing a store build never starts one; see "The phone" in docs/RELEASE.md.
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

# Small parsers, kept as data so shell and Python quoting cannot leak into
# each other. Each prints one line and never fails on bad input.
latest_build_py="$(cat <<'EOF'
import json, re, sys
try:
    builds = json.load(sys.stdin)
except Exception:
    builds = []
build = builds[0] if isinstance(builds, list) and builds and isinstance(builds[0], dict) else {}
build_id, commit = str(build.get("id") or ""), str(build.get("gitCommitHash") or "")
runtime = build.get("runtime")
runtime = str((runtime.get("version") if isinstance(runtime, dict) else build.get("runtimeVersion")) or "")
print(build_id if re.fullmatch(r"[0-9a-f-]{36}", build_id) else "-",
      commit if re.fullmatch(r"[0-9a-f]{40}", commit) else "-",
      runtime if re.fullmatch(r"[A-Za-z0-9._+-]{1,64}", runtime) else "-")
EOF
)"
# The runtime version an OTA of this tree would carry. app.json holds it and
# app.config.ts sets neither version nor runtimeVersion; any policy other than
# appVersion (or a literal) is reported as unknown rather than computed.
runtime_py="$(cat <<'EOF'
import json, re, sys
try:
    app = json.load(sys.stdin)
    expo = app.get("expo", app)
    policy = expo.get("runtimeVersion")
    runtime = policy if isinstance(policy, str) else (
        expo.get("version") if isinstance(policy, dict) and policy.get("policy") == "appVersion" else "")
except Exception:
    runtime = ""
runtime = str(runtime or "")
print(runtime if re.fullmatch(r"[A-Za-z0-9._+-]{1,64}", runtime) else "unknown")
EOF
)"
profile_env_py="$(cat <<'EOF'
import json, re, sys
try:
    profiles = json.load(sys.stdin)["build"]
except Exception:
    raise SystemExit
env, name, seen = {}, "production", set()
while name in profiles and name not in seen:
    seen.add(name)
    profile = profiles[name]
    env = {**(profile.get("env") or {}), **env}
    name = profile.get("extends")
for key, value in env.items():
    if re.fullmatch(r"[A-Z_][A-Z0-9_]*", key) and "\n" not in str(value):
        print(f"{key}={value}")
EOF
)"
compare_py="$(cat <<'EOF'
import json, sys
build_id, runtime = sys.argv[1], sys.argv[2]
try:
    answer = json.load(sys.stdin)
except Exception:
    answer = {}
if not isinstance(answer, dict):
    answer = {}
first, second = answer.get("fingerprint1") or {}, answer.get("fingerprint2") or {}
a, b = first.get("hash"), second.get("hash")
if not (a and b):
    print(f"unknown\t{runtime}\tthe fingerprint comparison with build {build_id} did not answer")
    raise SystemExit
if a == b:
    print(f"no\t{runtime}\tthe native fingerprint still matches build {build_id}")
    raise SystemExit

# Name what differs (sources and config keys, never values) so whoever decides
# on a store build can see why without rerunning anything.
def index(fingerprint):
    out = {}
    for source in fingerprint.get("sources") or []:
        if isinstance(source, dict):
            out[str(source.get("filePath") or source.get("id"))] = source
    return out

def keys(x, y, path=""):
    if isinstance(x, dict) and isinstance(y, dict):
        for key in sorted(set(x) | set(y)):
            yield from keys(x.get(key), y.get(key), f"{path}.{key}" if path else key)
    elif x != y:
        yield path

x, y = index(first), index(second)
changed = []
for name in sorted(set(x) | set(y)):
    s, t = x.get(name) or {}, y.get(name) or {}
    if (s.get("hash"), s.get("contents")) == (t.get("hash"), t.get("contents")):
        continue
    try:
        fields = list(keys(json.loads(s["contents"]), json.loads(t["contents"])))
        changed.append(f"{name} ({' '.join(fields[:4])})")
    except Exception:
        changed.append(name)
detail = ", ".join(changed[:6]) + (", ..." if len(changed) > 6 else "")
print(f"yes\t{runtime}\tthe native fingerprint no longer matches build {build_id}"
      + (f": {detail}" if detail else ""))
EOF
)"

# One platform's native verdict, printed as
# "<yes|no|unknown><TAB><that build's runtime version><TAB><reason>".
#
# Expo's fingerprint hashes the whole evaluated app config, `extra` included,
# and app.config.ts stamps two values there that are not native: the mobile
# tree hash of the commit (`extra.mobileTree`) and the API URL from the build
# profile's env (`extra.apiUrl`). A build hashed both as they were for *its*
# commit under *its* profile. Comparing this tree with any other values makes
# every change under mobile/ — a test, a doc — read as a new native shell,
# which is how every mobile release used to buy a store build per platform.
# So the comparison evaluates this tree with the build's own stamp and the
# build profile's env, and everything else is left for Expo to judge.
native_verdict() { # platform
  local platform="$1" listing build_id="-" build_commit="-" build_runtime="-" build_tree line
  listing="$(
    cd mobile && "${eas_bin[@]}" build:list \
      --platform "$platform" --buildProfile production --status finished \
      --limit 1 --non-interactive --json 2>/dev/null || true
  )"
  read -r build_id build_commit build_runtime < <(python3 -c "$latest_build_py" <<<"$listing") || true
  [[ "${build_runtime:--}" != "-" ]] || build_runtime="unknown"
  if [[ "${build_id:--}" == "-" ]]; then
    printf 'unknown\tunknown\tno finished production %s build to compare against\n' "$platform"
    return
  fi
  if [[ "${build_commit:--}" == "-" ]] || ! git cat-file -e "$build_commit^{commit}" 2>/dev/null; then
    printf 'unknown\t%s\tbuild %s names no commit in this repository, so its config cannot be reproduced\n' \
      "$build_runtime" "$build_id"
    return
  fi
  build_tree="$(git rev-parse "$build_commit:mobile")"
  if [[ "$build_tree" == "$(git rev-parse "$to:mobile")" ]]; then
    printf 'no\t%s\tbuild %s was made from this mobile tree\n' "$build_runtime" "$build_id"
    return
  fi

  # The env the build evaluated app.config.ts with: its own eas.json's
  # production profile (following `extends`), then its own tree stamp. An
  # inherited EXPO_PUBLIC_* from this shell would be a value no build had.
  local -a run_env=()
  while read -r line; do run_env+=(-u "$line"); done < <(compgen -e | grep '^EXPO_PUBLIC_' || true)
  while IFS= read -r line; do
    [[ -n "$line" ]] && run_env+=("$line")
  done < <(git show "$build_commit:mobile/eas.json" 2>/dev/null | python3 -c "$profile_env_py" || true)
  run_env+=("EXPO_PUBLIC_SPAWN_MOBILE_TREE=$build_tree")

  (
    cd mobile && env "${run_env[@]}" "${eas_bin[@]}" fingerprint:compare \
      --build-id "$build_id" --json --non-interactive 2>/dev/null || true
  ) | python3 -c "$compare_py" "$build_id" "$build_runtime"
}

# The native shell question. Only asked when mobile changed at all: an
# unchanged mobile tree cannot have changed its fingerprint.
native_ios="no"; native_ios_reason="the mobile tree is unchanged"
native_android="no"; native_android_reason="the mobile tree is unchanged"
native_ios_runtime="unknown"; native_android_runtime="unknown"
mobile_runtime="$(git show "$to:mobile/app.json" 2>/dev/null | python3 -c "$runtime_py" || true)"
[[ -n "$mobile_runtime" ]] || mobile_runtime="unknown"
if [[ "$mobile_changed" == true ]]; then
  skip=""
  if [[ "$do_fingerprint" != 1 ]]; then
    skip="the fingerprint check was skipped"
  elif [[ "$(git rev-parse HEAD)" != "$(git rev-parse "$to")" ]] || ! git diff --quiet HEAD -- mobile; then
    skip="the fingerprint is computed from the checkout, which is not a clean $(git rev-parse --short "$to")"
  fi
  if [[ -n "$skip" ]]; then
    native_ios="unknown"; native_ios_reason="$skip"
    native_android="unknown"; native_android_reason="$skip"
  else
    # eas-cli is not one of mobile's devDependencies, so a bare runner (the
    # release pipeline's plan job) must fetch it; same resolution as
    # update-mobile-prod.sh.
    eas_bin=(eas)
    command -v eas >/dev/null 2>&1 || eas_bin=(npx --yes eas-cli)
    IFS=$'\t' read -r native_ios native_ios_runtime native_ios_reason < <(native_verdict ios) || true
    IFS=$'\t' read -r native_android native_android_runtime native_android_reason \
      < <(native_verdict android) || true
    # A check that fell over is a check that did not answer, never a "no".
    [[ "$native_ios" =~ ^(yes|no|unknown)$ ]] ||
      { native_ios="unknown"; native_ios_reason="the ios fingerprint check failed"; }
    [[ "$native_android" =~ ^(yes|no|unknown)$ ]] ||
      { native_android="unknown"; native_android_reason="the android fingerprint check failed"; }
    [[ -n "$native_ios_runtime" ]] || native_ios_runtime="unknown"
    [[ -n "$native_android_runtime" ]] || native_android_runtime="unknown"
  fi
fi

if [[ "$native_ios" == yes || "$native_android" == yes ]]; then
  mobile_native="yes"
elif [[ "$native_ios" == unknown || "$native_android" == unknown ]]; then
  mobile_native="unknown"
else
  mobile_native="no"
fi
if [[ "$native_ios_reason" == "$native_android_reason" ]]; then
  mobile_native_reason="$native_ios_reason"
else
  mobile_native_reason="ios: $native_ios_reason; android: $native_android_reason"
fi

if [[ "$as_json" == 1 ]]; then
  python3 - "$(git rev-parse "$from")" "$(git rev-parse "$to")" \
    "$server_changed" "$daemon_changed" "$mobile_changed" \
    "$mobile_native" "$mobile_native_reason" \
    "$native_ios" "$native_ios_reason" "$native_android" "$native_android_reason" \
    "$mobile_runtime" "$native_ios_runtime" "$native_android_runtime" \
    "$desktop_changed" <<'EOF'
import json, sys
(base, candidate, deploy, daemon, mobile, native, reason,
 ios, ios_reason, android, android_reason,
 runtime, ios_runtime, android_runtime, desktop) = sys.argv[1:]
print(json.dumps({
    "from": base,
    "to": candidate,
    "deploy": deploy == "true",
    "daemon_prebuilts": daemon == "true",
    "mobile_ota": mobile == "true",
    "mobile_native_build": native,
    "mobile_native_reason": reason,
    "mobile_native_ios": ios,
    "mobile_native_ios_reason": ios_reason,
    "mobile_native_android": android,
    "mobile_native_android_reason": android_reason,
    "mobile_runtime": runtime,
    "mobile_native_ios_runtime": ios_runtime,
    "mobile_native_android_runtime": android_runtime,
    "desktop_publish": desktop == "true",
}, indent=2))
EOF
  exit 0
fi

printf 'release-plan: %s..%s\n' "$(git rev-parse --short "$from")" "$(git rev-parse --short "$to")"
printf '  deploy server + web    %s\n' "$server_changed"
printf '  daemon prebuilts       %s\n' "$daemon_changed"
printf '  mobile OTA             %s\n' "$mobile_changed"
printf '  mobile store build     %s\n' "$mobile_native"
printf '    ios                  %s  (%s; build runtime %s)\n' \
  "$native_ios" "$native_ios_reason" "$native_ios_runtime"
printf '    android              %s  (%s; build runtime %s)\n' \
  "$native_android" "$native_android_reason" "$native_android_runtime"
printf '  mobile runtime         %s\n' "$mobile_runtime"
printf '  desktop publish        %s\n' "$desktop_changed"
