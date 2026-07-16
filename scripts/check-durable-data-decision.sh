#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

adr="docs/DURABLE_SENSITIVE_DATA.md"
if [[ ! -f "$adr" ]]; then
  printf '%s\n' "missing durable protected-data ADR: $adr" >&2
  exit 1
fi

required_headings=(
  "## Decision"
  "## Trust boundaries and authorization"
  "## Store and cryptographic envelope"
  "## Object, conflict, and replay semantics"
  "## Recovery, multi-device, backup, and import"
  "## Rotation, revocation, deletion, and purge"
  "## Migration and cutover contract for P2-DATA-02"
  "## Observability contract"
  "## Compatibility failure behavior"
  "## Falsifiable acceptance gates"
  "## Rejected alternatives"
  "## Dependency hand-off"
)

for heading in "${required_headings[@]}"; do
  if ! grep -Fqx "$heading" "$adr"; then
    printf 'durable protected-data ADR is missing required section: %s\n' "$heading" >&2
    exit 1
  fi
done

grep -Fq \
  'Spawn will use an **endpoint-local canonical store per host**' \
  "$adr"
grep -Fq \
  'Opaque client-encrypted server blobs are **not selected** for Phase 2.' \
  "$adr"
grep -Fq \
  'The server never receives a store root key' \
  "$adr"
grep -Fq \
  'Status: **proposed for independent review; runtime not implemented**.' \
  "$adr"

for doc in \
  docs/DESIGN.md \
  docs/INTERFACE_MATRIX.md \
  docs/TRUST.md \
  docs/TRUST_PHASE2.md \
  docs/TRUST_PHASE2_PROGRESS.md \
  docs/TRUST_PHASE2_TASKS.md \
  proto/README.md; do
  if ! grep -Fq 'DURABLE_SENSITIVE_DATA.md' "$doc"; then
    printf '%s does not reference the governing durable-data ADR\n' "$doc" >&2
    exit 1
  fi
done

ambiguous_target="$({
  rg -n \
    'endpoint-owned or client-encrypted|If opaque endpoint-encrypted blobs are selected|retained only at endpoints or as opaque' \
    docs/TRUST.md docs/TRUST_PHASE2.md docs/DESIGN.md docs/INTERFACE_MATRIX.md \
    || true
})"
if [[ -n "$ambiguous_target" ]]; then
  printf '%s\n' \
    'durable-data target became ambiguous; Phase 2 must keep the endpoint-local decision:' >&2
  printf '%s\n' "$ambiguous_target" >&2
  exit 1
fi

printf '%s\n' 'durable protected-data decision guard passed'
