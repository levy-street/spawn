#!/usr/bin/env bash
# The fleet is called Hosts. Until the rename it was "Legion" on both
# frontends (a sidebar strip, a /legion page, a phone tab), and the root
# CLAUDE.md now says so next to the rule that the product is SPAWN D. This
# guard keeps the old name from drifting back into either frontend — in copy,
# in a route, in a file name, or in the code's own identifiers.
#
# "legion", in any case, may appear under web/src and mobile/src only as:
#
#   1. a `/legion` path — the old address kept as an alias: the web redirect
#      lives in next.config.ts (outside src), robots.ts still disallows it, and
#      mobile resolves it (and spawn://legion) to the Hosts tab;
#   2. mobile/src/app/(drawer)/legion.tsx — the Redirect stub that forwards
#      /legion to /hosts for one OTA cycle, file name and contents both;
#   3. `legion_days` — the server's profile rollup table, which keeps its name;
#   4. `spawn.sidebar.legionOpen` — the web storage key, kept so nobody's strip
#      forgets whether it was open;
#   5. tests (`__tests__/`, `*.test.*`, `*.spec.*`), which assert the aliases
#      and that the old name is gone, and put nothing on a screen.
#
# A route registered under the old name — `<Stack.Screen name="legion" />`, a
# route-map entry `"/legion": "legion"` — is not an alias but the old route
# coming back, and fails.
#
# Git lists and searches both trees, so a root git cannot read fails rather
# than passing on an empty listing.
#
# Server identifiers (legion.py, LegionDay, Legion*Out, migration 0055) are
# outside the scanned roots and deliberately unchanged.
#
# Deliberately a literal-source check, per docs/GUARD_POLICY.md: it looks for
# one word and a short list of literal markers, never at what a sentence means.
#
# macOS ships bash 3.2: no mapfile, no associative arrays.
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_root="${PRODUCT_VOCABULARY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

STUB='mobile/src/app/(drawer)/legion.tsx'
TEST_FILE_RE='(^|/)__tests__/|\.(test|spec)\.[cm]?[jt]sx?$'

allowed_file() {
  local path="$1"
  [[ "$path" == "$STUB" ]] && return 0
  [[ "$path" =~ $TEST_FILE_RE ]] && return 0
  return 1
}

# A line with every allowed marker removed. The trailing space gives a `/legion`
# at the very end of a line something to stop at, without relying on `$` inside
# a sed group (which BSD sed does not promise).
strip_allowed() {
  printf '%s \n' "$1" | sed -E \
    -e 's#/legion([^A-Za-z0-9_])#\1#g' \
    -e 's/legion_days//g' \
    -e 's/spawn\.sidebar\.legionOpen//g'
}

scan() {
  local fail=0 path hit rest line content files names hits status
  cd "$repo_root"

  # Everything below asks git. Outside a work tree (an exported copy, a broken
  # checkout) git lists nothing and finds nothing, and that silence must not
  # read as a clean tree.
  if [[ "$(git rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]]; then
    printf 'product-vocabulary: %s is not a git work tree; cannot check web/src and mobile/src\n' \
      "$repo_root" >&2
    return 1
  fi

  # File names, tracked or not yet added: a new legion-named file is caught
  # before its first commit.
  files="$(git ls-files --cached --others --exclude-standard -- web/src mobile/src)" || {
    printf 'product-vocabulary: git ls-files failed in %s\n' "$repo_root" >&2
    return 1
  }
  status=0
  names="$(printf '%s\n' "$files" | grep -i legion)" || status=$?
  if [[ "$status" -gt 1 ]]; then
    printf 'product-vocabulary: grep failed (exit %s) on the file list\n' "$status" >&2
    return 1
  fi
  while IFS= read -r path; do
    [[ -n "$path" && -e "$path" ]] || continue
    allowed_file "$path" && continue
    printf 'product-vocabulary: %s is named for the legion; name it for hosts (or the profile)\n' \
      "$path" >&2
    fail=1
  done <<<"$names"

  # Contents, tracked and untracked alike. git grep exits 1 for "no match";
  # anything above that is git failing, not a clean tree.
  status=0
  hits="$(git grep -n -i -I --untracked -e legion -- web/src mobile/src)" || status=$?
  if [[ "$status" -gt 1 ]]; then
    printf 'product-vocabulary: git grep failed (exit %s) in %s\n' "$status" "$repo_root" >&2
    return 1
  fi
  while IFS= read -r hit; do
    [[ -n "$hit" ]] || continue
    path="${hit%%:*}"
    rest="${hit#*:}"
    line="${rest%%:*}"
    content="${rest#*:}"
    allowed_file "$path" && continue
    if strip_allowed "$content" | grep -qi legion; then
      printf 'product-vocabulary: %s:%s: %s\n' "$path" "$line" "$(printf '%s' "$content" | sed -E 's/^[[:space:]]+//')" >&2
      fail=1
    fi
  done <<<"$hits"

  if [[ "$fail" != 0 ]]; then
    printf '%s\n' \
      "product-vocabulary: the fleet is called Hosts (root CLAUDE.md). \"legion\" survives in web/src and mobile/src only as the /legion alias, the server's legion_days table and the spawn.sidebar.legionOpen storage key." >&2
    return 1
  fi
  return 0
}

self_test() {
  local fixture outside output
  fixture="$(mktemp -d)"
  outside="$(mktemp -d)"
  trap 'rm -rf "$fixture" "$outside"' RETURN

  mkdir -p "$fixture/web/src/app" "$fixture/web/src/lib" "$fixture/web/src/components/hosts" \
    "$fixture/mobile/src/app/(drawer)" "$fixture/mobile/src/lib/__tests__" \
    "$fixture/mobile/src/components/nav"
  printf '%s\n' '          "/hosts",' '          "/legion",' >"$fixture/web/src/app/robots.ts"
  printf '%s\n' 'const OPEN_KEY = "spawn.sidebar.legionOpen";' \
    >"$fixture/web/src/components/hosts/hosts-strip.tsx"
  printf '%s\n' "/** A row of the server's \`legion_days\` rollup. */" >"$fixture/web/src/lib/api.ts"
  printf '%s\n' 'test("the strip no longer says Legion", () => {});' \
    >"$fixture/web/src/lib/fleet.test.ts"
  printf '%s\n' '  if (path === "/legion") return result("/hosts", "/hosts");' \
    'const legacy = "spawn://legion";' >"$fixture/mobile/src/lib/linking.ts"
  printf '%s\n' '            <Stack.Screen name="hosts" />' \
    >"$fixture/mobile/src/app/(drawer)/_layout.tsx"
  printf '%s\n' 'export default function LegionRedirect() {' '  return <Redirect href="/hosts" />;' '}' \
    >"$fixture/mobile/src/app/(drawer)/legion.tsx"
  printf '%s\n' 'expect(resolveIncomingLink("/legion")).toMatchObject({ route: "/hosts" }); // Legion' \
    >"$fixture/mobile/src/lib/__tests__/linking.test.ts"
  printf '%s\n' '  { href: "/hosts", icon: "Server", label: "Hosts", rootRoute: "hosts" },' \
    '  if (pathname === "/hosts" || pathname === "/legion") {' \
    >"$fixture/mobile/src/components/nav/bottom-nav.tsx"
  (cd "$fixture" && git init -q && git add -A)

  PRODUCT_VOCABULARY_ROOT="$fixture" "$script_path" >/dev/null 2>&1 ||
    fail "self-test: the allowed aliases did not pass"

  # Each case must fail on the line it added, not merely fail.
  expect_failure() {
    local label="$1" file="$2" text="$3" original
    original="$(cat "$fixture/$file")"
    printf '%s\n' "$text" >>"$fixture/$file"
    if output="$(PRODUCT_VOCABULARY_ROOT="$fixture" "$script_path" 2>&1)"; then
      fail "self-test: $label passed"
    fi
    [[ "$output" == *"$file:"* ]] || fail "self-test: $label failed without naming $file: $output"
    printf '%s\n' "$original" >"$fixture/$file"
  }

  expect_failure "web copy" web/src/components/hosts/hosts-strip.tsx \
    '<SidebarRowLabel collapsed={collapsed}>Legion</SidebarRowLabel>'
  expect_failure "a web identifier" web/src/lib/api.ts 'export function summarizeLegion() {}'
  expect_failure "mobile copy beside an allowed alias" mobile/src/components/nav/bottom-nav.tsx \
    '  { href: "/legion", label: "Legion" },'
  expect_failure "a lower-case word in a comment" mobile/src/lib/linking.ts \
    '// the legion lives here'
  expect_failure "a path that only starts like the alias" web/src/app/robots.ts \
    '          "/legionnaires",'
  expect_failure "a bare route name" \
    "mobile/src/app/(drawer)/_layout.tsx" '  const tab = "legion";'
  expect_failure "a re-registered legion screen" \
    "mobile/src/app/(drawer)/_layout.tsx" '            <Stack.Screen name="legion" />'
  expect_failure "a route-map entry for the old route" \
    "mobile/src/app/(drawer)/_layout.tsx" '  "/legion": "legion",'

  mkdir -p "$fixture/web/src/components/legion"
  printf '%s\n' 'export {};' >"$fixture/web/src/components/legion/strip.tsx"
  if output="$(PRODUCT_VOCABULARY_ROOT="$fixture" "$script_path" 2>&1)"; then
    fail "self-test: a legion-named file passed"
  fi
  [[ "$output" == *"web/src/components/legion/strip.tsx is named for the legion"* ]] ||
    fail "self-test: a legion-named file failed without naming it: $output"
  rm -rf "$fixture/web/src/components/legion"

  # A clean tree git cannot read is not a clean tree: the guard must say it
  # could not look. The ceiling stops git finding a repository above it.
  mkdir -p "$outside/root/web/src" "$outside/root/mobile/src"
  printf '%s\n' 'export {};' >"$outside/root/web/src/index.ts"
  if output="$(GIT_CEILING_DIRECTORIES="$outside" PRODUCT_VOCABULARY_ROOT="$outside/root" \
    "$script_path" 2>&1)"; then
    fail "self-test: a root outside any git work tree passed"
  fi
  [[ "$output" == *"is not a git work tree"* ]] ||
    fail "self-test: a root outside any git work tree failed for another reason: $output"

  PRODUCT_VOCABULARY_ROOT="$fixture" "$script_path" >/dev/null 2>&1 ||
    fail "self-test: the restored fixture did not pass"

  printf '%s\n' "product-vocabulary self-test passed"
}

fail() {
  printf 'product-vocabulary: %s\n' "$1" >&2
  exit 1
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

scan
printf '%s\n' "product-vocabulary: the fleet is Hosts in web/src and mobile/src"
