#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
validator="$repo_root/scripts/check_durable_data_decision.py"
runner=(
  uv run --frozen --project "$repo_root/server" --group dev
  python "$validator" --root "$repo_root"
)

case "${1:-}" in
  "")
    exec "${runner[@]}"
    ;;
  --self-test)
    exec "${runner[@]}" --self-test
    ;;
  --write-inventory)
    exec "${runner[@]}" --write-inventory
    ;;
  *)
    printf 'usage: %s [--self-test|--write-inventory]\n' "$0" >&2
    exit 2
    ;;
esac
