#!/usr/bin/env bash
set -euo pipefail

# Each major folder documents its own layout in a CLAUDE.md, and the root
# CLAUDE.md maps the repository. People and agents decide where code goes from
# those files, so a directory the docs do not know about is a bug. This guard
# fails when a git-tracked directory under a documented root is not named in
# the CLAUDE.md that owns it — which makes "update the doc" part of the same
# commit as "change the tree".
#
# macOS ships bash 3.2: no mapfile, no associative arrays.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# doc|root pairs: every tracked directory directly under root must be named
# in doc. Add a pair when a new folder gets its own CLAUDE.md.
pairs="CLAUDE.md|.
web/CLAUDE.md|web/src
web/CLAUDE.md|web/src/app
web/CLAUDE.md|web/src/components
mobile/CLAUDE.md|mobile/src
mobile/CLAUDE.md|mobile/src/app
mobile/CLAUDE.md|mobile/src/components
mobile/CLAUDE.md|mobile/src/data
server/CLAUDE.md|server/spawn_server
daemon/CLAUDE.md|daemon/src"

subdirs_of() {
  # Tracked directories directly under $1, one per line, no recursion.
  local root="$1"
  if [[ "$root" == "." ]]; then
    git ls-files | sed -n 's|^\([^/][^/]*\)/.*|\1|p' | sort -u
  else
    git ls-files -- "$root" | sed -n "s|^$root/\([^/][^/]*\)/.*|\1|p" | sort -u
  fi
}

doc_mentions() {
  # Word-ish match: "app" must not ride along inside "apple", "terminal"
  # inside "terminal-ui", or "auth" inside "(auth)"; alnum, ., -, _ and
  # parens extend a word.
  local doc="$1" name="$2" escaped
  escaped="$(printf '%s' "$name" | sed 's/[][(){}.*+?^$\\|]/\\&/g')"
  grep -Eq "(^|[^[:alnum:]_.()-])${escaped}([^[:alnum:]_.()-]|$)" "$doc"
}

self_test() {
  local tmp
  tmp="$(mktemp)"
  printf 'dirs: app/ (auth)/ terminal-ui/ and .github too\n' > "$tmp"
  doc_mentions "$tmp" "app" || { echo "self-test: 'app' should match" >&2; exit 1; }
  doc_mentions "$tmp" "(auth)" || { echo "self-test: '(auth)' should match" >&2; exit 1; }
  doc_mentions "$tmp" "terminal-ui" || { echo "self-test: 'terminal-ui' should match" >&2; exit 1; }
  doc_mentions "$tmp" ".github" || { echo "self-test: '.github' should match" >&2; exit 1; }
  doc_mentions "$tmp" "terminal" && { echo "self-test: 'terminal' must not match inside 'terminal-ui'" >&2; exit 1; }
  doc_mentions "$tmp" "ui" && { echo "self-test: 'ui' must not match inside 'terminal-ui'" >&2; exit 1; }
  doc_mentions "$tmp" "auth" && { echo "self-test: 'auth' must not match inside '(auth)'" >&2; exit 1; }
  rm -f "$tmp"
  echo "check-claude-md: self-test ok"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

fail=0
while IFS='|' read -r doc root; do
  [[ -n "$doc" ]] || continue
  if [[ ! -f "$doc" ]]; then
    printf 'check-claude-md: %s is missing (documents %s)\n' "$doc" "$root" >&2
    fail=1
    continue
  fi
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if ! doc_mentions "$doc" "$name"; then
      printf 'check-claude-md: %s/%s is not mentioned in %s — update the doc in this commit\n' \
        "$root" "$name" "$doc" >&2
      fail=1
    fi
  done < <(subdirs_of "$root")
done <<EOF
$pairs
EOF

if [[ "$fail" != 0 ]]; then
  exit 1
fi
echo "check-claude-md: every tracked directory is documented"
