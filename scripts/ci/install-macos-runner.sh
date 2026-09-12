#!/usr/bin/env bash
# Run from the dedicated build or release user's logged-in macOS session.
set -euo pipefail
role="${1:?usage: install-macos-runner.sh build|release}"
case "$role" in build|release) ;; *) echo 'Role must be build or release' >&2; exit 1 ;; esac
[[ "$(uname -s)/$(uname -m)" == Darwin/arm64 ]]
[[ "$(id -u)" != 0 ]]
if id -Gn | tr ' ' '\n' | grep -qx admin; then
  echo 'Use a dedicated standard account, separate from the operator and the other CI role.' >&2
  exit 1
fi
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
for tool in git node python3 turnserver; do command -v "$tool" >/dev/null; done
xcodebuild -version
xcrun --find simctl
script_dir="$(cd "$(dirname "$0")" && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$script_dir/runner-versions.json")"
checksum="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"]["osx-arm64"])' "$script_dir/runner-versions.json")"
directory="$HOME/spawnd-ci/runner"
[[ ! -e "$directory" ]] || { echo "Refusing to overwrite $directory" >&2; exit 1; }
umask 077
mkdir -p "$directory"
archive="$(mktemp -t spawnd-ci-runner)"
trap 'rm -f "$archive"; unset registration_token' EXIT
curl -fsSL --retry 3 "https://github.com/actions/runner/releases/download/v$version/actions-runner-osx-arm64-$version.tar.gz" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
tar -xzf "$archive" -C "$directory"
if [[ "$role" == release ]]; then
  cp "$script_dir/release-job-hook.sh" "$HOME/spawnd-ci/release-job-hook.sh"
  chmod 700 "$HOME/spawnd-ci/release-job-hook.sh"
  printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\n' "$HOME/spawnd-ci/release-job-hook.sh" > "$directory/.env"
fi
read -r -s -p 'Short-lived repository runner registration token: ' registration_token
printf '\n'
cd "$directory"
./config.sh --unattended --url https://github.com/levy-street/spawn \
  --token "$registration_token" --name "minimac-spawn-macos-$role" \
  --labels "spawn-macos-$role" --work _work
unset registration_token
if [[ "$role" == release ]]; then
  grep -Fxq "ACTIONS_RUNNER_HOOK_JOB_STARTED=$HOME/spawnd-ci/release-job-hook.sh" .env
fi
./svc.sh install
./svc.sh start
./svc.sh status
