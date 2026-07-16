#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
validator="$repo_root/scripts/check_durable_data_decision.py"

case "${1:-}" in
  "")
    exec python3 "$validator" --root "$repo_root"
    ;;
  --self-test)
    exec python3 "$validator" --root "$repo_root" --self-test
    ;;
  *)
    printf 'usage: %s [--self-test]\n' "$0" >&2
    exit 2
    ;;
esac
