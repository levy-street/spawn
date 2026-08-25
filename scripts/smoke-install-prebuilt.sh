#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-install-prebuilt: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need cargo
need curl
need git
need python3
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  printf '%s\n' "smoke-install-prebuilt: missing required sha256 tool" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
server_pid=""
prebuilt_root=""
prebuilt_backup=""
prebuilt_original_moved=0
prebuilt_created=0

cleanup() {
  local status=$?
  if [[ "$status" != "0" && -f "${server_log:-}" ]]; then
    printf '%s\n' "---- server log ----" >&2
    tail -200 "$server_log" >&2 || true
  fi
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  local restore_failed=0
  if [[ "$prebuilt_original_moved" == "1" ]]; then
    rm -rf -- "$prebuilt_root"
    if ! mv "$prebuilt_backup" "$prebuilt_root"; then
      printf 'smoke-install-prebuilt: could not restore prebuilts; backup remains at %s\n' \
        "$prebuilt_backup" >&2
      restore_failed=1
    fi
  elif [[ "$prebuilt_created" == "1" ]]; then
    rm -rf -- "$prebuilt_root"
  fi
  if [[ "$restore_failed" == "1" ]]; then
    status=1
  else
    rm -rf "$tmp_dir"
  fi
  exit "$status"
}
trap cleanup EXIT

port="$(
  python3 - <<'PY'
import socket

s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
base_url="http://127.0.0.1:$port"
server_log="$tmp_dir/server.log"
install_root="$tmp_dir/install-root"
home="$tmp_dir/home"
mkdir -p "$install_root" "$home"

# The release endpoint intentionally ignores loose target/release binaries: a
# verified manifest is what turns prebuilts into an advertised update. Isolate
# any developer-local prebuilt directory so both halves of that contract are
# exercised and restore it in cleanup.
prebuilt_root="$repo_root/daemon/target/prebuilt"
prebuilt_backup="$tmp_dir/original-prebuilt"
if [[ -d "$prebuilt_root" ]]; then
  mv "$prebuilt_root" "$prebuilt_backup"
  prebuilt_original_moved=1
else
  prebuilt_created=1
fi

printf '%s\n' "smoke-install-prebuilt: building release spawnd"
(cd daemon && cargo build --release --locked >/dev/null)

printf '%s\n' "smoke-install-prebuilt: starting install server on $base_url"
(
  cd server
  SPAWN_DATABASE_URL="sqlite+aiosqlite:///$tmp_dir/spawn-install-smoke.db" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-install-secret-with-enough-length \
    SPAWN_PUBLIC_URL="$base_url" \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$port" \
      >"$server_log" 2>&1
) &
server_pid=$!

for _ in {1..80}; do
  if curl -fsS "$base_url/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl -fsS "$base_url/healthz" >/dev/null

printf '%s\n' "smoke-install-prebuilt: asserting no daemon release without a manifest"
curl -fsS "$base_url/api/release" | python3 -c '
import json
import sys

release = json.load(sys.stdin)
if release.get("daemon") is not None:
    raise SystemExit("expected daemon: null before writing manifest.json")
'

case "$(uname -s):$(uname -m)" in
  Darwin:arm64|Darwin:aarch64) target="darwin-aarch64" ;;
  Darwin:x86_64|Darwin:amd64) target="darwin-x86_64" ;;
  Linux:x86_64|Linux:amd64) target="linux-x86_64" ;;
  Linux:aarch64|Linux:arm64) target="linux-aarch64" ;;
  *)
    printf 'smoke-install-prebuilt: unsupported local target %s:%s\n' \
      "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

target_dir="$prebuilt_root/$target"
mkdir -p "$target_dir"
cp daemon/target/release/spawnd "$target_dir/spawnd"
cp daemon/target/release/spawn-worker "$target_dir/spawn-worker"
chmod 755 "$target_dir/spawnd" "$target_dir/spawn-worker"
commit="$(git rev-parse HEAD)"
tree="$(git rev-parse HEAD:daemon)"
version="$("$target_dir/spawnd" --version | awk '{print $2}')"
spawnd_sha="$(sha256_file "$target_dir/spawnd")"
worker_sha="$(sha256_file "$target_dir/spawn-worker")"
python3 - "$prebuilt_root/manifest.json.tmp" \
  "$commit" "$tree" "$version" "$target" "$spawnd_sha" "$worker_sha" <<'PY'
import json
import sys

path, commit, tree, version, target, spawnd_sha, worker_sha = sys.argv[1:]
manifest = {
    "commit": commit,
    "tree": tree,
    "version": version,
    "targets": {
        target: {
            "spawnd_sha256": spawnd_sha,
            "spawn_worker_sha256": worker_sha,
        }
    },
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle)
    handle.write("\n")
PY
mv "$prebuilt_root/manifest.json.tmp" "$prebuilt_root/manifest.json"

printf '%s\n' "smoke-install-prebuilt: asserting the manifest advertises the built daemon"
release_file="$tmp_dir/release.json"
for _ in {1..30}; do
  curl -fsS "$base_url/api/release" -o "$release_file"
  if python3 - "$release_file" "$tree" "$target" "$spawnd_sha" "$worker_sha" <<'PY'
import json
import sys

path, tree, target, spawnd_sha, worker_sha = sys.argv[1:]
release = json.load(open(path, encoding="utf-8"))
daemon = release.get("daemon") or {}
actual = (daemon.get("targets") or {}).get(target) or {}
ok = (
    daemon.get("tree") == tree
    and actual.get("spawnd_sha256") == spawnd_sha
    and actual.get("spawn_worker_sha256") == worker_sha
)
raise SystemExit(0 if ok else 1)
PY
  then
    break
  fi
  sleep 0.1
done
python3 - "$release_file" "$tree" "$target" <<'PY'
import json
import sys

path, tree, target = sys.argv[1:]
daemon = json.load(open(path, encoding="utf-8")).get("daemon") or {}
if daemon.get("tree") != tree or target not in (daemon.get("targets") or {}):
    raise SystemExit("manifest did not become visible through /api/release")
PY

printf '%s\n' "smoke-install-prebuilt: running installer"
HOME="$home" \
  SPAWN_INSTALL_ROOT="$install_root" \
  curl -fsSL "$base_url/install.sh" | HOME="$home" SPAWN_INSTALL_ROOT="$install_root" sh -s -- \
    --server "$base_url" \
    --no-login \
    --no-start \
    --no-service \
    --prebuilt-only

"$install_root/bin/spawnd" --version >/dev/null
test -x "$install_root/bin/spawn-worker"
printf '%s\n' "smoke-install-prebuilt: passed"
