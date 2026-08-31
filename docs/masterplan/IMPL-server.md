# Server implementation report

## 1. Files changed or added

- `server/CLAUDE.md`
- `server/alembic/versions/0062_host_daemon_update.py` (new)
- `server/spawn_server/config.py`
- `server/spawn_server/main.py`
- `server/spawn_server/models.py`
- `server/spawn_server/release.py` (new)
- `server/spawn_server/routes/hosts.py`
- `server/spawn_server/routes/install.py`
- `server/spawn_server/routes/release.py` (new)
- `server/spawn_server/schemas.py`
- `server/spawn_server/ws/broker.py`
- `server/spawn_server/ws/daemon.py`
- `server/tests/test_deploy_script.py`
- `server/tests/test_hosts.py`
- `server/tests/test_install.py`
- `server/tests/test_release.py` (new)
- `server/tests/test_ws_daemon.py`

`server/tests/test_deploy_script.py` was updated because it is server-owned and
the concurrently committed release stream made `/api/release` proof
unconditional. Its fake remote now serves the release proof and models the new
read-only manifest preflight/hard-gate wording. No release-script file was
edited by this stream.

## 2. Spec checklist

### Release identity and manifest

- [x] Added `spawn_server/release.py` with a module-level cached identity and
  `refresh()` for tests.
- [x] Server commit and mobile tree use guarded `git` subprocesses from the repo
  root with a 5-second timeout and return `None` on failure.
- [x] `SPAWN_RELEASE_COMMIT` and `SPAWN_MOBILE_TREE` configuration overrides win.
- [x] Dirty server checkout is exposed through `server.dirty`; dirty mobile
  checkout suppresses `mobile.tree`.
- [x] Web build ID is read from `web/.next/BUILD_ID`; mobile runtime version is
  read from `mobile/app.json`.
- [x] Added live manifest re-reading from
  `daemon/target/prebuilt/manifest.json`.
- [x] Manifest release fields, supported targets, and 40/64-hex values are
  validated.
- [x] Every listed target requires both binaries on disk with matching hashes.
- [x] Binary SHA-256 values are cached by `(path, mtime_ns, size)`.
- [x] Invalid/mismatched manifests are logged once per error and treated as
  absent.
- [x] Added public `GET /api/release`, registered it in `main.py`, and set
  `Cache-Control: no-store`.
- [x] Release response includes exact daemon/browser/alerts protocol strings and
  nullable identities/daemon as specified.

### Database and schemas

- [x] Added Host columns: `daemon_tree`, `self_update`,
  `self_update_blocked`, `update_state`, `update_tree`, `update_error`, and
  `update_requested_at`.
- [x] Added Alembic revision `0062_host_daemon_update.py` on top of `0061`.
- [x] Added `HostUpdateOut`, `HostUpdateResponse`, `HostOut.daemon_tree`, and
  `HostOut.update`.
- [x] Added all `ReleaseOut` child schemas and target checksum schema.
- [x] Added centralized `release.host_update_state(host)` and used it in the
  sole HostOut serialization helper used by list/get/patch.
- [x] Read-time states implement `unknown`, old-daemon `unsupported`, `current`,
  fresh `updating`, same-release `failed`, self-update `unsupported`, and
  `available`; dirty daemon identities do not advertise updates.
- [x] Failed state automatically becomes available at read time when the
  manifest tree advances.

### Daemon websocket contracts

- [x] Register validates `daemon_tree` as 40 lowercase-normalized hex with an
  optional `-dirty` suffix, `self_update` as a bool, and
  `self_update_blocked` as a string of at most 64 chars or `None`.
- [x] Invalid/omitted new register fields are treated as absent; old register
  frames still persist OS/arch/version and leave daemon identity null and
  self-update false.
- [x] New register fields are persisted inside `_prepare_host_activation`.
- [x] Re-register while updating clears all request state when the reported tree
  matches; otherwise it records `failed` with
  `restarted on the previous binary` while retaining `update_tree`.
- [x] Added `Broker.request_daemon_update(conn, payload)` with accepted-owner
  validation and a bounded send, returning bool.
- [x] Automatic update is evaluated immediately after the `registered` frame;
  the DB is marked updating before the frame is sent.
- [x] `SPAWN_DAEMON_AUTO_UPDATE=false` disables automatic pushes.
- [x] Same-manifest failed records are not auto-retried; a newer manifest is
  available again.
- [x] `daemon.update` payload exactly uses a UUID request ID, version/tree/target,
  relative `/api/install/...` paths, and manifest checksums.
- [x] `daemon.update_result` validates request ID, bool status, tree, and bounded
  stage/error fields.
- [x] `ok:false` records failed and humanizes `stage: error` without changing
  `update_tree`; `ok:true` stays updating until re-register reconciliation.

### Host update endpoint and installer

- [x] Added owner-authenticated `POST /api/hosts/{host_id}/update`.
- [x] Current returns 200 without sending; available/failed sends and returns
  202; offline, unsupported, unknown, and missing-target conditions return 409.
- [x] State is committed before send; bounded-send failure records a failed
  attempt and returns the required offline conflict.
- [x] Added an in-memory per-host 15-second request window with 429 response.
- [x] Installer checksum case arms use the validated manifest when present and
  fall back to live hashing when no valid manifest is available.

### Configuration, docs, and tests

- [x] Added `daemon_auto_update`, `release_commit`, and `mobile_tree` settings.
- [x] Updated `server/CLAUDE.md` for the release route and release concern.
- [x] Added release endpoint, identity, manifest/hash mismatch, dirty checkout,
  and no-manifest tests.
- [x] Added websocket tests for old/new/invalid register shapes, automatic send,
  disabled automatic send, failure/success results, and both reconciliation
  outcomes.
- [x] Added host endpoint tests for send/persistence, rate limiting, current
  no-op, and offline conflict.
- [x] Added manifest-driven installer pin coverage.
- [x] Updated the existing deploy-script fake to match the release stream's new
  `/api/release` proof so the complete server suite remains green.

## 3. Verification

Final verification:

```text
$ cd server && .venv/bin/ruff check .
All checks passed!

$ cd server && .venv/bin/python -m pytest -q tests/test_release.py tests/test_ws_daemon.py tests/test_hosts.py tests/test_install.py
81 passed, 93 warnings in 21.94s

$ cd server && .venv/bin/python -m pytest -q tests/test_deploy_script.py
16 passed in 36.41s

$ cd server && .venv/bin/python -m pytest -q
769 passed, 14 skipped, 607 warnings in 751.65s (0:12:31)

$ cd server && .venv/bin/alembic heads
0062 (head)

$ git diff --check -- server/CLAUDE.md server/alembic server/spawn_server server/tests
<no output; passed>
```

The warnings are existing short-test-JWT, Python SQLite datetime adapter, and
Alembic configuration deprecation warnings.

Failed/interrupted diagnostic run before the release stream stabilized:

```text
FAILED tests/test_deploy_script.py::test_deploy_runs_remote_build_and_restarts_services
FAILED tests/test_deploy_script.py::test_deploy_honors_no_build_custom_services_and_no_sudo
FAILED tests/test_deploy_script.py::test_deploy_handles_remote_path_with_spaces
FAILED tests/test_deploy_script.py::test_deploy_prebuilt_publish_skips_cleanly_without_a_release
FAILED tests/test_deploy_script.py::test_deploy_refuses_stale_prebuilt_before_touching_production
FAILED tests/test_deploy_script.py::test_deploy_flag_bakes_and_verifies_requested_target
FAILED tests/test_deploy_script.py::test_deploy_smoke_probes_healthz_through_the_web_proxy
FAILED tests/test_deploy_script.py::test_deploy_allows_non_master_branch_with_explicit_flag
8 failed, 758 passed, 14 skipped, 607 warnings in 946.10s (0:15:46)

Representative output:
E subprocess.TimeoutExpired: Command '[...]/scripts/deploy-prod.sh ...' timed out after 30 seconds
remote release proof: /api/release not ready (attempt 1)
remote release proof: /api/release not ready (attempt 2)
E AssertionError: daemon tree changes from <no production manifest> ... but prebuilts cannot be published
```

Cause: the release stream committed the unconditional `/api/release` proof and
hard prebuilt gate while the old server-owned fake still returned only a health
status code. During the first fixture rerun, another worker edited the deploy
script mid-process, producing a transient partial-script `fest: command not
found`. After the concurrent edit stabilized, the server-owned fixture was
updated and both the deploy test file and the exact full suite passed as shown
above.

## 4. Left undone

Nothing remains undone in the server stream. No deployment, release, or git
write operation was performed.

## 5. Notes for other streams

- Daemon target mapping accepts register OS `macos` or `darwin` and emits
  manifest target `darwin-*`; `linux` is unchanged. `arm64` normalizes to
  `aarch64`, and `amd64` normalizes to `x86_64`.
- The outbound field is exactly `spawn_worker`; the manifest checksum field is
  exactly `spawn_worker_sha256`; the binary path contains `spawn-worker`.
- Update paths are relative paths, never absolute URLs.
- Register daemon trees are stored lowercase. A `-dirty` daemon tree is accepted
  for identity reporting but produces read-time update state `unknown`, so dev
  builds are not prompted.
- `ok:true` update results intentionally do not mark current. The daemon must
  exec and re-register with `daemon_tree == update_tree`.
- Host APIs now always emit `daemon_tree` and an `update` object. Clients should
  tolerate `latest_version`, `error`, and `requested_at` being null.
- Manual update returns 202 for an already-updating host without resending; any
  second POST within 15 seconds returns 429.
- There are no unresolved wire-contract questions from this stream.
