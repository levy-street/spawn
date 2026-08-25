# IMPL — daemon D3

Date: 2026-08-26 (Pacific/Auckland)

Scope: `daemon/**` only. No git-writing command was run. Final read-only HEAD observed during verification: `4c6e715d1d8c95a9e1b10d1c0335d5ae32d32c2a`; concurrent workstreams advanced HEAD while D3 ran.

## Files

Added: `src/release_key.rs`, `src/tui.rs`, `src/state.rs`, `src/status.rs`, `src/doctor.rs`, `src/lifecycle.rs`, `src/cli_help.golden`.

Changed: `Cargo.toml`, `Cargo.lock`, `build.rs`, `src/version.rs`, `src/update.rs`, `src/update_tests.rs`, `src/proto.rs`, `src/ws.rs`, `src/run.rs`, `src/creds.rs`, `src/login.rs`, `src/possess.rs`, `src/cli.rs`, `src/main.rs`, `src/service.rs`, `src/sessiond/emulator.rs`, `CLAUDE.md`.

`sessiond/emulator.rs` is the one explicitly allowed pre-existing clippy fix (`[b'(', ...]` to `b"()*+"`). `qrcode` with default features off is the only new crate; `anstream`/`anstyle` were already clap transitive dependencies.

## 1. Phase B — signed manifest, counter, health, worker pair

- [x] `build.rs` stamps `SPAWND_BUILD_COUNTER` from `git show -s --format=%ct HEAD`, empty outside git.
- [x] Three build-time test overrides plus `rerun-if-env-changed`: `SPAWND_DAEMON_TREE_OVERRIDE`, `SPAWND_BUILD_COUNTER_OVERRIDE`, `SPAWND_RELEASE_PUBLIC_KEYS_OVERRIDE`.
- [x] Production key list is exactly `RELEASE_SIGNING_PUBLIC_KEYS = &["8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0"]`; derived/matched key id is `e65c013f`; custody/rotation doc comment included.
- [x] Pushed and CLI updates fetch origin-pinned `/api/install/manifest.json` and `.sig`, each <=64 KiB with the five-minute updater client budget.
- [x] Ed25519 checks exact downloaded bytes before parse; tree and both target hashes must equal the request; older counter fails unless `allow_downgrade`.
- [x] Exact failures: `verify/manifest_missing`, `verify/manifest_unsigned`, `verify/manifest_bad_signature`, `verify/manifest_mismatch`, `precondition/downgrade`.
- [x] `SPAWND_ALLOW_UNSIGNED_UPDATE=1` skips signature/counter only, still matches the manifest, warns once, and is documented.
- [x] Optional `daemon.update.allow_downgrade`, default false.
- [x] D2 probation remains pair-atomic; register deletes marker/backups; revert reports `stage:"health"`.
- [x] Corrupt marker + complete `.prev` pair reverts even if current worker is missing; incomplete pair warns, deletes marker, and boots.
- [x] Worker mismatch now registers separately with update enabled/null blocker; same-tree update repairs it; new sessions get a clear refusal; existing workers are untouched.
- [x] D2 ordinary socket close still preserves peers. The cleanup-race test now targets hard credential/trust invalidation, and a sibling pins ordinary-close behavior.
- [x] Revoked-key diagnosis: deny-list was sticky and the key was never re-admitted. An explicit single `rtc.status failed` refusal is correct; the stale expectation was updated with a comment.

Named tests: `signed_manifest_accepts_exact_bytes_and_rejects_bad_missing_or_wrong_signatures`, `manifest_mismatch_counter_guard_downgrade_and_escape_hatch_are_stable`, `corrupt_marker_recovery_requires_both_previous_binaries`, `worker_mismatch_bypasses_only_same_tree_idempotence`, `probation_state_machine_continues_once_then_reverts_or_reports`, `health_revert_restores_both_fake_binaries`, `reverted_probation_reports_a_stable_health_failure`, `post_register_cleanup_removes_only_the_installed_pair_backups`, `worker_pair_check_requires_the_exact_shared_tree_stamp`, `credential_failure_slow_cleanup_cannot_revive_late_cancelled_loader_reply`, `ordinary_socket_close_keeps_peer_trust_and_skips_cleanup_gate`, `a_revoked_key_stays_denied_when_a_later_frame_omits_it`.

## 2. Phase C — attended hand-off

- [x] `possess`/`login`: `--setup-token <TOKEN>` and `SPAWN_SETUP_TOKEN`; help hides values.
- [x] Optional `setup_token` on `device/start`; optional/default-false `attended` on possession response.
- [x] Old server/unattended opens immediately.
- [x] Attended prints all fallback material without opening. At 25 seconds it polls and opens only if that result remains `authorization_pending`; approval/denial prevents the fallback.
- [x] Pure decision plus fake two-request HTTP server coverage.

Named tests: `attended_handoff_delays_the_browser_and_legacy_opens_immediately`, `fake_server_observes_setup_token_and_marks_the_handoff_attended`, `device_possession_response_rejects_mixed_authority_and_unknown_fields`, `device_start_response_accepts_only_its_exact_schema`.

## 3. Phase C Tier 2/3 — CLI/TUI

- [x] `anstream`/`anstyle`, `IsTerminal`, NO_COLOR/plain mode, 80 ms braille stderr spinner with elapsed finalization, steps, <=12-line Unicode/ASCII logo, 60-column suppression.
- [x] Logo only on possess and non-JSON doctor in daemon; login wait, doctor, and update use spinner presentation; possess uses `[n/N]` steps.
- [x] Plain formatter byte tests for possess resume, status, login link, update outcomes; help file-goldened for every command.
- [x] Atomic exact-shape `state.json` every 30 seconds and on connection/session transitions.
- [x] 401/403 and token 1008 become heartbeat `auth`; arbitrary close text is discarded.
- [x] SIGHUP interrupts active socket/backoff, resets attempts, preserves workers/peers.
- [x] Extended status layout, required degradations, connection duration, service/session/version/key/pins, `--json`, all account instances.
- [x] Doctor: 14 ordered checks, exact remedies, warn/fail/skip and exit semantics, stable JSON, measured Date skew, worker/release/permissions, real 2 s STUN Binding request.
- [x] `reconnect`, `disconnect`, identity-preserving `logout`, `--wipe-identity`, and local-only `reset`; reset confirms, counts and TERM/KILLs workers, clears file+keyring state, never contacts server.
- [x] Exorcise confirmation/`--yes`; non-TTY teardown requires `--yes`.
- [x] Exact possess auth note and Ctrl-C line.
- [x] Error catalogue for DNS/TCP/TLS/wrong server/proxy/expired/denied/key conflict/pin conflict/pin limit/service install/no linger/clock/UDP.
- [x] Waiting elapsed at 30 s, hint at 60 s, expiry minutes.
- [x] QR half-block render of full `#k=` URL; headless/opener-failure auto, `--qr`, `--no-qr`.
- [x] Exact grouped help, aliases, examples, per-command examples, doctor example, reset warning.
- [x] D2 `session_ice_policy:true` and conditional ICE-policy trap protection unchanged.

Named tests: `plain_step_text_is_the_pre_tui_text_with_only_the_required_prefix`, `both_logos_fit_the_contract`, `state_json_has_the_stable_contract_shape_and_writes_atomically`, `auth_heartbeat_has_the_exact_status_remedy`, `plain_status_format_is_stable`, `doctor_json_shape_is_stable`, `check_order_is_exact`, `http_date_and_clock_thresholds_are_stable`, `top_level_help_is_the_design_golden`, `every_command_help_matches_the_plain_golden`, `plain_login_link_block_is_byte_stable`, `plain_resume_line_is_byte_stable`, `plain_cli_outcomes_are_byte_stable`, `token_close_reasons_are_bounded_and_preserved_for_local_auth_health`.

## 4. Phase D — token rotation and pin delivery

- [x] Optional `registered.access_token` persists via credential CAS, preserving origin/Host ID/seed/pins, and is used on the next connect; omission is a no-op.
- [x] Exact 1008 `token_expired|token_revoked|token_invalid` -> heartbeat auth detail, rate-limited `token expired — run spawnd login`, 60 s capped retry.
- [x] Per-device adoption verdicts and exact ack/nack frames.
- [x] Existing/idempotent and newly adopted pins ack; bad chain/key/signature -> `invalid_chain`; 32 live pins -> `pin_limit`; store/internal -> `other`.
- [x] Adoption never drops pins; only server live-set pruning removes them; deny-list remains sticky.

Named tests: `registered_token_rotation_is_optional_for_old_servers`, `pin_adoption_ack_and_nack_use_the_contract_frames`, `a_proposal_without_an_endorsement_is_never_adopted`, `an_endorsement_from_a_pinned_browser_is_adoptable`, `browser_pin_capacity_fails_before_mutation`, live-set reconciliation tests, `token_close_reasons_are_bounded_and_preserved_for_local_auth_health`, `whole_record_reload_activates_add_revoke_and_atomic_rotation`.

## 5. Phase E — multi-account

- [x] `possess --new-account` always stages, with one or many existing instances.
- [x] Plain possess resumes one or declines implicit creation with many, printing the one-line `--new-account` hint.
- [x] Status enumerates every credential-bearing account directory without explicit config.
- [x] Hostname default unchanged.

Named tests: `new_account_forces_staging_and_plain_possess_never_adds_one_implicitly`, `account_dirs_lists_only_registered_subdirs`, `plain_status_format_is_stable`.

## Verification tails

All Cargo commands used `CARGO_HOME=/private/tmp/spawn-d3-cargo`. The unfiltered hanging test command was never run.

```text
cargo fmt
  exit 0, no output
cargo build --locked
  Finished `dev` profile [unoptimized + debuginfo] target(s) in 8.16s
cargo clippy --locked --bin spawnd -- -D warnings
  Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.45s
cargo test --locked --bin spawnd update::
  ok. 19 passed; 0 failed; 343 filtered out; 1.22s
cargo test --locked --bin spawnd tui::
  ok. 2 passed; 0 failed; 360 filtered out
cargo test --locked --bin spawnd doctor::
  ok. 3 passed; 0 failed; 359 filtered out
cargo test --locked --bin spawnd cli::
  ok. 2 passed; 0 failed; 360 filtered out
cargo test --locked --bin spawnd possess::
  ok. 5 passed; 0 failed; 358 filtered out
cargo test --locked --bin spawnd login::
  ok. 19 passed; 0 failed; 343 filtered out; 0.04s
cargo test --locked --bin spawnd ws::
  ok. 13 passed; 0 failed; 349 filtered out; 0.09s
cargo test --locked --bin spawnd run::
  ok. 36 passed; 0 failed; 326 filtered out; 0.34s
cargo test --locked --bin spawnd creds::
  ok. 62 passed; 0 failed; 300 filtered out; 0.10s
Additional: status:: 2; state:: 2; proto:: 15; lifecycle:: 1; service:: 3 — all pass.
cargo build --locked --release
  Finished `release` profile [optimized] target(s) in 1m 05s
NO_COLOR=1 target/release/spawnd help | head -40
  exit 0; exact sections/order through Examples.
git diff --check -- daemon
  exit 0, no output
```

No reds remain; no pre-existing-red comparison is required. Both called-out run tests are green after the honest corrections above.

## Undone / limitations

- Doctor check 14 is now a real bounded STUN exchange, but the current daemon/server contract exposes configured ICE servers only inside session offers and the exact heartbeat has no ICE field. The standalone check therefore uses the server's current default `stun.l.google.com:19302`. When S3 exposes a credential-free configured probe target, `stun_binding_probe` should consume it. It remains warn-only.
- Destructive service-manager flows were not run against the developer's real launchd/systemd state; command generation/status primitives have focused tests.

No other requested daemon item was intentionally cut.

## Notes for S3 / T2 / W4 / M4

### Exact frames

```json
{"type":"register","self_update":true,"self_update_blocked":null,"worker_mismatch":true,"session_ice_policy":true}
{"type":"daemon.update","request_id":"...","version":"...","tree":"<40hex>","target":"darwin-aarch64","spawnd":{"path":"/api/install/spawnd/darwin-aarch64","sha256":"<64hex>"},"spawn_worker":{"path":"/api/install/spawn-worker/darwin-aarch64","sha256":"<64hex>"},"allow_downgrade":true}
{"type":"daemon.update_result","request_id":"...","ok":false,"tree":"...","version_before":"...","stage":"verify","error":"manifest_missing|manifest_unsigned|manifest_bad_signature|manifest_mismatch"}
{"type":"daemon.update_result","request_id":"...","ok":false,"tree":"...","version_before":"...","stage":"precondition","error":"downgrade"}
{"type":"daemon.update_result","request_id":"...","ok":false,"tree":"...","version_before":"...","stage":"health","error":"registration_failed"}
{"type":"registered","host_id":"<uuid>","access_token":"<fresh daemon token>"}
{"type":"host.pin_adopted","browser_device_id":"<uuid>"}
{"type":"host.pin_adopt_failed","browser_device_id":"<uuid>","reason":"pin_limit|invalid_chain|other"}
```

False `worker_mismatch` is omitted. Omitted `allow_downgrade` defaults false. Omitted `registered.access_token` does nothing.

Setup HTTP additions:

```json
{"host_name":"...","os":"...","arch":"...","version":"...","host_key_algorithm":"ed25519","host_public_key":"...","setup_token":"<opaque>"}
{"verified":true,"version":1,"attended":true}
```

Omitted `attended` defaults false.

### `doctor --json`

```json
{"host":"mac-studio","version":"0.1.0+g...","checks":[{"id":1,"name":"credentials","status":"ok","detail":"readable","fix":null}],"problems":0}
```

Exactly 14 checks. Status is `ok|warn|fail|skip`; problems counts only fail.

### `state.json`

```json
{"pid":12345,"version":"0.1.0+g...","connected":false,"connected_at":null,"server":"https://spawnd.dev/","last_error":{"kind":"auth","detail":"token_revoked","at":"2026-08-26T00:00:00Z"},"sessions":2}
```

`last_error` is null when clear. Kind is exactly `dns|tcp|tls|http|auth|protocol`.

### Environment overrides

- Build/test: `SPAWND_DAEMON_TREE_OVERRIDE`, `SPAWND_BUILD_COUNTER_OVERRIDE`, `SPAWND_RELEASE_PUBLIC_KEYS_OVERRIDE` (comma-separated base64url keys).
- Local runtime escape only: `SPAWND_ALLOW_UNSIGNED_UPDATE=1`.
- Setup routing: `SPAWN_SETUP_TOKEN` (same as `--setup-token`; help hides value).
- Presentation: `NO_COLOR` forces plain mode; non-TTY is always plain.

### Exact copy

```text
rejected by server (signed out) — fix with: spawnd login
spawn: note — the server is rejecting this machine's sign-in. Run: spawnd login
token expired — run spawnd login
spawn: stopped. Nothing was registered — run spawnd possess to start again.
spawn: already possessed for <account>; to connect another account run `spawnd possess --new-account`
spawn: This machine is clean. The old entry may still show under Hosts on the web — remove it there.
spawn: To set up again: spawnd possess.
```

User-facing error bodies (CLI prepends `spawn: ✗ `):

```text
Can't find <host>. Check the server address — spawnd status shows what this machine uses.
<server> didn't answer. Is the machine online? A firewall or VPN may be blocking it.
Secure connection to <server> failed. If this machine's clock is wrong, fix that first (spawnd doctor checks it).
<server> answered, but it isn't a SPAWN D server. Re-run the install command from the app — it carries the right address.
<server> is having trouble (HTTP 502). Try again in a minute.
The approval expired before anyone finished it. Run spawnd possess again for a fresh one.
The approval was declined in the browser. Nothing was registered.
The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh.
This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.
Couldn't install the background service (<detail>). The daemon still works in the foreground: spawnd run. To retry the service: spawnd reconnect.
```

Key conflict uses transcript 3's exact three-option body (`THAT`, `THIS`, `spawnd possess --config-dir <new dir>`).

Doctor/shared copy:

```text
this machine was signed out or removed — spawnd login to re-approve it
The daemon will start at login, not at boot. To fix: loginctl enable-linger $USER
enable automatic date & time — TLS and sign-in both break on a skewed clock
UDP to the relay looks blocked; terminals may not connect from outside this network.
```
