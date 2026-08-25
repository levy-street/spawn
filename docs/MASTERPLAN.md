# SPAWN D MASTERPLAN — the daemon experience, end to end

This is the working master document for making the SPAWN D daemon experience
clean, flawless, and impossible to regress: versioning and self-update across
every piece, connection speed and durability, the install/onboarding UX, the
CLI/TUI, device and session hygiene, the desktop companion app, and the test
programme that proves all of it. It was assembled on 2026-08-25 from a full
review of the codebase, four connection-layer reviews, a root-cause
investigation of the session-death bug, an industry research pass on update
systems, a device/session lifecycle audit, and three design studies. The raw
reports live beside this file in `docs/masterplan/` — every claim here has
file:line evidence in one of them.

## How to use this document

You are (probably) a fresh Claude Code session with full computer use, asked
to develop and test everything below, locally, end to end. Ground rules, which
override anything else you infer:

- **Branch**: all work happens on `native-daemon-fixes-auto-update-daemon`.
  Commit early and often, push the branch regularly. **Never** push to
  `master`, never merge into it, never open a PR against it yourself.
- **Never deploy**: do not run `scripts/deploy-prod.sh`, `scripts/
  update-mobile-prod.sh` against production, `eas build`/`eas update`, or any
  command that touches `spawnd-prod` in a writing way. Read-only ssh probes of
  prod (`ssh spawnd-prod`, journalctl, sqlite SELECTs) are allowed.
- **Read the repo's working agreements first**: root `CLAUDE.md`, then the
  `CLAUDE.md` of every folder you touch, then `docs/RELEASE.md`,
  `docs/NETWORK.md`, `docs/TRUST_UX.md`. They are law; this document tells you
  *what* to build, those tell you *how this repo builds things*.
- **Both frontends, same commit**: any user-facing change ships in `web/` and
  `mobile/` together (root CLAUDE.md). Product name in user-facing copy is
  exactly `SPAWN D`.
- **Verification is not optional**: every phase below names its checks. The
  repo-wide gate is `scripts/test-all.sh`; per-folder commands are in each
  CLAUDE.md. Real end-to-end tests (Phase T) are a deliverable of this plan,
  not an afterthought.
- **Machine quirks** (this Mac): the full daemon test suite HANGS in
  `upload::tests::concurrent_same_owner_start_prepares_once_and_resumes_the_inserted_entry`
  — never run `cargo test` unfiltered; run module filters. A handful of
  `rtc::tests::real_*`, `host_files`, and `pty` lifecycle tests fail
  pre-existing on macOS — compare against a pristine `git worktree` before
  blaming your change. Web unit tests need
  `npm_config_cache=/private/tmp/spawn-web-npm-cache npx --package=bun bunx bun test src`
  (no global bun; the home npm cache has root-owned files). Mobile full jest
  runs can flake random suites in a busy tree — re-run a failing untouched
  suite alone before treating it as real. Server suite ~12 min via
  `.venv/bin/python -m pytest -q`; keep `alembic heads` at exactly one head.

### The two traps that have already caused outages — never repeat them

1. **A session `rtc.offer` must NEVER carry `ice_transport_policy`** to a
   daemon that doesn't advertise the `session_ice_policy` capability.
   `daemon/src/run.rs` (~line 1598) uses the field's *absence* as the
   host-vs-session discriminator; sending it makes every deployed daemon
   silently drop every session offer. A guard test pins this. Any policy work
   rides a new register capability flag.
2. **Baked build values come from flags, not inherited env.**
   `SPAWN_API_PROXY_TARGET` and `EXPO_PUBLIC_API_URL` inherited from a dev
   shell have both shipped broken production builds (2026-08-24). The deploy
   and OTA scripts refuse inherited values; keep it that way in anything new.

---

# Part 1 — Where things stand (committed on the branch as of 2026-08-25)

Seven commits landed the release-identity + self-update system and its
infrastructure. Everything in this part is DONE, tested, and pushed; do not
rebuild it — build on it.

| Commit | What it delivered |
|---|---|
| `2db4b32` feat(web) | Web stale-tab detection (`NEXT_PUBLIC_SPAWN_BUILD_ID` vs `/api/release`), soft reload prompt with snooze / hard 4003 auto-reload, host update badges + `HostUpdateDialog` driving `POST /api/hosts/{id}/update`, 4003 handled terminally in all three sockets (`spawn:client-stale` CustomEvent). |
| `e9e8cad` feat(mobile) | Same surface on the phone: `extra.mobileTree` baked identity, release watcher (foreground + 15 min + 4003), OTA fetch + restart prompt, App-Store dialog when the native runtime is behind, host update dialog/badges word-for-word with web, `subscribeProtocolRequired` in the socket layer. |
| `ab39d12` feat(release) | CI publishes `TREE` + `VERSION` beside `COMMIT` in `prebuilt-latest`; deploy verifies the whole snapshot, hard-gates a daemon-tree change that can't ship verified prebuilts, publishes binaries + atomic `manifest.json`, proves `/api/release` afterwards, reminds about the OTA when `mobile/` changed; `scripts/verify-release.sh` (read-only, server commit + daemon tree + served hashes + phone manifest vs a git ref) is the last step of every release; shared helpers in `scripts/release-lib.sh`, pinned by `server/tests/test_deploy_prod_script.py`. |
| `9c23957` feat(daemon) | `spawnd` stamps `SPAWND_DAEMON_TREE` (git tree of `daemon/`, `-dirty` aware), registers with it + `self_update`/`self_update_blocked`, handles `daemon.update` (path-only URLs pinned to `/api/install/` on its own origin, sha256 + `--version` verification, atomic two-binary swap with `.prev`, flush-tracked result frame, exec-in-place keeping the PID, workers survive), `spawnd update` subcommand, protocol-refused (4003 / subprotocol) → HTTP self-update with 5-min backoff and hourly reinstall hint. Modules: `daemon/src/update.rs`, `update_io.rs`, `update_tests.rs`. |
| `ef17da8` feat(infra) | `infra/nginx-spawnd.conf.example` (real prod vhost + 300 s `/ws/` timeouts), `infra/coturn.conf.example`, `docs/NETWORK.md` (UDP `turn:` mandatory for daemons; `turns:443` options; daemon UDP port range + firewall; one-uvicorn-worker constraint), `scripts/connection-probe.py` (stdlib WS handshake + STUN binding probes) wired into `health-check.sh` and post-deploy. |
| `c48b8dd` feat(server) | Public `GET /api/release` (all identities; daemon section only from a fully hash-verified manifest), Host columns for `daemon_tree`/self-update state (alembic 0062), computed `HostOut.update` state machine (current/available/updating/failed/unsupported/unknown; dirty and dev identities never prompt), auto-`daemon.update` after `registered` (`SPAWN_DAEMON_AUTO_UPDATE=false` to disable), `POST /api/hosts/{id}/update` (200/202/409/429), `daemon.update_result` recording, re-register reconciliation, installer pins fed from the manifest. |
| (in flight) | Three connection-fix streams — web (`W2`), mobile (`M2`), daemon (`D2` incl. the ErrChunk fix) — were mid-implementation when this document was written. Their scope is Part 3; check `git log` for `feat(web): connection`, `feat(mobile): connection`, `feat(daemon): connection`-shaped commits and the reports `docs/masterplan/IMPL-web2.md`, `IMPL-mobile2.md`, `IMPL-daemon2.md` to see what landed. All three LANDED with nothing undone — see the updated 2.2 status; Phase B shrinks to verification plus the cross-stream Part 6 items (#2 signed manifest, #3 downgrade guard). |

### Phase log — the executing session (started 2026-08-25, this branch)

Kept current as phases land; the per-phase worker reports live in `docs/masterplan/IMPL-*.md`.

| Phase | Status | Evidence |
|---|---|---|
| 0 Orient | DONE 2026-08-25 | Baseline on the dirty tree before any new work: server `pytest -q` **769 passed / 14 skipped / 0 failed** (15 m 34 s); web bun **1076 pass / 0 fail**; mobile `npm run ci` green per `IMPL-mobile2.md` (227 suites / 1562 tests); `alembic heads` = `0062`; `bash -n scripts/*.sh` clean. Known macOS daemon reds unchanged (see the machine-quirks list above). Cross-folder contracts for the phases below were written before dispatch (setup claims / pairing push / host mini-doctor; signed manifest + counter + health stage; session renewal + pin capacity). |
| B (part) D2 daemon | DONE `b592326` | ErrChunk F1+F2 (webrtc 0.17.2 + vendored `webrtc-sctp` #822 re-admission patch), keep-peers-across-WS-loss, ICE restart, pacing + `pty_gap`, full jitter, probation health gate, worker-pair check. Report: `IMPL-daemon2.md`. Independent re-verification on this Mac: `ws::` 12/12, `update::` 14/14, `session_ctl::` 10/10, `proto::` 13/13, ICE-restart + pacing regressions green; `run::` 33/35 (one test still assumes `close_all()` on an ordinary close — re-targeted in D3; one pre-existing revoked-key expectation — diagnosed in D3); `worker_backend` SUN_LEN failure pre-existing on macOS. |
| B+C(Tier 2)+D+E D3 daemon | IN FLIGHT | signed manifest verify + pinned key list + counter guard + build-time overrides; attended hand-off; TUI kit, `state.json`, `status`/`doctor`/`reconnect`/`disconnect`/`logout`/`reset`, error catalogue, QR, help goldens; token rotation + pin adoption nack; `possess --new-account`. |
| A S2 server | IN FLIGHT | `server/` uncommitted: SPEC-connection S2 items 1–17 + stale presence + `Host.last_disconnect_*` (alembic 0063). Report: `IMPL-server-S2.md`. |
| C W3/M3 frontends | DONE (frontend half; server half rides S3) | Both frontends, one commit: setup-claim mint + four-step checklist + inline full-fingerprint approve card + 30/60 s never-strand hints; `/device` fragment stash across AuthGate/OAuth (web) and `spawn://device?ref=` + pairing-push handling (mobile); the shared error catalogue (`expired/denied/key_conflict/pin_conflict/pin_limit`); host "Something wrong?" mini-doctor panel; permanent "Add a machine"; mobile `spawnd login`→`possess` copy fix; multi-account hint. Reports `IMPL-web-C.md`, `IMPL-mobile-C.md`. Independent re-verification: web lint/tsc clean, bun 1098/0, Playwright `setup-claims.spec.ts` 6/6 (the worker's sandbox could not launch Chromium; run here it passes); mobile `npm run ci` 230 suites / 1593 tests green (one untouched nav suite flaked in the busy tree and passes alone). Frontends degrade to today's flow when the claims endpoint answers 404, so the branch is consistent until S3 lands the server half. |
| T1 scripts | DONE `3d7deda` | release-lib Ed25519 signing (seed on the operator Mac at `~/.config/spawn/release-signing.key`, pubkey `8nE_rD4e…` / id `e65c013f`), manifest `release_counter` + `signing_key_id`, deploy key gate + sig-last atomic publish + public-origin proof, verify-release signature/counter rows, RELEASE.md custody/rotation/loss/OTA-kill-switch/skew ritual, NETWORK.md horizon. Report `IMPL-scripts-T1.md`. |
| A S3 server | QUEUED (after S2) | claims API + pairing push + install `--setup`/`--new-account`; Phase B server half (manifest routes, counter, `allow_downgrade`, `health`, `worker_mismatch` repair push); Phase D server half (sliding session renewal, sign-out-everywhere, daemon token rotation, pin capacity reclaim + nack, row hygiene). |

### The release-identity model (as built — the mental model everything else rides on)

Every independently-shipped piece carries a **content identity**:

- **server** = deployed git commit; **web** = Next build id (deploy pins it to
  that commit); **daemon** = `git rev-parse HEAD:daemon` tree hash stamped
  into the binary; **mobile JS** = `git rev-parse HEAD:mobile` baked as
  `extra.mobileTree`; **mobile native** = `runtimeVersion` (appVersion policy,
  today).
- Production publishes all expected identities at public, uncacheable
  `GET /api/release`. Unknown/dirty identities are null and **never prompt** —
  dev stays quiet by construction.
- Behind ⇒ the piece updates itself: daemon downloads/verifies/swaps/execs;
  web tab prompts to reload (hard-reloads on a 4003 protocol refusal); phone
  fetches the OTA and prompts to restart, or points at the App Store when the
  native runtime is behind.
- The deploy refuses to create the situation where a daemon cannot follow:
  a daemon-tree change without publishable verified prebuilts aborts the
  deploy (override `SPAWN_DEPLOY_PREBUILTS=0` is loud and documented).
- `scripts/verify-release.sh <url>` proves, read-only, that a deployed server,
  its served binaries, and the phone manifest all match one git ref.

Key wire shapes (implemented; full detail in `docs/masterplan/SPEC-versioning.md`):
`register` gained `daemon_tree`, `self_update`, `self_update_blocked`;
server→daemon `daemon.update {request_id, version, tree, target, spawnd:{path,sha256}, spawn_worker:{path,sha256}}`;
daemon→server `daemon.update_result {request_id, ok, tree, version_before, stage, error}`
with stages `download|verify|swap|exec|precondition` (…`|health` once Part 3
adds probation); `HostOut.update {state, latest_version, error, requested_at}`.

---

# Part 2 — The connection layer: what four reviews found and the fix spec

Four parallel read-only reviews (daemon, web, mobile, server — full reports in
`docs/masterplan/REVIEW-*.md`) examined every socket, every PeerConnection,
and the signalling relay. Their findings converged on the same root causes
from four angles, and `docs/masterplan/SPEC-connection.md` is the binding fix
spec (cross-cutting protocol additions + per-owner numbered scopes W2 / M2 /
D2 / S2 / R2). Production facts verified on the box are in that spec's header
(single uvicorn worker; nginx 60 s read timeout on `/`; coturn UDP+TCP 3478
only, no `turns:`; uvicorn access log on).

## 2.1 The shared protocol additions (all additive, all feature-detected)

- **Keepalive**: server sends `{"type":"ping","ts":…}` every 25 s on
  `/ws/browser` and `/ws/host`; clients arm an 80 s watchdog only after the
  first ping (old servers never trip it) and close 4008 to reconnect.
- **Fresh ICE mid-socket**: server re-sends `rtc.config` every
  `min(turn_ttl/2, 1 h)` and answers `rtc.config.request` (rate 1/5 s);
  clients refresh before building/restarting a PC when the TURN credential
  (`username = "<unix-expiry>:<label>"`) is within 1 h of expiry.
- **Signalling loss ≠ data loss**: daemon registers with
  `keeps_peers_across_reconnect: true` + `live_bindings[]`; server orphans
  bindings for 60 s instead of revoking (daemon vanish AND browser detach),
  rebinds on re-register (`rtc.status rebound`), accepts `rtc.resume` from a
  new browser socket (`resumed`/`unavailable`); browsers keep a healthy PC
  across WS reconnects. Old peers keep today's immediate-revoke behaviour.
- **ICE restart on the same binding**: client sends `rtc.offer` with
  `ice_restart: true`, same signal id, same nonce/generation, freshly signed;
  server forwards with fresh ICE for a live binding; daemon applies to the
  existing PC when the signer matches and the ufrag differs (else collision).
  10 s to connected or fall back to a full rebuild.
- **Output shedding**: daemon drops backlog for slow viewers and emits
  `spawn.ctl` `{"type":"pty_gap","offset":N}`; clients recover via the
  history-gap path. No more killing sessions for slowness.
- **Close-code partition** (matches Discord-gateway practice):
  1000/1001/1006/1012/1013 → jittered reconnect · 1008 → signed-out state
  (invalidate `me`, real copy) · 4000 superseded → daemon reconnects, cap
  after two in 60 s · 4002 → client bug, stop · 4003 → the update flow ·
  4008 keepalive → reconnect · 4010 subscription-lost → reconnect now.

## 2.2 Status of the fix streams

- **W2 (web) — LANDED** (`feat(web): the browser survives bad networks…`):
  all 16 items including 16 KiB input chunking + backpressure (ErrChunk's
  client half), resume, ICE restart, watchdogs/wake, signed-out UX,
  reconnect banner with queued-keystroke count, endorsement caching, stable
  hook API, fake-WS/PC state-machine tests. Report:
  `docs/masterplan/IMPL-web2.md` (its "Notes for S2/D2/M2" pin the exact
  frame expectations — treat as contract).
- **M2 (mobile) — LANDED** (`feat(mobile): the phone survives bad networks…`),
  all 16 items, nothing undone: report `docs/masterplan/IMPL-mobile2.md`.
- **D2 (daemon incl. the ErrChunk fix and the research addendum: probation
  health gate, worker pair check, 16 KiB outbound, full jitter) — LANDED**
  (`feat(daemon): connections that survive the real world…`), all 12 items,
  nothing undone: report `docs/masterplan/IMPL-daemon2.md`.
- **R2 (infra) — LANDED** (`feat(infra)`).
- **S2 (server) — NOT STARTED. This is the largest remaining implementation
  block and your first coding phase (Phase A below).** Full scope =
  SPEC-connection "Server (server/) — owner S2" items 1–17 plus the
  Addendum's stale-presence items. Highlights, in priority order:
  1. `_resolve_user` on every WS enforces `session_epoch` (security hole:
     revoked sessions keep signalling today) — close 1008.
  2. Keepalive pings on `/ws/browser` + `/ws/host`; `rtc.config` refresh +
     request handler.
  3. Redis pump death closes sockets with 4010 (today: browser/alerts go
     deaf-but-open; daemon gets a misleading 4000 "superseded").
  4. Host status derived from `last_seen_at` (crash leaves "online" forever)
     + eager Redis presence reclaim — the "daemon says connected but the web
     disagrees" bug.
  5. Orphan-grace/rebind/`rtc.resume` + `live_bindings` reconcile; ICE
     restart acceptance (`ice_restart: true` on a live binding, fresh ICE,
     no new generation).
  6. `/ws/host` gets `protocol.required`+4003 like the other three; unknown
     frames get a rate-limited error frame instead of silence.
  7. ICE config validation at startup (a malformed TURN URL currently ships
     to every client and breaks `new RTCPeerConnection`); warn when TURN has
     no UDP `turn:` entry (daemons are UDP-only for relay).
  8. Per-frame `SELECT … FOR UPDATE` on the signalling hot path replaced
     with a 10 s cached ownership check; transient DB timeouts drop the
     frame, never fence the whole daemon socket.
  9. Registration admission semaphore (32) against reconnect storms;
     candidate/status field allowlists and size caps; binding TTL 60→120 s
     with `rtc.status expired`; per-user session-binding caps; deaf-socket
     guard (subscriptions ready in 1 s or close 4010).
  10. Session offers carry `ice_transport_policy` ONLY when the daemon
      registered `session_ice_policy: true` (see trap #1).
  W2's and M2's already-shipped clients feature-detect all of it, so S2 can
  land server-side with zero client coordination.

## 2.3 The ErrChunk verdict (sessions dying 3–39 s after connect)

`docs/masterplan/INVESTIGATE-errchunk.md` — read it before touching anything
SCTP. Verdict: `failed to handle_inbound: ErrChunk` = the daemon RECEIVED an
SCTP ABORT (code-proven: the only site returning that error); the browser's
stack aborts after its retransmits die against webrtc-sctp 0.17's
receiver-side zero-window/gap deadlock (upstream #822), on lossy high-RTT
relay paths, typically triggered by a large multi-fragment paste. 72% of
connected sessions in a 33 h field log died this way. Layered fix:
F1 `cargo update -p webrtc` → 0.17.2 (also fixes the #806 IPv6+TURN MTU
blackhole; zero API changes); F2 vendored `[patch.crates-io]` webrtc-sctp
with the one-branch buffer-full re-admission fix (port of `rtc` PR #201);
F3 client 16 KiB input chunking (web landed; mobile in M2). Plus two
instruments: log the selected candidate-pair types at Connected, and document
`RUST_LOG=webrtc_sctp=debug` + the "receive buffer full. dropping DATA"
line as the direct confirmation. Do NOT jump to webrtc 0.20/0.21 (sans-io
rewrite, regressed the MTU fix, still lacks #822). D2 owned F1/F2 — verify
its report/commit; anything missing is yours.

---

# Part 3 — The daemon experience: install, onboarding, CLI/TUI, health

Source: `docs/masterplan/DESIGN-daemon-ux.md` — a complete, implementable
design with current-state evidence, a permutation walkthrough of all seven
install/sign-up flows, exact command specs and help text, the TUI rules, four
mock transcripts, an 18-entry error catalogue with final copy, and a 19-item
cut-list. Implement it as written; this section is the orientation, not a
replacement. Companion: `docs/masterplan/DESIGN-multiaccount.md` §3 (QR,
pairing push, Add-a-machine) which it builds on.

## 3.1 The headline fix: the auth hand-off ("setup claims")

Today `spawnd possess` always opens a NEW browser tab for approval while the
onboarding tab that told the user to install sits blind — the ceremony is
account-less until approval, so no tab can discover it. The design gives the
ceremony a routing hint without moving any trust:

1. The onboarding/Add-a-machine page mints an authenticated **setup claim**
   (`POST /api/setup/claims` → token, 30 min) and embeds it in the install
   command: `curl -fsSL <origin>/install.sh | sh -s -- --setup <token>`.
2. install.sh passes it to `possess` → `device/start` carries `setup_token`.
   The moment the possession proof lands, the server resolves token→user,
   marks the claim `ready` (approval_ref, host name/os/fingerprint) and emits
   a `host.pair_requested` trust event.
3. The open tab (2 s claim poll; alerts event where mounted) morphs inline
   into the approve UI — the existing fingerprint-compare frame via
   `/api/auth/device/pending` (no `#k=` reached this tab, so fingerprint
   compare is the TRUST_UX-sanctioned check).
4. The daemon learns `attended: true` in the possession response and does NOT
   auto-open a browser (25 s fallback if unapproved). Unattended stays as
   today.
Security: the token grants nothing — it routes a notification and suppresses
one `open(1)`. Signed approval proof, possession-before-approval, and the
`#k=` path are untouched. This is NOT a pre-authorized device code (that was
evaluated and rejected — it would invert the ceremony ordering).

All seven permutations (same-machine, headless/SSH via QR, daemon-first,
phone-first via pairing push + deep link, second machine via permanent
Add-a-machine surfaces, reinstall/recovery incl. key_conflict copy, closed
terminal) are specified in the design — including the two found bugs: mobile
teaches `spawnd login` where everything else says `possess`
(install-instructions.tsx:110), and the `#k=` fragment likely does not
survive the /device AuthGate/OAuth redirect (stash in sessionStorage).

## 3.2 The CLI/TUI

Final command set (semantics in the design, §2.1, with exact help text):
`possess` (alias `setup`) · `exorcise` (alias `remove`, gains confirm) ·
`login` · `run` (gains SIGHUP=reconnect + a `state.json` heartbeat the other
commands read) · `status` (extended: connection/service/sessions/update/
instances, `--json`) · **`doctor`** (14 checks, each with a one-line fix,
`--json`, exit 1 on fail) · **`reconnect`** · **`disconnect`** ·
`logout` (CHANGED: keeps the host identity so re-login is one approval;
`--wipe-identity` for today's full wipe) · **`reset`** (local-only recovery
hammer, works when auth is broken) · `update` · rich grouped `help`.

TUI rules: zero new colour crates (clap already ships anstyle/anstream);
hand-rolled braille spinner on stderr, TTY-only; `qrcode` crate is the single
addition (QR carries the full approval URL INCLUDING `#k=` — out-of-band by
construction); ≤12-line summoning-circle logo, ember-red accent, `[n/4]`
steps; NO_COLOR/non-TTY output is byte-identical to today's plain lines;
waiting states show elapsed time at 30 s and a hint at 60 s. install.sh gets
the same treatment in pure POSIX (tty+NO_COLOR guarded), and the
source-build fallback finally announces itself and logs cargo output to a
file instead of minutes of silence.

The 18-entry error catalogue (§2.4) is the copy source of truth for CLI, web,
and mobile — `key_conflict`, `pin_conflict`, `pin_limit`, expired codes,
revoked-while-running, clock skew, UDP-blocked, service-install-denied all
get human words and exactly one next action. Revoked-while-running becomes
visible end to end via heartbeat `last_error.kind = "auth"` → status/doctor →
the host page.

## 3.3 Web/mobile helper surfaces

The onboarding waiting dot becomes a four-step checklist (command copied →
machine registered → approved → online) driven by the setup claim + hosts
poll, with the inline approve card at step 2. The host page gains a
"Something wrong?" panel (server additions: `Host.last_disconnect_at/reason`)
rendering a remote mini-doctor: never-connected / auth-rejected / stale
version / plain offline, each with the one command to run, copyable.
Deliberately NOT built: remote execution of doctor — the daemon is offline in
exactly the cases that matter.

Cut-list (design Part 3): Tier 1 = claims + passthrough + inline card +
mobile copy fix + fragment stash + pairing push; Tier 2 = TUI kit, heartbeat,
status/doctor/reconnect/disconnect/logout/reset, error catalogue, QR, help,
install.sh restyle; Tier 3 = last_disconnect columns, host-page panel,
Add-a-machine surfaces, small confirms. Dependencies and S/M/L sizes are in
the design.

---

# Part 4 — Device, pin, and session hygiene ("stale browser permissions")

Source: `docs/masterplan/AUDIT-lifecycle.md` — lifecycle map of every
artifact (roster, deny-list, host pins, endorsements, approval requests,
push devices, daemon pin store, web/mobile local stores, all three token
kinds), 11 findings, prod row counts, and a ready-to-lift feature spec (§D).
Invariants that bound ALL of this work: the deny-list is add-only and
permanent; revocation is never weakened or silently automated; pruning never
re-admits.

The four P1s (fix in this order):

1. **Sessions are one 30-day token with no refresh** — both frontends ride
   the 30-day `kind=access` cookie JWT (mobile stores the same value as its
   Bearer); the 15-minute access token is dead code; there is no refresh
   endpoint. Everyone gets hard-signed-out monthly — this IS the recurring
   "session expiry" complaint. Fix: sliding renewal past half-life on any
   authenticated request (epoch-checked, so revocation semantics are
   unchanged), plus Settings → "Sign out everywhere" (= epoch bump; today
   only password reset bumps it) in both frontends.
2. **The daemon's 365-day token has no renewal** and its expiry is
   indistinguishable from a network blip (silent infinite backoff; host
   "offline" forever). Fix: rotate over an authenticated register ack when
   <30 d remain, persisted through the existing credential-commit path; a
   distinct rate-limited "token expired — run `spawnd login`" log otherwise
   (feeds doctor check 5 and the host-page panel).
3. **Pin-capacity wedges silently**: the daemon's 32-pin cap makes
   endorsement adoption fail invisibly (approver saw success; new device can
   never connect). Fix: daemon nacks failed adoption over the WS; server
   marks the pin undelivered; approval UI stops claiming success; capacity
   `{used, max}` exposed on the pins API with warnings at ≥28 and real copy
   for `pin_limit` in BOTH frontends.
4. **Revoke does not reclaim capacity**: both server cap checks count dead
   pins; cycling browsers marches to 32 forever. Fix: delete the revoked
   device's `HostBrowserPin` rows in the revoke transaction (the deny-list —
   `RevokedBrowserKey` — is the tombstone mechanism, not the pin row), or
   count capacity against the live set.

P2/P3 hygiene (audit §D): stale-device surfacing (sort by `last_seen_at`,
badge >60 d, one-tap revoke; mobile gains last-seen parity — it shows none
today), per-account local-store wipe on web + mobile (preserving revocation
tombstones and the trust-revision floor; tombstones excluded from active-record
caps so they cannot starve capacity), opportunistic purges of resolved
approval requests (>30 d) and disabled push rows (>90 d), and honest copy on
"Clear history" (it clears the list, not the denial). Prod counts (8 users):
deny-list 18 already outnumbers 16 live devices; 2 devices stale >90 d —
growth is real, just early.

---

# Part 5 — Multiple accounts and effortless Nth hosts

Source: `docs/masterplan/DESIGN-multiaccount.md`. Verdict, with full evidence:
the machinery for "one machine, several accounts" already exists as
fully-isolated per-account daemon instances (`spawnd possess` derives a
per-account config dir; per-instance service names; separate keys, pins,
claims — the trust plane never mixes). What is missing is pure UX:

- `spawnd possess --new-account` (today `possess` silently resumes the one
  existing instance — there is no CLI path to add account B);
- `install.sh | sh -s -- --new-account` passthrough;
- `spawnd status` listing all instances (adopted into the Part 3 status spec);
- a "one machine, several accounts" docs section + one line of copy in both
  frontends' connect surfaces.

First-class shared hosts (`host_members`) would be the largest trust-plane
feature since the device mesh (per-account pin partitions, a cross-account
anchor ceremony, ~214 authorization sites) and is staged as a LATER,
flagged, read-only-grant first step — only if "two humans, one machine"
becomes a product goal. Option 3 (growing host introductions cross-account)
was evaluated and discarded — it collapses into the same hard part.

For "one account, many hosts", three papercuts (all preserving the ceremony,
all folded into Part 3's flows): the terminal QR (headless), the
possession-verified pairing push to phones, and permanent Add-a-machine
surfaces. Explicitly rejected: pre-authorized device codes.

Open product questions for Charlie are listed in that design's §6 (roles on
shared hosts, session visibility between members, the two-daemons footprint).

---

# Part 6 — Update-system hardening (research-driven)

Source: `docs/masterplan/RESEARCH-updates.md` — industry survey (Omaha/CUP,
Sparkle, Syncthing, Tailscale distsign + activity-aware rollout, Fleet/Kolide
TUF, Mender/RAUC A/B commit, Tauri/Electron, Vercel skew protection, Discord
close codes, k8s skew windows, Expo policies, WebRTC/TURN/backoff canon) with
a tagged gap list and sources. What it validated as already-right and what it
demands, in order:

**ADOPT-NOW (some may already be in D2's commit — verify, then build the rest):**

1. **Post-update health gate with automatic revert** — the single biggest
   hole in any self-updater and ours until built: at swap, write a probation
   marker (`spawnd.updating`: attempts, old tree, deadline) beside the
   binary; the new daemon must reach `Registered` within 5 min; marker found
   with attempts ≥2 (crash loop) or deadline passed → rename `.prev` back
   over BOTH binaries and exec the reverted daemon → report
   `update_result {ok:false, stage:"health"}` so the server marks that tree
   failed and never re-pushes it. `.prev` deletion moves from
   next-startup to next-successful-register. (Mender's commit pattern.)
2. **Sign the release manifest with one pinned Ed25519 key** — every serious
   updater refuses to trust its distribution server alone (Sparkle,
   Syncthing, Tailscale, Tauri, Omaha-CUP); today control-plane compromise
   owns the fleet. Minimal design: deploy-prod.sh signs the canonicalised
   manifest JSON on the Mac (key never on the server); the public key is a
   const in the daemon (ed25519 verify machinery already exists for signed
   signalling); daemon verifies before trusting any sha256; document key
   custody + loss plan (new key ships in an update signed by the old).
   Full TUF and Sigstore: evaluated, REJECTED for a private fleet.
3. **Downgrade monotonicity guard** — a strictly-increasing release counter
   (or commit timestamp) in the signed manifest; daemon refuses
   older-than-self unless the frame carries an operator-set
   `allow_downgrade`. (TUF rollback protection at 1% of its cost.)
4. **Worker/daemon pair cross-check at startup** — compare embedded stamps;
   mismatch = `worker_mismatch` state, refuse NEW sessions, report on
   register (closes the half-swap window; also doctor check 10).
5. **Full jitter** everywhere a backoff exists: `random(0, min(cap,
   base·2^n))` — the AWS canon; measurably better than the ±25/±30% forms
   under contention. W2 shipped 0.7–1.3 jitter; converge all three codebases
   on full jitter when touched.
6. **Daemon OUTBOUND ≤16 KiB data-channel messages** (audit the 48 KiB ctl
   replay chunks down; honour peer `max-message-size` when exposed) — the
   symmetric half of the input-chunking fix.
7. **docs/RELEASE.md gains the OTA kill switch**: `eas update:rollback` /
   `eas update:revert-update-rollout`, and the note that expo-updates
   auto-recovers a crashing update (emergency launch).
8. **Updater fault-injection tests** — Part 8's harness items 1–3.

**ADOPT-LATER (documented, not this branch):** Expo `runtimeVersion:
{policy:"fingerprint"}` (kills both appVersion failure modes INCLUDING our
false App-Store prompt after a no-native-change version bump — do it as its
own change with EAS fingerprint determinism work); `turns:` on TCP/443 for
browsers/phones (needs a second IP or SNI router; daemons stay UDP-only);
Tailscale-style staged rollout + busy-host deferral (matters from ~dozens of
hosts); a declared "server supports daemon protocol N-1" compatibility
window when deploy tempo grows (the k8s answer to every-deploy churn — the
wire protocol, not the tree hash, is what actually gates); an N-version
update library if `.prev` ever proves too thin; WebTransport/MASQUE as
horizon notes in docs/NETWORK.md.

---

# Part 7 — The desktop companion app

Source: `docs/masterplan/DESIGN-desktop-app.md` — read it in full before the
desktop phase; it contains the researched shell decision matrix, the complete
first-run script with final copy, the update pipeline, and the cut-list. The
essentials:

- **Shell: Tauri v2, tray-first** ("Electron" read as "installable desktop
  app"; §2.2 justifies in user-benefit terms — an independently *signed*
  update channel the trust model explicitly asks for (TRUST.md residual risk
  1), a ~6 MB instant-launch DMG, Rust end-to-end so the app links the
  daemon's own ceremony crates). The flip condition to Electron is written
  down (embedded terminal on Linux). No shell can host the web app's
  passkey-PRF flows, so auth bounces to the system browser / native forms
  regardless — mobile's token + OAuth-exchange flows are the proven pattern
  to copy.
- **What it is**: a menu-bar companion, not a second frontend. Tray = status
  line, sessions submenu, Open SPAWN D (browser), daemon version/update
  state, Repair…, Settings, Quit ("the daemon keeps running while SPAWN D is
  closed"). The app's own UI is bundled-local HTML only — never remote code
  (that is what makes it a packaged client in TRUST.md's sense).
- **Identity**: the app is a *device* (keychain token + device keypair,
  approved via the same number check, revocable like any browser); the
  daemon's credential stays the daemon's. Two credentials, never mixed.
- **First run**: sign in (native password / OAuth via system browser +
  exchange; SAS approval card for existing accounts) → server picker
  (spawnd.dev default; Advanced self-hosted URL — this implements the
  "locally or on our servers" ask as *choose your control plane*; hosted
  compute is an explicitly open product question) → **Possess this Mac**:
  the app downloads spawnd + spawn-worker from the CHOSEN server, verifies
  both sha256s against `/api/release`, installs to `~/.local/bin`, runs
  `spawnd possess` with a setup claim (Part 3.1) so no browser window ever
  opens, extracts the `#k=` key from the child's stable output (local pipe —
  out-of-band by construction) or falls back to the fingerprint frame, and
  approves in-app by signing the existing approval transcript with the
  daemon's own crate. **Never bundle the daemon** (drift + self-hosted
  breakage); never re-implement update/supervision — the daemon self-updates
  and the app renders `spawnd status --json` / `doctor --json` /
  `state.json`.
- **Updates**: two channels, cleanly split. The daemon follows its chosen
  server. The app follows a Tauri-updater static manifest at
  `spawnd.dev/desktop/latest.json`, minisign-verified against a public key
  baked into the app — the private key signs LOCALLY in the release flow,
  never in CI, never on the server. `/api/release` grows a display-only
  `desktop` block; `verify-release.sh` and `docs/RELEASE.md` grow piece
  five; root CLAUDE.md maps `desktop/` in the same commit that creates it.
- **Window mode**: MVP never embeds the remote web app (that would re-import
  the exact risk the packaged client exists to remove); "Open SPAWN D" goes
  to the real browser. The trust-model end state (web bundle shipped inside
  the app) is staged as its own L with an honest cost assessment.
- **Scope guards**: macOS first; Linux AppImage later; **Windows is gated on
  a daemon Windows build that does not exist — do not ship a viewer**. Mac
  App Store is out (sandbox can't install LaunchAgents).
- Build order: Stage 0 contracts (the Part 3 status/doctor `--json` +
  claims; an optional `possess --json-progress`; the OAuth redirect
  allow-list entry; the `desktop` release block) → Stage 1 MVP → Stage 2
  comfort (knock prompt in the tray, sessions submenu) → Stage 3 trust-model
  end state. Open product questions in the design's §9 (notably: hosted
  compute, Electron-by-name, self-hoster app-update channel, Dock icon).

---

# Part 8 — The test programme (real tests, not vibes)

Source: RESEARCH-updates §C, the SPEC verification sections, and the repo's
existing harness (`scripts/test-all.sh`, smoke-*). Everything below runs
locally on this Mac; items marked (CI) belong in `test-all.sh` gating. Build
these as real, committed scripts/tests — they are how "never screws up again"
becomes enforceable rather than aspirational.

1. **(CI) `scripts/test-update-e2e.sh` — the updater end to end.** Two builds
   of HEAD with different `SPAWND_DAEMON_TREE` env stamps ("v-old"/"v-new"),
   a local server with a manifest pointing at v-new. Assert: register shows
   old tree → auto `daemon.update` → download/verify/swap/exec → same PID →
   re-register with the new tree within the deadline → `.prev` gone after
   register → `update_state` cleared. **Session survival**: a PTY session
   opened before the update still flows bytes after re-register with no
   client reconnect. Idempotence: same-tree update is a no-op. Manual
   `POST /api/hosts/{id}/update` path. 429 window. Unsupported/blocked
   preconditions.
2. **(CI) Stage-by-stage fault injection.** toxiproxy in front of the server
   port: hang (`timeout` toxic) → stage `download`; truncate (`limit_data`) →
   `verify`; trickle (`bandwidth rate=16`); mitmproxy flipping one body byte
   → `verify` (and, once Part 6 #2 lands, a bad signature); read-only install
   dir → `unwritable`; a fake binary whose `--version` fails/lies/hangs →
   `verify` with the old binary intact.
3. **(CI once the health gate exists) Bad-binary probation.** A binary that
   passes `--version` but exits 1 on real startup: swap happens, probation
   marker found, revert to `.prev`, old daemon registers, server shows
   `failed stage:health`, no re-push of that tree.
4. **Version-skew matrix (pre-release ritual, scripted).** Build "old" from
   the last deployed commit in a `git worktree`; run the four cells
   {old,new daemon}×{old,new server} through register + PTY smoke; assert the
   old-daemon×new-server cell auto-updates and the new-daemon×old-server cell
   does NOT loop or downgrade. Same two cells for a web tab (old bundle vs
   new server: the 4003 path shows the hard dialog, not a spin) via the e2e
   mocks.
5. **Connection chaos drills (scripted where possible; some manual).**
   `kill -STOP` the daemon → host offline within one keepalive window (the
   derived-status rule) → `-CONT` recovers without a supersession storm.
   `kill -9` uvicorn mid-session → daemon keeps peers, browser keeps its
   channel, both rebind on restart (the orphan-grace acceptance test).
   pfctl-blocked server port for 30 s → watchdog fires → reconnect +
   `rtc.resume`, no terminal reload. pfctl `block drop proto udp` scoped to
   the daemon's pinned ephemeral range → TURN path; blocked TURN too → clean
   failure + the honest warning. Network Link Conditioner "Very Bad Network"
   while `yes` streams → pacing + `pty_gap`, never channel death. Lid-close
   2 min / Wi-Fi toggle → ICE restart (not rebuild) within the 10 s budget.
6. **Onboarding flow tests.** Playwright: the setup-claim inline approve path
   (mock daemon posting possession), the checklist states, expired-code copy,
   fragment survival through the AuthGate redirect (a real regression risk),
   `key_conflict` copy. Mobile jest: pairing push → FingerprintReview
   pre-fill, checklist states.
7. **What "A/B" means here (single developer)**: interleaved cohorts as a
   canary — two local hosts (this Mac via launchd + a Linux VM/container),
   `SPAWN_DAEMON_AUTO_UPDATE` on for one, off for the other; compare
   update_result stages, time-to-register, and reconnect log classes before
   flipping the second. On mobile, EAS `--rollout-percentage 10` against your
   own devices with `revert-update-rollout` as the drill — but NOT from this
   branch (no deploys, no OTA publishes; document it in RELEASE.md instead).
8. **Doctor/TUI snapshot tests**: `spawnd doctor --json` shape; non-TTY
   output byte-equality with today's plain lines; NO_COLOR compliance;
   help-text golden files.
Tooling notes: toxiproxy (`brew install toxiproxy`), mitmproxy, Network Link
Conditioner (Xcode additional tools), pfctl anchors — all local; wire the CI
subset into `scripts/test-all.sh` behind the same optional-env pattern the
existing smokes use.

---

# Part 9 — Execution plan for the implementing session

Work in phases; each phase = implement → verify → commit (per-folder pathspec
commits with honest messages) → push the branch. Re-read the relevant source
report at the start of each phase. When a phase's scope partially exists
(because an in-flight stream landed it), diff the report's checklist against
`git log` and build only the remainder. Keep `scripts/test-all.sh` green at
every commit boundary you claim green; never weaken a guard to pass it.

- **Phase 0 — Orient.** Read this document end to end; read the seven-ish
  landed commits (`git log master..HEAD --stat`); run the folder checks on a
  clean tree to establish your baseline (including the known macOS reds).
  Confirm: `pytest -q` server, targeted daemon filters, web bun tests,
  `mobile npm run ci`, `bash -n scripts/*.sh`, `alembic heads` = 0062.
- **Phase A — S2, the server connection work (Part 2.2 item list).** The
  largest untouched block; the shipped clients already feature-detect it.
  Order inside: session_epoch on WS auth (security) → keepalive pings +
  rtc.config refresh → derived host status + presence reclaim → 4010 close
  codes → orphan-grace/rebind/resume + ice_restart acceptance → /ws/host
  4003 + unknown-frame errors → ICE config validation → hot-path DB lock
  removal → admission semaphore, caps, TTLs. Full pytest + the WS-focused
  files first; extend `server/tests/test_ws_*` for every new frame.
- **Phase B — close the D2/M2 gaps.** Read `docs/masterplan/IMPL-daemon2.md`
  and `IMPL-mobile2.md`; anything their "Undone" sections name, plus any
  Part 6 ADOPT-NOW item their commits lack (the probation health gate #1 and
  signed manifest #2 + downgrade guard #3 are the likeliest gaps — #2/#3
  also touch `scripts/release-lib.sh`/deploy and `server` manifest
  validation, so they cut across folders: land daemon verify + script
  signing + server tolerance in one coherent commit series). Then the
  ErrChunk end-to-end check: confirm Cargo.lock shows webrtc 0.17.2 and the
  vendored sctp patch exists; if not, apply per Part 2.3.
- **Phase C — the UX build-out (Part 3, cut-list order).** Tier 1 (setup
  claims end to end) → Tier 2 (TUI kit, doctor, reconnect/disconnect/
  logout/reset, error catalogue, QR, install.sh restyle) → Tier 3 (host-page
  panel, Add-a-machine). Both frontends in the same commit for every
  user-facing piece; server pieces (claims API, trust events,
  last_disconnect columns) land with tests.
- **Phase D — hygiene (Part 4).** Session sliding renewal + sign-out-
  everywhere first (it kills the monthly sign-out), then daemon token
  rotation, then pin capacity (nack + reclaim + headroom + copy), then the
  stale-device surfacing and store hygiene.
- **Phase E — multi-account UX (Part 5).** `possess --new-account`,
  install.sh passthrough, status listing (if not already via Phase C),
  docs + copy.
- **Phase T — the test programme (Part 8), interleaved.** Build items 1–3
  immediately after Phase B (they gate the updater work you just touched);
  item 4 after Phase A; items 5–6 after C; wire the CI subset into
  test-all.sh. A phase is not done until its tests exist and pass.
- **Phase F — the desktop companion (Part 7).** Last: it consumes the
  claims API, doctor --json, and the update machinery. MVP scope only per
  the design's staged path.
- **Continuous:** update the owning CLAUDE.md in the same commit as any
  structure/command change (the guard enforces it); keep docs/RELEASE.md and
  docs/NETWORK.md true as behaviour lands; append a short CHANGELOG section
  to this file's Part 1 table as each phase lands so the document stays the
  single source of truth.

## How to parallelise: codex CLI workers (the pattern that worked)

Dispatch implementation phases to codex CLI subagents, one per folder, exactly
as the work in Part 1 was built:

```
codex exec --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true \
  -C /Users/charliesaxton/dev/spawn - < /path/to/brief.md > /path/to/log 2>&1 &
```

Rules that kept a shared checkout safe across ten workers, zero incidents:
each worker gets a self-contained brief file (spec section + files to read
first + its folder ownership + verification commands + a report path) piped
on stdin; workers NEVER run any git write command — the orchestrator (you)
reviews each diff and commits that worker's paths with explicit pathspecs
(`git add -- <folder> && git commit … -- <folder>`), checking `git log
--stat -1` after for strays; never `git stash` in this checkout; disjoint
folder ownership per concurrent worker (server/ daemon/ web/ mobile/
scripts+docs); cross-folder contracts written down in the brief BEFORE
dispatch so parallel workers build against the same wire shapes. Keep
reviews/investigations as read-only Claude subagents; use codex for code.

## What "done" means (acceptance, in the user's terms)

- A deploy with daemon changes updates every online daemon within seconds of
  its reconnect, sessions intact; a daemon that can't update says so in the
  UI with the exact fix; nothing ever silently runs stale.
- A stale browser tab offers a reload; a protocol break reloads it. The
  phone OTAs itself and says when the App Store is needed.
- A laptop lid-close, Wi-Fi switch, VPN toggle, or server deploy costs a
  terminal seconds (ICE restart / resume), not a rebuild — and never a
  frozen pane that looks alive.
- "Daemon says connected but the app disagrees" cannot happen: status is
  derived from recency, presence reclaims eagerly, and a dead link is
  detected within one watchdog window on every socket.
- The 3–39 s session deaths are gone (verify with the candidate-pair log and
  a soak; the field signature to watch is `failed to handle_inbound:
  ErrChunk`).
- Install → sign-up → first terminal is one continuous flow with no orphan
  tabs, no jargon errors, working QR/push paths, and a `spawnd doctor` that
  turns every support question into one command.
- Nobody is signed out monthly; a revoked device is gone everywhere within
  seconds; capacity never wedges silently.
- Every one of the above has a committed test or scripted drill that fails
  when it regresses, and `docs/RELEASE.md` + `verify-release.sh` make a
  future release that violates the contract refuse to ship.
