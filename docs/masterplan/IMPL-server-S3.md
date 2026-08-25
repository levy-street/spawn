# IMPL — server S3

Implemented the complete S3 server stream: Phase C setup claims/pairing attention/install flags; Phase B signed-manifest serving, repair updates, and worker mismatch; Phase D session/daemon renewal, sign-out-everywhere, pin diagnostics/capacity, and row retention. No priority item was cut.

The setup claim remains routing-only. It binds only after the daemon proves host-key possession and does not approve, create, or transfer a host. The existing signed browser approval proof remains the authority boundary.

## Files

Runtime and schema:

- `server/alembic/versions/0064_setup_update_hygiene.py` (new; sole head after `0063`)
- `server/spawn_server/models.py`
- `server/spawn_server/schemas.py`
- `server/spawn_server/config.py`
- `server/spawn_server/main.py`
- `server/spawn_server/auth.py`
- `server/spawn_server/rate_limit.py`
- `server/spawn_server/release.py`
- `server/spawn_server/push.py`
- `server/spawn_server/trust_events.py`
- `server/spawn_server/routes/setup_claims.py` (new)
- `server/spawn_server/routes/device.py`
- `server/spawn_server/routes/install.py`
- `server/spawn_server/routes/hosts.py`
- `server/spawn_server/routes/auth.py`
- `server/spawn_server/routes/browser_devices.py`
- `server/spawn_server/routes/trust_bundle.py`
- `server/spawn_server/routes/push.py`
- `server/spawn_server/ws/daemon.py`
- `server/CLAUDE.md`

Tests:

- `server/tests/test_setup_claims.py` (new)
- `server/tests/test_device.py`
- `server/tests/test_install.py`
- `server/tests/test_release.py`
- `server/tests/test_hosts.py`
- `server/tests/test_ws_daemon.py`
- `server/tests/test_ws_alerts.py`
- `server/tests/test_auth.py`
- `server/tests/test_browser_devices.py`
- `server/tests/test_trust_bundle.py`
- `server/tests/test_push.py`

The protected `server/tests/test_deploy_prod_script.py` and `server/tests/test_verify_release_script.py` were not edited.

## Checklist and pinning tests

### 1. SetupClaim schema and migration — complete

- Added `SetupClaim`, indexed unique 43-character token, additive nullable `DeviceCode.setup_token`, all required lifecycle/diagnostic fields and constraints.
- `0064` also carries the additive S3 host/pin columns so old application code can tolerate the upgraded schema.
- Pinned by `test_setup_claim_mint_read_is_owner_scoped_and_expires`, `test_setup_claim_state_machine_follows_the_signed_ceremony`, and `alembic heads`.

### 2. Setup claim endpoints — complete

- `POST /api/setup/claims`: authenticated, strict `{}` body, 201, 10/min/account, 30-minute token, opportunistic >24-hour cleanup.
- `GET /api/setup/claims/{token}`: canonical unpadded-base64url boundary validation, owner-only indistinguishable 404, computed/persisted expiry.
- Tests: `test_setup_claim_mint_read_is_owner_scoped_and_expires`, `test_setup_claim_rate_limit_is_per_user`, `test_setup_claim_create_prunes_claims_older_than_twenty_four_hours`.

### 3. Claim binding, pairing events, and push — complete

- `DeviceStartRequest.setup_token` is strict/canonical and nullable; unknown/expired claims are ignored.
- The first possession-proved ceremony wins a transactional CAS to `ready`; possession retry is attended but does not republish or repush.
- Approved, denied, expired, key-conflict, pin-conflict, and pin-limit terminal paths resolve the claim after the corresponding durable transition.
- Added `DevicePossessionResponse.attended` with backward-compatible default false.
- Tests: `test_setup_claim_state_machine_follows_the_signed_ceremony`, `test_bound_setup_claim_fails_when_its_ceremony_expires`, `test_bound_setup_claim_observes_a_denied_terminal_ceremony`, `test_setup_token_attends_only_the_bound_live_claim_and_notifies_once`, `test_device_start_rejects_noncanonical_setup_token`, `test_alerts_ws_forwards_pair_requested_and_resolved`, `test_pairing_push_routes_to_the_claim_without_exposing_key_material`, `test_pairing_push_reaches_every_install_including_the_knocking_phone`.

### 4. install.sh flags — complete

- `--setup TOKEN` / `--setup=TOKEN` exports `SPAWN_SETUP_TOKEN` before every daemon invocation, including all `login --no-run` branches and final `possess`.
- Empty token is refused. `--new-account` reaches `possess --new-account`.
- POSIX `sh` preserved.
- Test: `test_installer_passes_setup_environment_and_new_account_flag`; help text is pinned by `test_install_script_is_shell_and_no_store`.

### 5. Phase C endpoint/frame/event coverage — complete

- Full signed ceremony is tested from claim mint through possession, review, signed approval, poll token issue, approved claim, host ID, and both trust events.
- Unknown-token, unattended, idempotent possession, resolved outcomes, and alert forwarding are separately pinned by the tests listed under items 2–3.

### 6. Manifest serving and release metadata — complete

- Added `SPAWN_PREBUILT_DIR` (default repository prebuilt directory) while preserving `release.MANIFEST_PATH` and historical `REPO_ROOT` unit-test seams.
- `/api/install/manifest.json` serves exact valid manifest bytes; `.sig` serves exact signature bytes independently. Both are no-store with specified 404 behavior.
- Manifest parser tolerates/validates `release_counter` and `signing_key_id`; `/api/release.daemon` exposes nullable counter and `signed`.
- Tests: `test_manifest_and_signature_are_served_byte_exact_with_no_store`, `test_release_tolerates_counter_and_key_id_and_reports_signature`, `test_prebuilt_dir_setting_selects_manifest_and_binary_root`.

### 7. Update hardening and worker repair — complete

- Manual update body is strict and accepts only boolean `allow_downgrade`; true appears only on that request's `daemon.update` frame.
- `health` is a validated failing update stage.
- Register validates/stores `worker_mismatch`; omission/false clears it. Host update output says `error: "worker_mismatch"` while set.
- A valid manifest triggers a repair update after `registered` even with auto-update disabled, `self_update` false, and the same tree. Manual same-tree repair returns 202.
- Tests: `test_host_update_endpoint_sends_and_persists_update`, `test_host_update_repairs_same_tree_worker_mismatch`, `test_worker_mismatch_register_repairs_same_tree_and_omission_clears_flag`, `test_update_result_failure_is_humanized_and_keeps_requested_tree` (including `health`).

### 8. Sliding session renewal — complete

- After epoch validation, an authenticated HTTP request using a token older than half `jwt_refresh_ttl_days` stages a new same-epoch session cookie.
- Implemented as a pure ASGI response-start hook. It does not create a child endpoint task, buffer streaming responses, or touch WebSockets; this preserves S2's task-sensitive transaction linearization.
- Added `POST /api/auth/session/renew` returning fresh `access_token` + ISO `expires_at` and the same cookie.
- Test: `test_session_cookie_slides_only_after_half_life_and_never_after_epoch_revoke` plus explicit renewal coverage in `test_explicit_session_renewal_and_sign_out_everywhere_keep_only_caller`.

### 9. Sign out everywhere — complete

- `POST /api/auth/sign-out-everywhere` atomically bumps epoch and returns/cookies a new caller token at the new epoch.
- Both distinct old tokens die; the returned caller token works.
- Test: `test_explicit_session_renewal_and_sign_out_everywhere_keep_only_caller`.

### 10. Daemon token rotation and auth rejection — complete

- `registered.access_token` is included when authenticated token expiry is under 30 days; normal fresh-token acks remain unchanged.
- Identifiable rejection stamps S2's `last_disconnect_reason = "auth_rejected"`; close 1008 reason is fixed `token_expired`, `token_revoked`, or `token_invalid`.
- Tests: `test_expired_daemon_token_is_identified_and_recorded`, `test_registered_rotates_daemon_token_with_under_thirty_days_left`, `test_daemon_ws_rejects_missing_and_non_daemon_tokens`.

### 11. Pin capacity, reclaim, and adoption diagnostics — complete

- Revoke transaction deletes that device's direct `HostBrowserPin` snapshots while keeping `RevokedBrowserKey` as the permanent deny authority.
- Both claim and endorsement cap checks use `live_browser_device_id_set`.
- Pins response includes live per-pin delivery state and `{used,max}` capacity; old-daemon NULL/NULL state remains optimistically delivered until a nack exists.
- Strict new frames accept canonical UUIDs and exact fields/reasons. Unknown IDs are ignored. Nack persists undelivered reason and publishes; ack clears it and stamps delivery.
- Tests: `test_revoking_a_pinned_device_pushes_to_affected_hosts`, `test_host_browser_pin_bound_rejects_the_thirty_third_without_partial_row`, `test_endorsement_capacity_counts_only_live_pins`, `test_pins_routes_serve_transitively_live_pins_only`, `test_pins_routes_match_the_daemon_computation`, `test_pins_route_reports_undelivered_adoption`, `test_pin_adoption_failure_is_validated_persisted_published_and_cleared`.

### 12. Row hygiene — complete

- Approval list/create delete resolved or expired request rows older than 30 days.
- Push registration deletes disabled rows older than 90 days.
- Tests: `test_device_approval_paths_prune_rows_older_than_thirty_days[create|list]`, `test_registration_prunes_push_devices_disabled_over_ninety_days`.

## Verification tails

### Static and migration

```text
$ .venv/bin/ruff check .
All checks passed!

$ .venv/bin/ruff format --check <30 S3 changed Python files>
30 files already formatted

$ .venv/bin/alembic heads
0064 (head)
```

Repository-wide format-check retains the pre-existing Ruff baseline and was not mechanically applied across unrelated/concurrently owned files:

```text
$ .venv/bin/ruff format --check . 2>&1 | tail -20
Would reformat: tests/test_deploy_script.py
Would reformat: tests/test_device_approvals.py
...
Would reformat: tests/test_workspaces.py
57 files would be reformatted, 134 files already formatted
```

### Prescribed focused suite

```text
.......................................................
.s............... [ 93%]
.....................                                                    [100%]
297 passed, 12 skipped, 345 warnings in 941.92s (0:15:41)
```

### Cache-disabled full suite

All server/product tests ran; 849 passed. Two explicitly protected scripts-worker tests failed because their fake `git` executable has not been taught the desktop calls newly made by the concurrently landed desktop verifier:

```text
FF................................ [ 83%]
........................................................................ [ 91%]
........................................................................ [ 99%]
.                                                                        [100%]
FAILED tests/test_verify_release_script.py::test_verify_release_accepts_throwaway_signed_manifest
FAILED tests/test_verify_release_script.py::test_verify_release_rejects_wrong_release_counter
2 failed, 849 passed, 14 skipped, 688 warnings in 1044.71s (0:17:24)
```

An immediate isolated rerun reproduced only those two out-of-scope failures. The test fixture's fake `git` handles `HEAD:daemon` and `HEAD:mobile`, but not the new `HEAD:desktop` / desktop config reads, so the verifier exits before checking the manifest counter. Per the stream's hard rule, neither `server/tests/test_verify_release_script.py` nor `scripts/verify-release.sh` was edited here.

## Undone / caveats

- No S3 item (1–12) is undone or cut.
- The exact whole-suite command is not green solely because of the two protected concurrent scripts/desktop test-fixture failures above. The scripts worker must update its owned fake-git fixture/arguments, after which the full suite should be rerun.
- Repository-wide `ruff format --check .` is the inherited baseline; all 30 S3-changed Python files are formatted and `ruff check .` is green.

## Notes for D3 / W4 / M4 / T

### Setup claim endpoints and attended handoff

- `POST /api/setup/claims`, auth, body `{}` → 201 `{token, expires_in:1800, expires_at}`.
- `GET /api/setup/claims/{token}`, auth owner-only → `{status, approval_ref, host_name, os, host_key_fingerprint, host_id, error, expires_at}`.
- `POST /api/auth/device/start` accepts optional canonical `setup_token`.
- `POST /api/auth/device/possession` adds `attended: bool`; old daemons can ignore it.
- Claim token is never in an event, push, approval proof, or host token. It grants no authority.

### Trust events on `/ws/alerts`

- Frame type remains `"trust"` and includes server `at` timestamp.
- `host.pair_requested`: `{event, approval_ref, host_name, os, host_key_fingerprint}`.
- `host.pair_resolved`: `{event, approval_ref, outcome, host_id}` where outcome is `approved|denied|expired|key_conflict|pin_conflict|pin_limit`.
- `host.pin_undelivered`: `{event, host_id, browser_device_id, reason}` where reason is `pin_limit|invalid_chain|other`.

Pairing push is exact: title `SPAWN D`, body `<host_name> is ready to join your account`, data `{event:"host.pair_requested", approvalRef}`. Unlike a device-approval knock, it goes to every registered phone.

### Daemon registration and update frames

- Register accepts optional strict `worker_mismatch: bool`. Omit/false after repair to clear it.
- `registered.access_token` is optional. When present, atomically replace the stored daemon token; old daemons may ignore it and continue until their existing token expires.
- `daemon.update.allow_downgrade` is absent normally and exactly `true` only for an operator manual request that supplied it. Auto-update/repair never sets it.
- `daemon.update_result.stage` accepts `health` failure.
- Daemon → server nack: `host.pin_adopt_failed {browser_device_id, reason:"pin_limit"|"invalid_chain"|"other"}`.
- Daemon → server ack: `host.pin_adopted {browser_device_id}`.
- Both adoption frames require exact fields and canonical UUID; unknown browser IDs are ignored.

### Host/pin/update HTTP shapes

- `POST /api/hosts/{id}/update` optional strict body `{allow_downgrade:true}`. Same-tree worker repair is 202 rather than current/no-op.
- `HostOut.update.error` is `worker_mismatch` while registered mismatch is set.
- `GET /api/trust/hosts/{id}/pins` now returns:
  `{"pins":[{"browser_device_id", "delivered", "undelivered_reason"}], "capacity":{"used", "max":32}}`.

### Manifest serving / T

- Setting: `SPAWN_PREBUILT_DIR`; contains `manifest.json`, `manifest.json.sig`, and target binary directories. Default is `<repo>/daemon/target/prebuilt`.
- Exact public fetches: `GET /api/install/manifest.json` and `GET /api/install/manifest.json.sig`, both no-store.
- `/api/release.daemon` adds `release_counter` and `signed`.

### Session/cookie clients

- Default 30-day session begins sliding only after its 15-day half-life. Renewal happens only after user lookup and epoch validation.
- Automatic HTTP renewal returns `Set-Cookie: spawn_session=<fresh>` with the same attributes login uses: 30-day Max-Age, HttpOnly, SameSite=Lax, Path=/, and Secure when `public_url` is HTTPS.
- `POST /api/auth/session/renew` returns `{access_token, expires_at}` and sets the same cookie. Mobile must replace its stored bearer with `access_token`; web may use the cookie.
- `POST /api/auth/sign-out-everywhere` returns `{access_token}` and the cookie after bumping epoch. The caller must store the returned token; every old token, including the request token, is immediately invalid.

### Installer / Phase E passthrough

- `--setup TOKEN` exports `SPAWN_SETUP_TOKEN` for `login --no-run` and `possess`.
- `--new-account` invokes `possess --new-account`.

