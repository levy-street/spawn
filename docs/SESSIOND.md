# sessiond — replacing tmux with purpose-built session workers

**Status: implemented behind a flag.** The worker backend ships in `daemon/`
(`spawn-worker` binary + `spawnd` supervision) and is enabled per host with
`SPAWND_SESSION_BACKEND=worker` or per agent with the same key in the agent's
`env`. **tmux remains the default backend**; nothing in this design runs
unless opted in. This document and the code are meant to agree — where they
drift, the code under `daemon/src/sessiond/` and `daemon/src/worker_backend.rs`
is the source of truth and this file has a bug.

Governing trust document: [TRUST.md](TRUST.md). Every design choice below is
tied back to it; the short version is that tmux was the last piece of
infrastructure between the agent process and the browser that (a) we don't
control, (b) holds terminal plaintext at rest, and (c) contains a full
server-side terminal emulator we neither need nor test.

---

## 1. Why replace tmux

tmux earned its place: detached sessions gave us agent survival across
`spawnd` restarts for free. But it fights the operator model and the
product in specific, structural ways:

| Problem | Consequence |
|---|---|
| tmux server holds scrollback **in plaintext**, in memory and with no at-rest encryption story | the one place terminal content persists on the host is the one place we can't encrypt |
| tmux is a **terminal emulator in the middle**: agent → tmux grid → re-emitted escape codes → browser xterm.js | double emulation causes fidelity bugs (repaint gaps, mouse/copy-mode weirdness) that we've been patching with `refresh-client` and SIGWINCH hacks |
| one tmux server per user socket owns **all** sessions | a tmux server crash or wedge kills every agent on the host at once |
| control is subprocess-based (`tmux send-keys`, `capture-pane`, `pane_in_mode` polls) | per-keystroke subprocess costs we had to cache around (`copy_mode_cached`), and content transits argv/pipes of a third-party binary |
| copy-mode intercepts input | browsers had to detect-and-cancel it (`tmux::cancel_copy_mode`) because a remote viewer must never be trapped in a server-side mode |
| scrollback is line/grid-based | replay re-serializes the grid instead of replaying the byte stream the browser's emulator actually consumed |

The replacement keeps the two properties tmux actually gave us — **agent
survival across spawnd restarts** and **reattach with history** — and drops
everything else.

## 2. Design principles

1. **The server never sees content** (TRUST.md, the principle). Nothing here
   touches the control plane: the worker protocol runs on a unix socket in a
   `0700` directory on the user's own host; live PTY bytes leave the host
   only over WebRTC DataChannels (DTLS peer-to-peer; TURN relays ciphertext).
2. **Terminal emulation lives in the browser, and only in the browser.**
   Workers are byte pipes: they never parse escape sequences, never hold a
   grid, never re-render. xterm.js in `web/` is the single emulator in the
   system, which is also what makes the conformance harness (§12) meaningful.
3. **Raw PTY bytes end-to-end.** Scrollback is the raw output stream, not a
   serialized grid; replay is "feed the same bytes to the same emulator."
4. **One process per agent.** Crash isolation, per-agent keys, per-agent
   lifecycle, no shared mux server.
5. **Honest crypto claims.** Encrypted-at-rest scrollback minimizes plaintext
   *residency*; it does not and cannot mean "encrypted before DRAM" (§6.3).

## 3. Process model

```
spawnd (host supervisor, one per host)
 ├── ws/rtc: control plane WS (signaling only) + WebRTC peer connections
 ├── worker_backend: launch / adopt / signal workers
 │
 ├── spawn-worker --agent-id A … (one process per agent, own process group)
 │    ├── owns the PTY master (portable-pty)
 │    ├── agent process (session leader on the PTY slave)
 │    ├── encrypted scrollback log (ChaCha20-Poly1305, segmented)
 │    └── unix listener: $WORKER_DIR/<agent-id>.sock
 └── spawn-worker --agent-id B …
```

- **spawnd stays the host supervisor.** It owns the control-plane connection,
  WebRTC, agent registry, and the decision of which backend an agent uses.
  It launches workers, adopts orphaned ones, routes input/output, and reaps
  exits.
- **`spawn-worker`** (`daemon/src/bin/spawn-worker.rs`, logic in
  `daemon/src/sessiond/worker.rs`) is one process per agent. It binds its
  socket, waits for `Start`, spawns the agent argv on a PTY it owns
  (portable-pty, same crate the tmux backend uses for its attach PTY),
  and from then on: streams output, accepts input/resize, maintains the
  scrollback log, serves replay.
- The worker is spawned with `process_group(0)`: its fate is tied to the
  agent (it holds the PTY master), **not** to spawnd. spawnd dying, being
  upgraded, or being restarted leaves workers and their agents running.
  Deployment note: under systemd, spawnd's unit needs `KillMode=process`
  or workers get killed with the cgroup on `systemctl restart`.
- Worker runtime cost is small by construction (a tokio runtime pinned to 2
  threads, two blocking PTY I/O threads, no grid state), so "a fleet of
  workers" scales with agent count the way `cat` would.

### Filesystem layout

`worker_dir()` resolves `$SPAWND_WORKER_DIR` → `$XDG_RUNTIME_DIR/spawn/workers`
→ `<config_dir>/workers`, created `0700`:

```
workers/
  <agent-id>.sock          # unix listener, unlinked by the worker on exit
  <agent-id>.scrollback/   # 0700; seg-00000001.log … (ciphertext only, 0600)
```

Preferring `XDG_RUNTIME_DIR` puts sockets and ciphertext on tmpfs where
available: gone on reboot, never on spinning rust. That is a feature — the
scrollback key is process-ephemeral anyway (§7).

## 4. spawnd ↔ worker wire protocol

`daemon/src/sessiond/wire.rs`. Length-prefixed frames on the unix socket:

```
+-----------+------+-----------------+
| len (u32) | type | payload         |
| LE        | u8   | len bytes       |
+-----------+------+-----------------+
```

`len` counts the payload only; `MAX_FRAME_LEN` = 32 MiB (replay dominates and
is capped far below this by the scrollback budget). Structured payloads are
JSON; hot-path payloads are raw bytes. `PROTO_VERSION = 1`, checked at
adoption time from `Hello.version` — a version-skewed worker is refused, not
guessed at.

| Type | Dir | Payload | Purpose |
|---|---|---|---|
| `T_HELLO` 0x01 | w→d | JSON `{version, agent_id, state, pid?, cols, rows}` | first frame on **every** accepted connection; enables stateless adoption |
| `T_START` 0x02 | d→w | JSON `{cwd, argv, env, cols, rows}` | spawn the agent. Env goes over the private socket, not argv, so secrets never appear in `/proc/*/cmdline` |
| `T_STARTED` 0x03 | w→d | JSON `{pid}` | agent is running (the **real** agent pid, unlike the tmux backend's attach pid) |
| `T_OUTPUT` 0x04 | w→d | raw bytes | live PTY output |
| `T_INPUT` 0x05 | d→w | raw bytes | PTY stdin |
| `T_RESIZE` 0x06 | d→w | `cols u16 LE, rows u16 LE` | PTY resize (kernel sends SIGWINCH) |
| `T_REDRAW` 0x07 | d→w | empty | SIGWINCH repaint nudge (§8.2) |
| `T_REPLAY_REQ` 0x08 | d→w | `max_bytes u32 LE` | request decrypted scrollback |
| `T_REPLAY` 0x09 | w→d | `watermark u64 LE ‖ raw bytes` | replay starting at a checkpoint; watermark = total output bytes logged at capture |
| `T_EXIT` 0x0A | w→d | JSON `{exit_code?, signal?}` | agent exited |
| `T_SHUTDOWN` 0x0B | d→w | JSON `{signal?}` | signal the agent's process group (TERM/KILL/INT/HUP/QUIT) |
| `T_ERROR` 0x0C | w→d | JSON `{message}` | recoverable command failure |

Connection semantics: the worker serves **one live connection**; a newly
accepted connection displaces the previous one (frames from displaced
connections are dropped by generation tag). That is exactly the semantics
adoption needs — a restarted spawnd connects and simply wins. Unknown frame
types are ignored (forward compatibility); oversized frames are a hard error.

Lifecycle timers: a worker that never receives `Start` exits after 120 s; a
worker whose agent exited lingers 60 s to deliver `T_EXIT` to a reconnecting
spawnd, then cleans up regardless. On exit the worker deletes its scrollback
(the key dies with it anyway), unlinks its socket, and terminates.

## 5. Data path — where bytes flow, who can read them

```
agent process
  │ PTY slave → kernel → PTY master (plaintext, kernel buffers, user's host)
  ▼
spawn-worker: read buffer ── encrypt → scrollback log (ciphertext, disk)
  │                └─ zeroized after each hop
  ▼ T_OUTPUT (unix socket, 0700 dir, same host)
spawnd: per-agent outbox → forwarder ──→ DataChannel direct sinks (per viewer)
                                    └──→ WS sink (legacy v1 relay only)
  ▼ WebRTC DataChannel (DTLS, peer-to-peer; TURN sees ciphertext)
browser: xterm.js — the only terminal emulator in the system
```

The worker backend reuses the **existing** outbox → forwarder → sinks
plumbing from the tmux backend (`pty::run_forwarder`, `ForwarderControl`), so
the Phase-1 DataChannel PTY path (`rtc.rs`) needed zero changes: a
worker-backed agent's `AgentHandle` exposes the same `write_stdin` / `resize`
/ `control` surface, dispatching to `WorkerCmd`s over the socket instead of a
locally-held PTY (`HandleBackend::{Tmux,Worker}` in `daemon/src/pty.rs`).

Control-plane exposure of this path: **nothing**. The unix socket never
crosses a machine boundary. Live bytes cross machines only inside DTLS.
Snapshot/replay responses currently ride the browser WS as `agent.snapshot`
JSON (base64) — the same Phase-1 status quo as the tmux backend, and the
same Phase-2 work item (move history/snapshot onto a DataChannel stream)
regardless of backend. The worker design makes that move trivial: the replay
payload is already raw bytes with a stream-position watermark.

## 6. Encrypted-at-rest scrollback

`daemon/src/sessiond/scrollback.rs`.

### 6.1 Format

Append-only, segmented log. Per record:

```
u32 LE ciphertext_len | u8 kind | u64 LE seq | ciphertext (AEAD, 16-byte tag)
```

- **Cipher**: ChaCha20-Poly1305, one AEAD seal per record.
- **Nonce**: the strictly-monotonic record sequence number (96-bit nonce,
  low 64 bits = seq). Safe because the key is unique per worker process and
  never reused (§7); nonce reuse is structurally impossible.
- **AAD** binds `kind ‖ seq`, and replay verifies seq contiguity across
  records, so ciphertext records cannot be reordered, dropped, duplicated, or
  spliced between kinds without detection. Any authentication or sequence
  failure **fails the whole replay closed** (and zeroizes the partial
  plaintext) rather than returning a best-effort screen.
- **Kinds**: `OUTPUT` (raw PTY bytes) and `CHECKPOINT` (empty marker record
  opening every segment; §8.1).

### 6.2 Encrypt-on-read, bounded growth

Output is encrypted **the moment it leaves the PTY read path** — the worker's
main loop logs the chunk first, then forwards it live, then zeroizes the
buffer. Plaintext is never written to disk (unit-tested by grepping segment
files for a marker; `plaintext_never_hits_disk`).

Growth is bounded by two knobs (`--segment-bytes`, default 256 KiB plaintext
per segment; `--max-log-bytes`, default 8 MiB total): when the budget is
exceeded, whole oldest segments are unlinked — never partial records, never
the newest segment. Replay cost is therefore O(budget), not O(session
lifetime).

### 6.3 Memory hygiene — what is and isn't guaranteed

`daemon/src/sessiond/secret.rs` (`SecretBytes`):

**Covered:**
- Key bytes are generated from `getrandom`, held in heap pages that are
  `mlock(2)`ed (no swap) and `MADV_DONTDUMP`ed (no core dumps, Linux), and
  **zeroized on drop**. mlock failure (e.g. `RLIMIT_MEMLOCK=0` containers) is
  logged, not fatal: the at-rest encryption stands; only the key's
  swap-residency guarantee weakens.
- Plaintext PTY buffers are zeroized after each hop: the worker's read chunks
  after log+forward, the PTY reader/writer thread scratch buffers, stdin
  chunks after write, replay buffers (worker side) after send.

**Not covered — stated plainly, per TRUST.md's "honest inventory" ethos:**
- Plaintext **must** transit worker memory: kernel PTY buffers → userspace
  read buffer → AEAD input. There is no such thing as "encrypted before
  DRAM" on this path, and we do not claim it.
- Kernel-side copies (PTY line discipline, unix socket buffers) and copies
  inside webrtc/DTLS layers in spawnd are outside our control.
- spawnd itself handles plaintext in flight (outbox → DataChannel). Those
  buffers are not currently zeroized; they are transient. Phase-2 hardening
  can extend `wipe` discipline into the forwarder if it proves worth the
  churn.
- The guarantee is **minimal plaintext residency on the user's own host** —
  the same host where the agent itself runs in plaintext by definition. The
  threat this addresses is *disk* residue (backups, stolen disks, forensic
  carving, swap, core dumps), not a live root-level attacker on the host,
  which TRUST.md places out of scope (a compromised host sees everything
  regardless).

## 7. Key management for scrollback-at-rest

Implemented: **per-worker-process ephemeral key.** 32 random bytes generated
at worker start, held only in locked worker memory, never persisted, dead
with the process. A fresh worker unlinks any leftover segments from a
previous run (unreadable ciphertext by construction).

Why this is the right default — the alternatives and their tradeoffs:

| Key scheme | Survives worker restart | Blast radius if key leaks | Server involvement | Notes |
|---|---|---|---|---|
| **Per-worker ephemeral (chosen)** | no — but the PTY and agent died with the worker anyway, so the log has nothing meaningful left to replay | one agent's current session | none | zero key-management surface; nonce safety trivial; cleanup = forget |
| Host key (spawnd keyring) | yes | every agent's scrollback on the host | none | requires spawnd→worker key delivery (over the socket, fine) and rotation story; buys persistence of logs whose PTY is gone — mostly useful for a future "transcript archive" feature, not live reattach |
| Per-agent derived key (HKDF from host key + agent_id) | yes | one agent's full history | none | same delivery/rotation cost as host key with a smaller blast radius; the natural upgrade path if worker-restart-with-history ever becomes a feature |
| Sealed to browser device keys (Phase-3 WebCrypto identities) | yes | nothing on the host can read it — including the worker | pub-key registry only | the strongest story ("host stores what only your devices can open") but the worker could no longer *serve* replay; replay/checkpoint logic would move client-side, multi-device needs key-wrapping fan-out. This is the TRUST.md "client-side-encrypted transcript backup" (Later) item, not the live-session log |

The live-session log exists to serve reattach while the agent is alive; the
ephemeral key covers exactly that lifetime with the smallest possible surface.
When TRUST.md's optional encrypted transcript backup lands, it should be a
*separate* artifact sealed to device keys, not a repurposing of this log.

## 8. Reattach and replay

### 8.1 Checkpoint segments

Every segment opens with a `CHECKPOINT` record. When `append_output` crosses
the segment budget, the worker rotates the log and immediately fires a
**SIGWINCH jiggle** (§8.2). Full-screen programs respond by repainting, so
the bytes at the head of each new segment contain a fresh full-screen redraw.
Replay returns the newest run of whole segments fitting the caller's budget —
it therefore **starts at a checkpoint boundary**, which for full-screen apps
means "starts with a coherent repaint" and for line-oriented output is
trivially correct. This leverages the exact repaint mechanism the terminal
self-healing work (commit 9627b09) already validated against real agents.

Checkpoints are markers, not grid snapshots — storing a grid would require a
server-side emulator, violating principle 2. The cost is that replay of a
budget-truncated log may include a partial leading screen for apps that
ignore SIGWINCH; the SIGWINCH-repaint behavior of every agent TUI we ship has
been validated by the repaint self-healing feature in production.

### 8.2 SIGWINCH jiggle

The kernel only delivers SIGWINCH on an actual size *change*, so the worker
nudges: resize to `(cols, rows∓1)`, wait 20 ms, restore the desired geometry
(tracked so a concurrent real resize always wins). This is the tmux-free
equivalent of `refresh-client`, exposed as `T_REDRAW` and used (a) after
checkpoint rotation, (b) on browser (re)connect (`install_session_sinks`),
(c) on worker adoption after a spawnd restart.

### 8.3 Replay and viewer seeding

`T_REPLAY_REQ(max_bytes)` → `T_REPLAY(watermark ‖ bytes)`. The watermark is
the cumulative count of output bytes logged at capture time. spawnd's
snapshot handler (`handle_agent_snapshot`, worker branch) samples the
requesting viewer's DataChannel byte offset *before* issuing the replay;
because the worker logs before forwarding, everything counted at that offset
is guaranteed to be covered by the replay, and the browser can drop already
seen live bytes deterministically (the existing `dc_offset` mechanism the
tmux backend introduced for snapshot ordering — reused unchanged).

Replay correctness (PTY in → bytes out → reattach replays both the initial
output and mid-session stdin echo) is asserted end-to-end in
`daemon/tests/worker_e2e.rs` against a real `/bin/sh` on a real PTY, and
through the full spawnd plumbing (forwarder, direct sinks, adopt path) in
`worker_backend::tests::worker_launch_adopt_and_shutdown_roundtrip`. No tmux
is involved in any of these tests.

## 9. Resize, flow control, multi-viewer

**Resize.** `AgentHandle::resize` dedupes unchanged geometry (as today) and
sends `T_RESIZE`; the worker applies it to the PTY master and remembers it as
the restore target for jiggles. Resize *authority* is a client/server-side
concern: the display-control feature (commit c43340c) designates one
controlling viewer whose geometry drives the session while other viewers dim
— `display.control` frames carry owner + geometry + viewer metadata only (no
content), so the worker correctly stays a single-size PTY and needs no
multi-size machinery.

**Multi-viewer.** Fan-out happens in spawnd's forwarder via per-viewer
DataChannel direct sinks, same as the tmux backend: every viewer gets the
same raw byte stream, input is accepted from whichever peer the client-side
control model lets type. One improvement falls out for free: there is no
copy-mode to cancel, so the per-keystroke copy-mode check is skipped entirely
for worker-backed agents (`rtc.rs` guards on `registry.is_worker`).
Client-side scrollback/selection in xterm.js replaces tmux copy-mode.

**Flow control / backpressure — current, honest status.** The worker→spawnd
socket write applies natural backpressure to the worker's forwarding loop
(logging is unaffected), but the spawnd-side outbox and DataChannel sink
channels are unbounded, exactly as they are for the tmux backend today: a
slow viewer buffers in daemon memory, bounded in practice by session volume.
The scrollback budget bounds *replay*, not live buffering. Planned follow-up
(applies to both backends, so it is deliberately not gated on this
migration): bound the per-viewer sink, drop-oldest on overflow, and re-seed
the lagging viewer with replay-from-watermark + `T_REDRAW` — the worker
protocol already carries everything that recovery needs.

## 10. Crash isolation, restart, upgrades

| Event | Outcome |
|---|---|
| **Agent exits** | worker reports `T_EXIT` (real exit code), destroys its scrollback, unlinks its socket, exits; spawnd forwards `agent.exit`. If spawnd is down at that moment, the worker lingers 60 s so a restarted spawnd can collect the exit; spawnd additionally reaps via `socket_live` probes. |
| **Worker crashes** | the agent dies with it (it held the PTY master) — identical blast radius to "tmux server crashed" but scoped to **one** agent instead of every agent on the host. spawnd's connection reader reports `worker_lost`; the stale socket is cleaned up on next probe. Restart policy stays where it is today (user-driven `agent.restart`), which for agentic CLIs is the honest choice — blind auto-respawn of a stateful agent process is not a recovery. |
| **spawnd restarts / upgrades** | workers keep running (own process group). On startup `rediscover_existing_agents` scans the socket dir (`discover_ids`), connects, and adopts from the `Hello` (state, pid, geometry) — no persistent supervisor state, no fd handoff. The same lazy adoption path (`ensure_agent_attached`) recovers an agent on first use if startup discovery raced. A reconnect displaces no agent state; a `T_REDRAW` repaints the screen for viewers. |
| **spawnd upgrade + protocol change** | `Hello.version` gates adoption; a mismatched worker is left untouched (its agent keeps running) and surfaced in logs rather than driven with a protocol it doesn't speak. Old workers drain away as their agents exit. |
| **Worker binary upgrade** | applies to newly launched agents only; running workers are never hot-swapped. `worker_bin()` resolves `$SPAWND_WORKER_BIN` → sibling of the running spawnd binary → `PATH`. |
| **Host reboot** | everything dies, as with tmux. Runtime-dir sockets/ciphertext evaporate with tmpfs. |

Why no fd/socket handoff: the classic reason to pass fds (the supervisor owns
the PTY) doesn't apply — the **worker** owns the PTY and its listener, and
survives on its own. Adoption-by-reconnect is strictly simpler and has no
handoff window to get wrong.

## 11. Migration from tmux

**Coexistence (now).** Backend is chosen per agent at `agent.create`:
`SPAWND_SESSION_BACKEND` in the create env overrides the daemon-global env
var, default tmux (`worker_backend::backend_for_create`). Both backends
coexist on one host; restart/kill/rename/snapshot/redraw dispatch on
`registry.is_worker`. Rename becomes a label update (nothing shells out);
restart drives an escalating TERM→KILL shutdown through the worker before
respawning. Startup discovery adopts workers first, then scans tmux sessions.

**Cutover criteria** (flip the default to `worker`):
1. `tools/term-conformance` green on the browser emulator (§12) — the worker
   path has no server-side emulator to paper over client bugs.
2. Worker backend soaked on real agents (claude/codex) on the dev instance ≥
   a week: reattach-with-history, spawnd restart adoption, multi-viewer,
   mobile.
3. Backpressure follow-up from §9 landed or consciously deferred with data.
4. Prod spawnd unit runs `KillMode=process` (verified, not assumed).
5. An explicit escape hatch: per-agent `SPAWND_SESSION_BACKEND=tmux`
   continues to work for one release cycle after the default flips.

**Endgame.** tmux backend and the `tmux` module become dead code; delete
them, drop the `TMUX_TMPDIR` machinery, and with them the last subprocess
that ever touched terminal plaintext. (`agent.create`'s `tmux_session` field
survives as the display label it already is for workers.)

## 12. Prior art

| | shpool (Google) | wezterm-mux-server | zellij server | **spawn-worker** |
|---|---|---|---|---|
| Language | Rust | Rust | Rust | Rust |
| Model | one daemon, N named sessions | one mux server, own client protocol | one server per session group, plugin runtime | **one process per agent** |
| Server-side emulation | minimal (keeps a restore buffer; explicitly *not* a multiplexer) | full (termwiz grid; clients render grid deltas) | full (its own grid + layout engine) | **none — raw bytes; emulator is xterm.js only** |
| Reattach story | replays restore buffer | grid sync | grid sync | encrypted raw-byte replay from checkpoint + SIGWINCH repaint |
| Scrollback at rest | plaintext in memory | plaintext (grid) | plaintext (grid) | **ChaCha20-Poly1305 on disk, ephemeral key, zeroized buffers** |
| Crash blast radius | all sessions in daemon | all clients of the mux | session group | one agent |
| Remote transport | ssh | ssh/TLS, own protocol | ssh | WebRTC DataChannel (already existed; unchanged) |

shpool is the closest relative — it also concluded that "session persistence
without a multiplexer" is the right shape, and its restore-buffer replay is
the plaintext cousin of our checkpoint replay. We diverge where the operator
model demands it: per-agent process isolation, encryption at rest, and
refusing to host any grid state outside the browser. wezterm/zellij solve a
different problem (rich multiplexing UX) at the cost of being the second
emulator in the pipe — exactly what §1 is eliminating.

## 13. Testability

The browser is the only terminal emulator (§2), so terminal-correctness
testing splits cleanly into two independently-testable layers:

**Byte-transport correctness (this design).** The worker/backend guarantee is
byte-exactness, tested without any emulator: wire framing round-trips and
limits (`sessiond::wire` tests), crypto/log properties — plaintext never on
disk, tamper fails closed, budget enforcement, replay coherence
(`sessiond::scrollback` tests), memory hygiene (`sessiond::secret` tests),
and end-to-end PTY-in/bytes-out/reattach-replay through a real shell
(`daemon/tests/worker_e2e.rs`) and through the full spawnd plumbing
(`worker_backend` roundtrip test). `cargo test` in `daemon/` runs all of it;
no tmux, no network, no browser.

**Emulation correctness (harness).** `tools/term-conformance/` owns this:
a raw-byte corpus is fed to the system-under-test emulator (`@xterm/headless`
5.5.0, matching `web/`) and to oracles (pyte locally; iTerm2 recorded on
macOS), and resulting screen states are diffed.

**Grid-state schema — ratified.** This design adopts the harness's
**grid-state JSON schema v1** (`tools/term-conformance/schema/
grid-state.schema.json`, documented in `schema.md`; proposed in the shared
log 2026-07-13T11:02Z) as *the* serialization of terminal screen state for
all conformance and replay-fidelity testing, as proposed — including its
0-based coordinates, default-omitting compact cells, wide-char continuation
cells (`width: 0`), `"default" | 0–255 | "#rrggbb"` colors, NFC-normalized
text comparison, cursor-col clamping for pending-wrap, and null-as-wildcard
for limited oracles (that last rule is what lets a raw-byte-replay producer
that cannot observe, say, the title report `null` without false failures).

The schema is also the bridge between the two layers: because worker replay
is raw bytes, *replay fidelity* is testable by feeding (a) the live stream
and (b) a post-rotation replay of the same session into two headless xterm
instances and diffing their grid-state JSON — "replay from a checkpoint
converges to the live screen" becomes a machine-checkable property using the
harness's differ unmodified. That integration test is future work in
`tools/term-conformance` territory and should reuse its runner rather than
grow a second serializer in `daemon/`.

## 14. TRUST.md phase mapping

| TRUST.md phase | sessiond contribution |
|---|---|
| **Phase 1** (shipped) — DataChannel-only PTY | worker backend plugs into the same forwarder/direct-sink pipeline; no new server exposure. The unix-socket hop is intra-host and strictly *removes* a plaintext holder (tmux server) from the path |
| **Phase 2** — daemon-owned data, server stores deleted | this is the enabling work: scrollback/history/snapshot become daemon-owned artifacts (encrypted, at that) with a watermarked raw-byte replay primitive ready to move from WS-JSON onto a DataChannel history stream; `StartSpec.env` over the private socket keeps spawn-time secrets out of `/proc` on the way to E2E `agent.create` |
| **Phase 3** — signed signaling | orthogonal to sessiond (signaling-layer); nothing here assumes server-trusted introductions |
| **Phase 4 / Later** — open source; encrypted transcript backup | worker is self-contained and auditable (`daemon/src/sessiond/` has no control-plane deps); device-key-sealed backup slots in as a separate artifact per §7 |

## 15. Known gaps / future work

- **Backpressure** (§9): bounded per-viewer sinks + replay-based catch-up.
- **History over DataChannel** (Phase 2): move `agent.snapshot`'s base64-WS
  leg onto a DataChannel stream; the replay watermark already supports it.
- **spawnd-side plaintext hygiene**: extend zeroize discipline into the
  outbox/forwarder if profiling shows the buffers are long-lived.
- **Replay-fidelity conformance test** (§13): grid-diff live vs replayed
  streams via the harness.
- **Worker resource limits**: per-worker RLIMIT/cgroup knobs if agents start
  sharing hosts with untrusted workloads (out of scope for the current
  single-user host model).
- **`spawnd status` integration**: list worker-backed agents with pid/state
  from `Hello` without attaching.
