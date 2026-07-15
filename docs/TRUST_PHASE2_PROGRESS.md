# Trust Phase 2/3 — progress + resume notes

Working savefile for the "operator model" migration. Design spec:
`docs/TRUST_PHASE2.md`. Governing doc: `docs/TRUST.md`. Tracked execution
schedule: `docs/TRUST_PHASE2_TASKS.md`. Read all three first.

## What we're doing and why

A security audit found the server currently **sees protected content**: even
for v2 (DataChannel) clients the daemon mirrors PTY output to the server as
plaintext (`0x01` leg) → transcripts + Redis pubsub, and history/snapshot
frames still transit the server. Host paths/files/transfers, installer output,
REST terminal surfaces, launch values, preset environment templates, and skill
bodies also have server-readable paths or stores. Signaling is unsigned (server
can MITM the DataChannel). Goal of this work ("Tier 2"):

- **Phase 2** — server has no plaintext protected-content path or recoverable
  plaintext store. Acceptance includes runtime path tests plus primary and
  backup purge evidence; grep alone is insufficient.
- **Phase 3** — signed signaling + fingerprint pinning, so a hostile server
  can't MITM the DataChannel.

## Done (committed on `master`)

| commit | increment | what |
|--------|-----------|------|
| `e03fb3f` | 0 | Deleted the dead Redis PTY ring buffer (`ws/ringbuffer.py`, `RedisBackend.ring_*`, `_InProcPubSub` ring methods, `config.ringbuffer_max_bytes`). No production callers; the stale operational Redis smoke was repaired separately. |
| `f69b5fc` | — | `docs/TRUST_PHASE2.md` implementation spec (the cut sequence). |
| `4b245f1` | 1 | **Content-free activity ping.** Classifier moved daemon-side; server no longer parses bytes for activity. |

### Increment 1 detail (the keystone)

- `daemon/src/activity.rs` (NEW): initial Rust port of the server's
  `output_payload_is_meaningful` (strip OSC/CSI/charset/tmux-clock/control,
  require ≥3 non-whitespace chars). Its invalid/incomplete UTF-8 and chunk-boundary
  behavior needs the corrective gate tracked in `TRUST_PHASE2_TASKS.md`.
- `daemon/src/pty.rs`: `ForwarderControl` gained `last_activity_ms` +
  `suppress_until_ms` atomics + `suppress_activity()` + `note_output()`.
  `run_forwarder` classifies each chunk (throttled to `OUTPUT_TOUCH_INTERVAL`
  2s) and emits `Outbound::AgentActivity{agent_id}` (best-effort `try_send`).
  `write_stdin`/`resize` suppress echo/repaint; `handle_agent_redraw`
  (`run.rs`) suppresses too.
- `daemon/src/proto.rs`: `Outbound::AgentActivity` = `"agent.activity"`.
- `server/spawn_server/ws/daemon.py`: handle `agent.activity` → stamp
  `last_output_at` + `host.last_seen_at`; **deleted** the `0x01` byte
  classification. `tests/test_ws_daemon.py`: new round-trip test.

**Historical Increment 1 validation:** daemon `cargo test --bins --lib` = 40
pass; the full server run recorded 127 passed and 2 failed
(`test_auth_providers`, `test_migrations`), so it was not a passing full suite.
**Deployed + live-validated** on dev: this session's
`last_output_at` updates via `agent.activity` (server no longer sees bytes for
activity); no post-restart `unknown frame` logs; no errors.

The later comprehensive review ran 88 daemon tests successfully and 9 focused
server tests successfully. Its full server run recorded 128 passed plus the two
known failures. It also found the Redis smoke failure and global formatting/
lint warnings listed in the task schedule; no document should summarize that
state as "both suites pass."

## Exactly where we're up to

Increment 1's output-activity path is **shipped to the dev stack**. The `0x01`
output leg still exists (it persists the transcript and feeds the v1 pubsub
relay), so the server still receives all PTY output. The server no longer needs
those bytes for activity, which is the precondition for cutting the mirror.

The comprehensive review opened an immediate pre-Increment-2 gate: v2 input
does not stamp `last_input_at`; scroll/copy-mode suppression is incomplete; the
classifier and clock need boundary corrections; the Redis smoke is stale; and
activity integration coverage is incomplete. No Increment 2 implementation has
started. The detailed status/dependencies are in `TRUST_PHASE2_TASKS.md`.

## Remaining sequence

1. Finish and independently review every immediate activity/smoke gate.
2. In parallel, build per-agent `spawn.ctl` for history/snapshot and a separate
   host-scoped `spawn.host.ctl`. Per-agent RTC is not sufficient for file/tool
   operations on a host with no agent.
3. Retire `spawn.v1` plus `0x01`/`0x02`; then migrate agent uploads and remove
   REST terminal content surfaces.
4. Move host listings/read/write/transfer and installer detail onto the host
   channel. Cross-host bytes stream through the trusted browser, not the server.
5. Move full launch manifests, `Agent.env`, `Preset.env_template`, and skill
   bodies to the approved endpoint-owned/encrypted store and host channel.
6. Only after replacements and endpoint recovery tests pass, run the historical
   plaintext purge across live disk/DB/Redis and every backup/snapshot. Verify
   the oldest retained restore before making the Phase 2 claim.
7. Phase 3 adds Ed25519 host keys, browser device keys, signed signaling, and
   TOFU pinning to both agent- and host-scoped peer connections.

## Operational playbook (how to build/deploy/validate — no secrets here)

**Topology.** Two daemons share the oem dev box:
- `spawnd.service` → **PROD** (`spawnd.dev`, AWS, an *earlier* commit). Binary
  `~/.local/bin/spawnd`. **DO NOT TOUCH.**
- `spawnd-dev.service` → **DEV** (dream → the minivac dev web instance).
  Binary `~/.local/bin/spawnd-dev` (separate!). `SPAWND_SESSION_BACKEND=worker`,
  workers under `~/.local/state/spawn-dev/workers`. This is where THIS session's
  agent (`9e4e2296`) runs.
- Dev server + web on **minivac**: `systemctl --user` units
  `spawn-dev-server.service` (127.0.0.1:18330) and `spawn-dev-web.service`
  (0.0.0.0:8330). Repo at `~/projects/spawn`; web build needs
  `SPAWN_API_PROXY_TARGET=http://127.0.0.1:18330`.

**Deploy the daemon (dev):** `cargo build --release --bin spawnd` (oem box) →
install via *atomic rename* (`cp target/release/spawnd ~/.local/bin/spawnd-dev.new
&& mv -f ...spawnd-dev.new ~/.local/bin/spawnd-dev`; in-place `cp` fails "text
file busy") → `systemctl --user restart spawnd-dev.service`. **Safe for this
session:** the worker backend *adopts* running workers on restart (see the
`adopting session worker` journal lines), so the claude process keeps running
and the browser reconnects. Keep a `.bak` of the old binary for rollback.

**Deploy the server (dev):** `git push origin master` → `ssh minivac 'cd
~/projects/spawn && git pull --ff-only && systemctl --user restart
spawn-dev-server.service'`. **Deploy order for a daemon+server increment: daemon
first** (new frame is backward-compatible; old server logs `unknown frame` but
still works), then server.

**Validate live:** mint a dev session token server-side
(`auth.issue_session_token(user_id)` on the dev box — details + the user/host
ids are in the private `reference_dev_playwright_token` memory, deliberately not
committed), then `curl -H "Cookie: spawn_session=<tok>" <dev-web>/api/agents`
and check `activity_state` / `last_output_at`, or drive Playwright from `web/`
with the cookie.

**Tasks:** `docs/TRUST_PHASE2_TASKS.md` is the repository task ledger and maps
every review finding to an implementation, independent review, merge, and
acceptance gate.
