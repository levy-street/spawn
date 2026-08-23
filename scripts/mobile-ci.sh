#!/usr/bin/env bash
set -euo pipefail

readonly mobile_ci_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly mobile_ci_repo_root="$(cd -- "${mobile_ci_script_dir}/.." && pwd)"

cd "${mobile_ci_repo_root}/mobile"

npm run typecheck
npm run lint
npm test -- --ci --runInBand
EXPO_NO_TELEMETRY=1 npx expo export --platform ios
