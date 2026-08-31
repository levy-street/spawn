# IMPL — server S4

## Files

- `server/spawn_server/config.py`
- `server/spawn_server/release.py`
- `server/spawn_server/schemas.py`
- `server/tests/test_release.py`
- `server/tests/test_auth_providers.py`

## 1. Desktop release identity

`GET /api/release` now includes nullable `desktop` metadata with the exact
version, tree, and two Darwin platforms. Checkout-derived metadata is exposed
only when `desktop` is clean, `HEAD:desktop` is a valid 40-character tree, and
`desktop/src-tauri/tauri.conf.json` supplies a readable non-empty version.
`SPAWN_DESKTOP_VERSION` and `SPAWN_DESKTOP_TREE` provide the same explicit
deployment override seam as the existing release identity settings.

Tests:

- `test_release_endpoint_is_public_no_store_and_exact_shape`
- `test_release_includes_desktop_identity_when_checkout_is_clean`
- `test_release_hides_desktop_identity_when_checkout_is_dirty`
- `test_release_hides_desktop_identity_when_directory_or_config_is_unavailable[directory-missing]`
- `test_release_hides_desktop_identity_when_directory_or_config_is_unavailable[config-missing]`
- `test_release_hides_desktop_identity_when_directory_or_config_is_unavailable[malformed]`
- `test_dirty_checkout_marks_server_dirty_and_hides_mobile_tree`

## 2. Native OAuth redirect allow-list

The default exact-match allow-list now contains both the existing mobile URI
`spawn://auth/oauth` and desktop URI `spawn://oauth/callback`. A configured
`SPAWN_OAUTH_NATIVE_REDIRECT_URIS` value still replaces the default list.

Tests:

- `test_native_redirect_default_accepts_mobile_and_desktop_but_rejects_unknown`
- `test_native_redirect_environment_override_replaces_defaults`

## Verification tails

```text
$ cd server && .venv/bin/ruff check .
All checks passed!

$ .venv/bin/alembic heads
0064 (head)

$ .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_release.py tests/test_auth_providers.py tests/test_oauth_invite_gate.py 2>&1 | tail -3

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
32 passed, 5 warnings in 1.67s
```

## Undone

Nothing in S4 is undone. No migration was needed. The full suite was not run,
as requested; only the prescribed focused modules were run. No `scripts/` or
`docs/` file was edited, and no process was started or stopped.
