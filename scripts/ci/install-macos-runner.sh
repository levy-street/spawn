#!/usr/bin/env bash
# Run from the dedicated build or release user's logged-in macOS session.
set +x  # Credentials must never be echoed, even if invoked with bash -x.
set -euo pipefail
role="${1:?usage: install-macos-runner.sh build|release}"
case "$role" in build|release) ;; *) echo 'Role must be build or release' >&2; exit 1 ;; esac
[[ "$(uname -s)/$(uname -m)" == Darwin/arm64 ]] || { echo 'Native ARM64 macOS is required' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { echo 'Do not run the runner installer as root' >&2; exit 1; }
if id -Gn | tr ' ' '\n' | grep -qx admin; then
  echo 'Use a dedicated standard account, separate from the operator and the other CI role.' >&2
  exit 1
fi
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/python@3.13/bin:/opt/homebrew/bin:$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
script_dir="$(cd "$(dirname "$0")" && pwd)"
python3 "$script_dir/check-macos-runner.py" --role "$role"
for tool in git node python3 curl shasum; do command -v "$tool" >/dev/null; done
node -e 'if (Number(process.versions.node.split(".")[0]) !== 22) process.exit(1)'
python3 -c 'import sys; assert sys.version_info >= (3, 13), "Python 3.13 or newer is required"'
xcodebuild -version
xcodebuild -checkFirstLaunchStatus
if [[ "$role" == build ]]; then
  for tool in turnserver pod; do command -v "$tool" >/dev/null; done
  pod --version
  xcrun --find simctl
  xcrun simctl list runtimes --json | python3 -c 'import json,sys; assert any(r.get("isAvailable") and "iOS" in r.get("name", "") for r in json.load(sys.stdin)["runtimes"]), "Install an available iOS Simulator runtime first"'
else
  xcrun --find codesign
  xcrun --find notarytool
fi
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$script_dir/runner-versions.json")"
checksum="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"]["osx-arm64"])' "$script_dir/runner-versions.json")"
directory="$HOME/spawnd-ci/runner"
[[ ! -e "$directory" && ! -L "$directory" ]] || { echo "Refusing to overwrite $directory" >&2; exit 1; }
umask 077
mkdir -p "$directory"
archive="$(mktemp -t spawnd-ci-runner)"
trap 'rm -f "$archive"; unset ACTIONS_RUNNER_INPUT_TOKEN' EXIT
curl -fsSL --retry 3 "https://github.com/actions/runner/releases/download/v$version/actions-runner-osx-arm64-$version.tar.gz" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
tar -xzf "$archive" -C "$directory"
if [[ "$role" == release ]]; then
  hook='/Library/Application Support/SPAWN D CI/release-job-hook.sh'
  printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\n' "$hook" > "$directory/.env"
fi
printf 'PATH=%s\nLANG=%s\nLC_ALL=%s\n' "$PATH" "$LANG" "$LC_ALL" >> "$directory/.env"
read -r -s -p 'Short-lived repository runner registration token: ' ACTIONS_RUNNER_INPUT_TOKEN
printf '\n'
[[ -n "$ACTIONS_RUNNER_INPUT_TOKEN" ]] || { echo 'A registration token is required' >&2; exit 1; }
export ACTIONS_RUNNER_INPUT_TOKEN
cd "$directory"
./config.sh --unattended --url https://github.com/levy-street/spawn \
  --name "minimac-spawn-macos-$role" \
  --labels "spawn-macos-$role" --work _work
unset ACTIONS_RUNNER_INPUT_TOKEN
if [[ "$role" == release ]]; then
  python3 "$script_dir/check-macos-runner.py" --hook-only
  grep -Fxq "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook" .env
fi
./svc.sh install
./svc.sh start
./svc.sh status
