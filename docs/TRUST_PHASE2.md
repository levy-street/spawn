# Trust Phase 2 — implementation spec (server holds no terminal content)

Companion to `docs/TRUST.md` Phase 2. This is the buildable cut sequence,
derived from a full audit of every server content touchpoint and every daemon
output path. Each increment is independently shippable and validated. The end
state satisfies the acceptance grep: *no server code path touches PTY bytes,
upload bytes, env values, or skill bodies.*

## Current reality (why this is the sequence)

- Both session backends (tmux `pty.rs`, worker `worker_backend.rs`) converge on
  one `run_forwarder` (`daemon/src/pty.rs:594-627`) that sends every output
  chunk to **two sinks unconditionally**: the WebRTC DataChannel direct-sinks
  **and** the server-bound `0x01` WS leg. No v2 gate on the daemon side.
- The DataChannel is a single raw `spawn.pty` byte pipe (`rtc.rs:34,348`). No
  multiplexing — history, snapshots, uploads all still ride the server WS.
- The server needs the `0x01` leg for exactly three things
  (`server/spawn_server/ws/daemon.py:142-164`): **activity classification**,
  **transcript persistence** (→ connect-time history seed), **v1 relay fan-out**.
- v2 already keeps *live* PTY off the server (Phase 1), but the connect-time
  `history` frame and every `snapshot` frame still transit the server for every
  client, v1 and v2.

## Increments

### 0 — delete the dead Redis ring buffer  ✅ done (`e03fb3f`)
Zero callers. `ws/ringbuffer.py`, `RedisBackend.ring_*`, `_InProcPubSub` ring
methods, `config.ringbuffer_max_bytes`. Behaviour-neutral.

### 1 — content-free activity ping (the one genuine "replace")
The server derives an agent's `active/quiet/waiting` badge by **parsing** PTY
bytes (`activity.output_payload_is_meaningful` + suppression windows). That must
move to the daemon.

- **Daemon:** port `output_payload_is_meaningful` (decode-lossy; strip
  `_OSC_RE`/`_CSI_RE`/`_CHARSET_RE`/`_TMUX_STATUS_CLOCK_RE`/`_TMUX_STATUS_FRAGMENT_RE`/`_CONTROL_RE`;
  `\s+`→""; require ≥ `MIN_MEANINGFUL_OUTPUT_CHARS`=3). In `run_forwarder`,
  classify each chunk; throttle to ≤ once / `OUTPUT_TOUCH_INTERVAL` (2s); honor
  suppression windows the daemon now owns (it knows when it injected a
  redraw/resize/input-echo — `INPUT_ECHO_SUPPRESS_WINDOW`=750ms,
  `REDRAW_SUPPRESS_WINDOW`=1500ms). Emit a metadata-only control frame
  `Outbound::AgentActivity { agent_id }` (add to `daemon/src/proto.rs`).
- **Server:** handle `agent.activity` in `ws/daemon.py` → stamp
  `agent.last_output_at` + `host.last_seen_at`. **Remove** the byte inspection
  on the `0x01` path (`daemon.py:145-153` → drop the `should_record_agent_output`
  call). `last_input_at` already comes from a control action (v2 input is
  DataChannel-direct, so the daemon sees it) — emit an input-activity signal the
  same way, or keep the existing input stamping if still control-plane.
- `ws/activity.py` server-side keeps only the throttle/suppression *state* the
  server still needs; the classifier + suppression move daemon-side.
- **Acceptance:** with the `0x01` transcript leg still present but activity
  decoupled, agent badges still transition correctly; server never calls
  `output_payload_is_meaningful` on daemon bytes.

### 2 — DataChannel control channel (`spawn.ctl`) + history/snapshot over it
Add a second DC label `spawn.ctl` (daemon already gates on label at
`rtc.rs:348`; browser creates only `spawn.pty` at `useAgentSocket.ts:244`).
Carry snapshot/replay **requests + responses** over it, framed. On DC-open the
browser requests the connect-time backfill + scrollback from the daemon over
`spawn.ctl` (worker: `worker_replay` `pty.rs:340`; tmux: `tmux::capture_history`)
instead of the server `history`/`snapshot` frames. This removes the last content
that transited the server for v2 clients. The `dc_offset`/`rtc_session_id`
cross-transport ordering machinery collapses (both live + backfill now on the DC).

### 3 — drop the `0x01` output leg + delete server content stores
Safe once (1) and (2) land and the DataChannel is mandatory (v1 retired):
- Daemon: drop the `WsOutbound::Binary` sink in `run_forwarder`
  (`pty.rs:601-621`); reroute `send_pty_text`/`send_snapshot_text` banners onto
  `spawn.ctl` or drop them.
- Server: delete `transcript.py` + `daemon.py:158` append + `browser.py`
  history/snapshot forwarding + the v1 `_pump_pubsub`/`0x02` input legs +
  `redis.py` pubsub. Drop `spawn.v1` + `WS_CLOSE_BINARY_ON_V2` branching.
- **Accepted regression:** offline-host history replay (documented in TRUST.md).

### 4 — uploads over the DataChannel file stream
Replace the `bytes_b64` legs (`browser.py:497-539`, REST
`agents.py:449-494`, `agent_control.decode_upload`) with a `spawn.ctl` file
stream. Keep the content-free `upload.saved`/`path` ack.

### 5 — env + skill bodies E2E at spawn (largest new mechanism)
REST `agent.create` persists only the row (id/name/host/status). `env` values
and skill `content` travel over the host-control DataChannel at spawn time;
stop persisting `Agent.env`/`Skill.content` server-readably and drop
`"env"`/`"skills"` from `_dispatch_agent_launch` (`agents.py:201,203`).
`cwd`/`argv` are content-adjacent metadata, deferred (TRUST.md:114-117).

## Operational staging (do not break live sessions)

Increments 1–5 modify the **daemon**; restarting it restarts every session
riding it (including any live agent). For each daemon increment: build
(`cargo build`), run `daemon` test suite + `scripts/smoke-local-*`, stage on a
throwaway host/agent first, and only then roll the live daemon during a quiet
window. Server-only pieces deploy independently with just a server restart.

## Acceptance (end of Phase 2)
`grep` the server for any path that reads PTY bytes, upload bytes, env values,
or skill bodies → none. A compromised server's disk + Redis + memory contain no
session content. (Signaling MITM remains — that's Phase 3.)
