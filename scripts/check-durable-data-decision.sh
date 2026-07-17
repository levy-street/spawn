#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'durable-data guard: %s\n' "$1" >&2
  exit 1
}

require_literal() {
  grep -Fq -- "$2" "$1" || fail "$1 lost literal: $2"
}

require_task_status() {
  awk -F '|' -v wanted="$2" -v expected="$3" '
    function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
    trim($2) == wanted { count++; actual = trim($3) }
    END { exit !(count == 1 && actual == expected) }
  ' "$1" || fail "$2 must have exactly one status: $3"
}

require_declaration() {
  awk -F '|' -v wanted="$2" -v expected="$3" '
    function clean(value) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); gsub(/`/, "", value); return value
    }
    clean($2) == wanted { count++; actual = clean($3) }
    END { exit !(count == 1 && actual == expected) }
  ' "$1" || fail "$2 must have exactly one declaration: $3"
}

check_tree() {
  local root="$1" adr tasks progress policy doc phrase
  adr="$root/docs/DURABLE_SENSITIVE_DATA.md"
  tasks="$root/docs/TRUST_PHASE2_TASKS.md"
  progress="$root/docs/TRUST_PHASE2_PROGRESS.md"
  policy="$root/docs/GUARD_POLICY.md"
  for doc in docs/DURABLE_SENSITIVE_DATA.md docs/GUARD_POLICY.md docs/DESIGN.md \
    docs/INTERFACE_MATRIX.md docs/TRUST.md docs/TRUST_PHASE2.md \
    docs/TRUST_PHASE2_PROGRESS.md docs/TRUST_PHASE2_TASKS.md proto/README.md \
    server/pyproject.toml server/uv.lock; do
    [[ -f "$root/$doc" ]] || fail "missing required file: $doc"
  done
  [[ ! -e "$root/scripts/check_durable_data_decision.py" ]] || fail "Python prose guard is forbidden"
  [[ ! -e "$root/docs/DURABLE_DATA_PROSE_INVENTORY.jsonl" ]] || fail "generated prose inventory is forbidden"

  require_task_status "$tasks" P2-DATA-01 "ACTIVE — BOUNDED DESIGN, REVIEW PENDING"
  require_task_status "$tasks" P2-DATA-02 BLOCKED
  require_task_status "$tasks" P3-IDENTITY-01A "ACTIVE — PARALLEL FOUNDATION"
  require_task_status "$tasks" P3-IDENTITY-01B "ACTIVE — PARALLEL FOUNDATION"
  require_task_status "$tasks" P3-IDENTITY-02 PLANNED
  require_declaration "$adr" data01_runtime design_only_not_implemented
  require_declaration "$adr" p2_data_01_status proposed_independent_review_pending
  require_declaration "$adr" phase2_completion incomplete
  require_declaration "$adr" phase2_canonical_store endpoint_local_per_host
  require_declaration "$adr" phase2_opaque_server_blob_fallback forbidden
  require_declaration "$adr" guard_policy literal_machine_surfaces_only
  require_declaration "$adr" english_semantic_guarding forbidden

  require_literal "$adr" 'Status: **proposed for independent review; runtime not implemented**.'
  require_literal "$adr" 'Spawn will use an **endpoint-local canonical store per host**'
  require_literal "$adr" 'The server never receives a store root key, object data key, recovery'
  require_literal "$progress" '**P2-DATA-01 bounded design candidate (independent review pending):**'
  require_literal "$progress" '**Parallel Phase 3 foundations (active):**'
  require_literal "$policy" 'Source guards must not parse or classify English semantics.'
  require_literal "$policy" '`backup/p2-data-guard-interrupted-20260716`'
  require_literal "$policy" 'The permanent tmux-removal boundary is unchanged.'
  require_literal "$root/proto/README.md" 'does not advertise a runtime capability today.'
  for doc in docs/DESIGN.md docs/INTERFACE_MATRIX.md docs/TRUST.md \
    docs/TRUST_PHASE2.md docs/TRUST_PHASE2_PROGRESS.md docs/TRUST_PHASE2_TASKS.md proto/README.md; do
    require_literal "$root/$doc" 'DURABLE_SENSITIVE_DATA.md'
  done

  for phrase in 'endpoint-owned or client-encrypted' \
    'If opaque endpoint-encrypted blobs are selected' \
    'retained only at endpoints or as opaque'; do
    ! grep -Fq -- "$phrase" "$root/docs/DESIGN.md" "$root/docs/INTERFACE_MATRIX.md" \
      "$root/docs/TRUST.md" "$root/docs/TRUST_PHASE2.md" || fail "forbidden ambiguous target: $phrase"
  done
  ! grep -Fq 'markdown-it-py' "$root/server/pyproject.toml" "$root/server/uv.lock" \
    || fail "Markdown parser dependency is forbidden for this guard"
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  files=(docs/DURABLE_SENSITIVE_DATA.md docs/GUARD_POLICY.md docs/DESIGN.md \
    docs/INTERFACE_MATRIX.md docs/TRUST.md docs/TRUST_PHASE2.md \
    docs/TRUST_PHASE2_PROGRESS.md docs/TRUST_PHASE2_TASKS.md proto/README.md \
    server/pyproject.toml server/uv.lock)
  (cd "$repo_root" && cp --parents "${files[@]}" "$tmp")
  check_tree "$tmp"
  sed -i 's/ACTIVE — BOUNDED DESIGN, REVIEW PENDING/DONE/' "$tmp/docs/TRUST_PHASE2_TASKS.md"
  if (check_tree "$tmp") >/dev/null 2>&1; then fail "self-test accepted a promoted DATA row"; fi
  cp "$repo_root/docs/TRUST_PHASE2_TASKS.md" "$tmp/docs/TRUST_PHASE2_TASKS.md"
  touch "$tmp/scripts.check_durable_data_decision.py"
  mkdir -p "$tmp/scripts"
  mv "$tmp/scripts.check_durable_data_decision.py" "$tmp/scripts/check_durable_data_decision.py"
  if (check_tree "$tmp") >/dev/null 2>&1; then fail "self-test accepted the Python prose guard"; fi
  rm "$tmp/scripts/check_durable_data_decision.py"
  printf '%s\n' 'endpoint-owned or client-encrypted' >>"$tmp/docs/TRUST.md"
  if (check_tree "$tmp") >/dev/null 2>&1; then fail "self-test accepted an ambiguous target"; fi
  printf '%s\n' 'durable protected-data decision guard self-test passed'
elif [[ $# -eq 0 ]]; then
  check_tree "$repo_root"
  printf '%s\n' 'durable protected-data decision guard passed'
else
  fail 'usage: check-durable-data-decision.sh [--self-test]'
fi
