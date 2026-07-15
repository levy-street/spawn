# Trust Phase 2/3 — progress + resume notes

Working savefile for the "operator model" migration. Design spec:
`docs/TRUST_PHASE2.md`. Governing doc: `docs/TRUST.md`. Read both first.

## What we're doing and why

A security audit found the server currently **sees terminal content**: even for
v2 (DataChannel) clients the daemon mirrors PTY output to the server as
plaintext (`0x01` leg) → transcripts + Redis pubsub, and history/snapshot frames
still transit the server. Signaling is also unsigned (server can MITM the
DataChannel). Goal of this work ("Tier 2"):

- **Phase 2** — server holds *zero* terminal content. Acceptance: grep the
  server, no path touches PTY bytes / uploads / env / skill bodies.
- **Phase 3** — signed signaling + fingerprint pinning, so a hostile server
  can't MITM the DataChannel.

## Done (committed on `master`)

| commit | increment | what |
|--------|-----------|------|
| `e03fb3f` | 0 | Deleted the dead Redis PTY ring buffer (`ws/ringbuffer.py`, `RedisBackend.ring_*`, `_InProcPubSub` ring methods, `config.ringbuffer_max_bytes`). No callers. Behaviour-neutral. |
| `f69b5fc` | — | `docs/TRUST_PHASE2.md` implementation spec (the cut sequence). |
| `4b245f1` | 1 | **Content-free activity ping.** Classifier moved daemon-side; server no longer parses bytes for activity. |

### Increment 1 detail (the keystone)
- `daemon/src/activity.rs` (NEW): faithful Rust port of the server's
  `output_payload_is_meaningful` (strip OSC/CSI/charset/tmux-clock/control,
  require ≥3 non-whitespace chars). 4 unit tests.
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

**Validation done:** daemon `cargo test --bins --lib` = 40 pass; server suite =
127 pass (2 pre-existing unrelated failures: `test_auth_providers`,
`test_migrations`). **Deployed + live-validated** on dev: this session's
`last_output_at` updates via `agent.activity` (server no longer sees bytes for
activity); no post-restart `unknown frame` logs; no errors.

## Exactly where we're up to

Increment 1 is **fully shipped to the dev stack**. The `0x01` output leg still
*exists* (it now only persists the transcript + feeds the pubsub relay) — the
server no longer *needs* it for activity, which is the precondition for cutting
it. Nothing is half-done; `master` builds and both test suites pass.

## Remaining

- **Increment 2 (NEXT, large — daemon + web):** add a second DataChannel label
  `spawn.ctl` (daemon gates on label at `rtc.rs:348`; browser creates only
  `spawn.pty` at `useAgentSocket.ts:244`). Carry snapshot/replay **requests +
  responses** over it; on DC-open the browser fetches connect-time backfill +
  scrollback from the daemon (worker: `worker_replay` `pty.rs:340`; tmux:
  `tmux::capture_history`) instead of the server `history`/`snapshot` frames.
  Removes the last content that transits the server for v2 clients. Collapses
  the `dc_offset`/`rtc_session_id` cross-transport ordering machinery.
- **Increment 3:** drop the `WsOutbound::Binary` `0x01` sink in `run_forwarder`
  (`pty.rs`); delete `server/spawn_server/transcript.py` + `daemon.py:148`
  append + `browser.py` history/snapshot forwarding + the v1 `_pump_pubsub` /
  `0x02` input legs + `redis.py` pubsub. Requires the DataChannel to be
  mandatory (retire `spawn.v1`). Accepted regression: offline-host history.
- **Increment 4:** uploads over a `spawn.ctl` file stream; delete the
  `bytes_b64` legs (`browser.py:497-539`, REST `agents.py:449-494`).
- **Increment 5:** env + skill bodies E2E at spawn over the host-control
  channel; REST `agent.create` persists only the row. Stop persisting
  `Agent.env`/`Skill.content`; drop `"env"`/`"skills"` from
  `_dispatch_agent_launch` (`agents.py:201,203`).
- **Phase 3 (task #48):** Ed25519 host keys at `spawnd login` + per-browser
  WebCrypto device keys; sign `rtc.offer`/`rtc.answer` over
  `(SDP‖session‖agent‖peer key)`; TOFU-pin, refuse unpinned. Acceptance: a test
  server that swaps SDP fingerprints makes both endpoints abort loudly.

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

**Tasks:** #45–#48 track Phase 2 items + Phase 3.
