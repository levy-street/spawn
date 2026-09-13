#!/usr/bin/env bash
# Installed outside the checkout on the persistent Mac release account.
# Runner-provided GITHUB_* variables cannot be overridden by workflow env.
set -euo pipefail
# macOS ships Bash 3.2, whose errexit handling does not stop on a failed [[ ]].
# Every authorization decision must reject explicitly rather than rely on -e.
[[ "${GITHUB_REPOSITORY:-}" == levy-street/spawn ]] || exit 1
[[ "${GITHUB_REF:-}" == refs/heads/master ]] || exit 1
case "${GITHUB_EVENT_NAME:-}" in push|workflow_dispatch) ;; *) exit 1 ;; esac
case "${GITHUB_WORKFLOW_REF:-}" in
  levy-street/spawn/.github/workflows/prebuilt.yml@refs/heads/master|\
  levy-street/spawn/.github/workflows/desktop.yml@refs/heads/master) ;;
  *) echo 'Release runner refuses an unapproved workflow/ref before checkout.' >&2; exit 1 ;;
esac
