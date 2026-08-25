# S2 — server connection reliability implementation

## Files changed

- `server/CLAUDE.md`
- `server/alembic/versions/0063_host_disconnect.py`
- `server/spawn_server/config.py`
- `server/spawn_server/host_status.py`
- `server/spawn_server/main.py`
- `server/spawn_server/models.py`
- `server/spawn_server/redis.py`
- `server/spawn_server/routes/hosts.py`
- `server/spawn_server/routes/profile.py`
- `server/spawn_server/schemas.py`
- `server/spawn_server/turn.py`
- `server/spawn_server/ws/alerts.py`
- `server/spawn_server/ws/broker.py`
- `server/spawn_server/ws/browser.py`
- `server/spawn_server/ws/close_codes.py`
- `server/spawn_server/ws/daemon.py`
- `server/spawn_server/ws/host.py`
- `server/spawn_server/ws/host_signal.py`
- `server/spawn_server/ws/reliability.py`
- `server/tests/test_config.py`
- `server/tests/test_hosts.py`
- `server/tests/test_legion.py`
- `server/tests/test_signed_signal_relay.py`
- `server/tests/test_turn.py`
- `server/tests/test_ws_alerts.py`
- `server/tests/test_ws_broker.py`
- `server/tests/test_ws_browser.py`
- `server/tests/test_ws_daemon.py`
- `server/tests/test_ws_host.py`

No file outside `server/**` was edited by S2.

## Item checklist

1. **Done — websocket session epoch enforcement.** `_resolve_user` now applies the same missing-as-zero epoch comparison as HTTP auth, covering `/ws/browser`, `/ws/host`, and `/ws/alerts`; stale epochs close 1008. Tests: `test_browser_ws_rejects_revoked_session_epoch`, `test_host_ws_protocol_epoch_keepalive_and_config_refresh`, `test_alerts_ws_rejects_revoked_epoch_and_reports_unknown_frame`. Daemon JWTs do not carry a session epoch (`issue_daemon_token` has host/user identity only), so `_resolve_daemon_host` was intentionally not given an epoch comparison.

2. **Done — browser/host keepalive.** Each accepted `/ws/browser` and `/ws/host` socket owns one cancellable 25-second task sending `{"type":"ping","ts":<unix-ms-int>}`; inbound `pong` is ignored. Alerts retain `alerts.ping`. Tests: `test_browser_ws_keepalive_config_refresh_request_and_errors`, `test_host_ws_protocol_epoch_keepalive_and_config_refresh`.

3. **Done — fresh RTC configuration.** Both sockets share their initial payload builder with periodic refresh at `min(turn_ttl_seconds / 2, 3600)` and synchronous `rtc.config.request` replies, rate-limited to one per five seconds per socket. Tests: the two reliability tests above and `test_session_rtc_config_carries_the_transport_policy`.

4. **Done — close-code partition.** Constants and their contract live in `ws/close_codes.py`. 4000 is restricted to a proven newer generation; ownership/CAS/DB/send consistency failures use 4004; subscription loss uses 4010 on browser, host, alerts, and daemon; task cancellation closes 1012. Tests: all four `*_closes_4010_when_subscription_is_not_ready` tests, `test_delayed_c_recovery_cannot_overwrite_successor_d`, `test_corrupt_cache_rejects_pending_owner_without_evicting_accepted_routes`, `test_broker_daemon_reconnect_supersedes_stale_connection_and_reassociates_sessions`, and the existing takeover/fencing race suite in `test_ws_daemon.py`.

5. **Done — orphan grace, rebind, resume, reconciliation.** Capability-enabled, non-superseded daemon loss and browser loss preserve exact binding identities for 60 seconds. Live tuples rebind; omitted tuples retire as unavailable; unknown daemon tuples get `rtc.close`; browser resume enforces user, PTY/host scope, nonce, original binding generation, protocol, and grace. Supersession and old daemons retain immediate retirement. Browser grace expiry publishes the exact `rtc.close` tuple. Tests: `test_rtc_orphan_rebind_expiry_resume_and_user_isolation`, `test_rtc_live_binding_reconcile_revokes_absent_and_closes_unknown`, `test_browser_rtc_resume_reassociates_orphan_and_unknown_is_unavailable`, `test_browser_orphan_grace_expiry_publishes_exact_rtc_close`, `test_zero_agent_host_signaling_is_bound_and_cleaned_up`, and `test_new_daemon_claim_actively_revokes_established_old_worker_session`.

6. **Done — ICE restart.** A live session- or host-scope binding accepts `ice_restart:true` only on its authenticated, exact route and reuses the nonce/generation/broker row while minting fresh ICE credentials. Unknown/stale/replayed tuples receive unavailable. Signed offers remain signed; the additive outer key is accepted without changing the signed inner envelope. Tests: `test_session_ice_restart_reuses_live_binding_and_unknown_is_unavailable`, `test_host_ice_restart_reuses_live_binding_and_unknown_is_unavailable`, `test_signed_restart_allows_additive_outer_ice_restart_flag`, and the signed relay/downgrade tests.

7. **Done — host negotiation and boundary errors.** `/ws/host` now performs accept → `protocol.required` → 4003. Every socket emits rate-limited `error` frames for unknown types or invalid shapes; pre-register daemon traffic is invalid. New daemon capability fields are type-checked, while malformed individual `live_bindings` entries follow the spec's log-and-ignore exception. Tests: `test_host_ws_protocol_epoch_keepalive_and_config_refresh`, `test_browser_ws_keepalive_config_refresh_request_and_errors`, `test_alerts_ws_rejects_revoked_epoch_and_reports_unknown_frame`, `test_daemon_pre_register_frame_gets_invalid_frame`, and `test_daemon_register_rejects_invalid_capability_shapes`.

8. **Done — derived host status and stale stamping.** `derived_host_status(host, now)` requires raw online plus a heartbeat no older than 90 seconds. Host list/get/patch and profile/fleet serialization use it; there are no host-status fields in the current session/workspace response schemas. Readers opportunistically stamp `last_disconnect_reason="stale"` without rewriting the raw status column. Tests: `test_derived_host_status_requires_a_fresh_online_heartbeat`, `test_stale_host_status_and_disconnect_shape_on_all_host_routes`, `test_profile_reports_the_fleet_and_sums_only_reported_specs`, and `test_host_list_reports_capacity_and_withholds_a_dead_hosts_meter`.

9. **Done — startup ICE validation.** Static and credentialed URL lists accept only the specified STUN/TURN hostname, IPv4, or bracketed-IPv6 forms and valid ports/transports. Startup raises clearly on malformed config, logs URL-only effective configuration/policy, and warns when any TURN configuration lacks a UDP-capable plain `turn:` URL. Tests: `test_ice_url_validator_accepts_supported_forms`, `test_ice_url_validator_rejects_malformed_forms`, `test_ice_config_validator_checks_static_and_turn_urls`, `test_ice_startup_summary_warns_without_udp_turn`.

10. **Done — relay hot-path ownership cache.** Durable ownership validation is lock-free and cached per `DaemonConn` for 10 seconds, heartbeat refreshes it, every failed/raising Redis ownership check invalidates it, and transient timeout/SQLAlchemy errors drop only the affected RTC relay frame. Tests: `test_durable_owner_cache_skips_db_and_transient_timeout_drops_one_frame` and the existing Redis ownership race tests.

11. **Done — bounded registration admission.** Registration ownership activation is guarded by an event-loop-local semaphore, default 32 and configurable through `daemon_registration_concurrency`; waiting sockets remain queued. Tests: `test_registration_admission_allows_forty_waiting_daemons`, `test_daemon_registration_concurrency_is_overridable_and_bounded`.

12. **Done — relay hygiene and host binding expiry.** Candidate maps are reduced to the four bounded allowlisted keys on all ingress paths. Daemon `rtc.status.message` is truncated to 256 characters before forwarding and any logging. Pending host RTC TTL is 120 seconds and expiry emits `rtc.status expired`. Tests: `test_rtc_candidate_allowlist_and_bounds`, `test_daemon_ws_routes_rtc_signaling_back_to_browser`, `test_daemon_host_answer_is_session_bound_and_status_detail_is_truncated`, `test_pending_host_rtc_binding_expires_with_status`.

13. **Done — pump readiness and presence reclaim.** Browser event and RTC subscriptions must both become ready within one second and remain alive. A missing Redis presence lease is eagerly rebuilt on both browser-session offers and host-control offers, but only after the durable DB tuple still matches the accepted local daemon. Tests: the four 4010 readiness tests, `test_local_accepted_daemon_eagerly_reclaims_lost_presence`, `test_session_ice_restart_reuses_live_binding_and_unknown_is_unavailable`, and `test_host_ice_restart_reuses_live_binding_and_unknown_is_unavailable`.

14. **Done — `session_ice_policy` capability.** The register key is parsed per `DaemonConn`. Session offers preserve the exact legacy field absence unless that connection advertised `true`; opted-in connections receive the policy computed by the same helper as host offers. Tests: `test_old_daemon_session_offers_never_carry_ice_transport_policy`, `test_session_ice_policy_capability_adds_policy_to_session_offer`.

15. **Done — session binding caps.** Live session bindings are limited to 64 per user and 16 per browser route. Rejection returns `rtc.status failed` and `RTC session limit reached.` Tests: `test_session_rtc_caps_are_per_user_and_browser`, `test_session_binding_user_cap_returns_failed_status`.

16. **Done — query-token deprecation.** Header credentials win; query credentials remain accepted on all shared/user and daemon resolvers and emit one process-wide warning. The helper docstring states removal waits until no supported mobile release predates header auth. Tests: `test_query_token_deprecation_warns_once_per_process`, `test_browser_ws_rejects_missing_wrong_kind_and_cross_user_sessions`, `test_daemon_ws_register_accepts_old_shape_and_heartbeat_query_token`.

17. **Done — local documentation.** `redis.py` now states that real Redis does not make the terminal path multi-worker and points to `docs/NETWORK.md`. `server/CLAUDE.md` names the added concern and websocket modules. Full suite and structural conventions remain intact.

18. **Done — disconnect diagnostics.** Nullable columns and Alembic 0063 add `last_disconnect_at`/`last_disconnect_reason`; `HostOut.last_disconnect` always has `{at, reason}`. Writers cover identifiable auth rejection, normal socket close, observed keepalive timeout, supersession, and stale derived presence. Tests: `test_daemon_ws_rejects_missing_and_non_daemon_tokens`, `test_daemon_ws_register_accepts_old_shape_and_heartbeat_query_token`, `test_daemon_keepalive_timeout_records_disconnect_reason`, `test_distributed_daemon_supersession_cannot_reclaim_presence_or_mark_host_offline`, and `test_stale_host_status_and_disconnect_shape_on_all_host_routes`.

## Verification

### Ruff

```text
$ .venv/bin/ruff check .
All checks passed!
```

Repository-wide format check (exit 1):

```text
$ .venv/bin/ruff format --check . 2>&1 | tail -12
Would reformat: tests/test_oauth_invite_gate.py
Would reformat: tests/test_push.py
Would reformat: tests/test_remote_reboot_smoke.py
Would reformat: tests/test_sessions.py
Would reformat: tests/test_signed_signal_relay.py
Would reformat: tests/test_trust_bundle.py
Would reformat: tests/test_update_mobile_script.py
Would reformat: tests/test_verify_release_script.py
Would reformat: tests/test_workspace_templates.py
Would reformat: tests/test_workspaces.py
Would reformat: tests/test_ws_alerts.py
74 files would be reformatted, 114 files already formatted
```

This is the repository's existing formatter baseline under the installed Ruff version; it includes untouched legacy migrations and modules. I did not mechanically rewrite 74 unrelated files. All five newly added Python files pass their direct format check:

```text
5 files already formatted
```

### Alembic

```text
$ .venv/bin/alembic heads
0063 (head)
```

### Focused websocket/host/ICE/config run

```text
........................................................................ [ 40%]
........................................................................ [ 80%]
....................................                                     [100%]
180 passed, 183 warnings in 13.22s
```

### Full server suite

```text
823 passed, 14 skipped, 644 warnings in 1023.54s (0:17:03)
```

The first full pass exposed two old `test_legion.py` fixtures that set raw online without a heartbeat. They were extended with a fresh `last_seen_at` (preserving their original live-host assertions); the final full run above is green and the separate stale-host tests remain green.

## Undone / caveats

- No scoped item was cut or left partial.
- The repository-wide Ruff format baseline remains non-green as recorded above. Fixing it would rewrite 74 unrelated files and overlap other workers; all new modules are formatted and `ruff check .` is green.
- Daemon JWTs have no session-epoch claim, so there is no meaningful daemon epoch check to apply.
- Bad JWTs whose signature/claims cannot be decoded cannot identify a host row for `auth_rejected`; decoded tokens with an identifiable existing host but rejected ownership do stamp it.

## Notes for D2 / W2 / M2 / tests

### Register additions (daemon → server)

- `keeps_peers_across_reconnect?: bool`
- `session_ice_policy?: bool`
- `live_bindings?: Array<{session_id, binding_nonce, binding_generation, scope_type, scope_id, protocol, protocol_version}>`, capped at 256. Invalid entries are logged and ignored. Valid tuples are exact; session topology is `session` / `spawn.pty` / `2`, host topology is `host` / `spawn.host.ctl` / `1`.

Capability absence preserves old behavior. In particular, **a session-scope offer sent to a daemon has no `ice_transport_policy` unless that exact `DaemonConn` registered `session_ice_policy:true`**. Host offers continue to include it.

### Browser/host inbound additions

- `{"type":"pong", ...}`: accepted and silently ignored.
- `{"type":"rtc.config.request"}`: synchronous `rtc.config` reply, at most one per five seconds per socket; extra keys make it `invalid_frame`.
- `rtc.resume` exact routing fields: `session_id`, `binding_nonce`, `binding_generation`, `scope_type`, `scope_id`, `protocol`, `protocol_version`.
- `rtc.offer` may add `ice_restart:true`; any other value is invalid. Restart must match a live binding and signed/unsigned mode exactly.

### Server outbound frames

- Browser/host keepalive: `{"type":"ping","ts":<unix-ms-int>}` every 25 seconds.
- `rtc.config` is resent with freshly minted credentials every `min(TURN TTL / 2, 3600)` seconds and on accepted requests.
- Boundary error: `{"type":"error","code":"unknown_frame"|"invalid_frame","frame_type":<string|null>}`, at most one per second per socket.
- Binding statuses always carry `session_id`, `binding_nonce`, original `binding_generation`, `scope_type`, `scope_id`, `protocol`, and `protocol_version`. New status values are `signalling_lost`, `rebound`, `resumed`, and `expired`; unavailable/failed remain terminal.
- Unknown or omitted daemon `live_bindings`, and browser orphan-grace expiry, produce exact-tuple `rtc.close` frames.
- Candidate payloads contain only `candidate` (string ≤1024), optional `sdpMid` (≤64), optional `sdpMLineIndex` (0..65535), and optional `usernameFragment` (≤256).
- Daemon `rtc.status.message` is at most 256 characters on the wire.

### Close codes

- `1008`: websocket authentication/authorization refusal, including stale user epoch.
- `1012`: server task cancellation/shutdown.
- `4000`: real supersession by a distinct newer daemon generation only.
- `4002`: retired content-bearing/binary control traffic.
- `4003`: required websocket subprotocol was not offered.
- `4004`: fencing/consistency failure (DB/Redis owner disagreement, CAS/pool/send timeout class).
- `4008`: observed keepalive timeout (also recorded as disconnect reason).
- `4010`: Redis subscription lost/not ready; reconnect and resubscribe.

### HTTP host shape

`HostOut` adds:

```json
"last_disconnect": {"at": "<ISO datetime or null>", "reason": "<string or null>"}
```

Serialized `status` is derived: raw online plus `last_seen_at >= now - 90 seconds`; the raw DB status column remains unchanged by stale reads.
