# sessiond — replacing tmux with purpose-built session workers

**Status: implemented as the mandatory backend; cutover review pending.**
`spawn-worker` plus `spawnd` supervision is the only production session path.
There is no backend selector, per-agent escape hatch, or fallback. The accepted
cutover boundary and old-session drain procedure are in
[TMUX_REMOVAL.md](TMUX_REMOVAL.md). Where this document and code drift,
`daemon/src/sessiond/` and `daemon/src/worker_backend.rs` are authoritative.

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

1. **The agent terminal path is endpoint-owned at the P2-AGENT-02
   implementation checkpoint** (review pending; TRUST.md). The worker protocol stays on a Unix
   socket in a `0700` directory, and the browser's low-latency copy travels over
   mandatory WebRTC DataChannels. `spawnd` sends only content-free activity and
   signaling/lifecycle JSON over its server control socket.
2. **User-facing terminal rendering lives in the browser.** xterm.js in
   `web/` owns the grid a human sees. The worker also holds a *headless
   emulator* (`sessiond/emulator.rs`, alacritty's `Term` core plus an owned
   ANSI serializer) fed from the PTY read path. Its current primary and
   alternate-screen grids are plaintext state resident for the worker's
   lifetime, bounded by the active terminal geometry plus a bounded history
   drain window. It synthesizes the live-screen repaint served with every
   replay and decides which lines commit to history; it never transforms the
   live forwarded bytes. This is a deliberate revision of the original
   "workers are byte pipes" rule: the byte-pipe design needed a SIGWINCH
   jiggle to provoke checkpoint repaints from the app, which disturbed the
   agent, stacked duplicate frames into scrollback on every rotation, and
   made checkpoint quality depend on each app's WINCH behavior. The
   emulator's fidelity is a tested contract (`feed → serialize → re-feed ⇒
   identical state`), not an assumption.
3. **Raw PTY bytes in the live path; committed lines in the history path.**
   Live output is forwarded byte-for-byte, unparsed. History is NOT the byte
   stream: raw TUI bytes are a rendering protocol, not a document, and
   re-executing them can never yield faithful scrollback (intermediate
   repaint frames, resize reflow). Instead the emulator commits each line
   exactly once — at the moment it scrolls off the screen — serialized as
   styled text, and only those committed lines are logged. Replay is
   "committed history + a freshly synthesized screen repaint."
4. **One process per agent.** Crash isolation, per-agent keys, per-agent
   lifecycle, no shared mux server.
5. **Honest crypto claims.** Encrypted-at-rest scrollback protects the segment
   files. It does not mean "encrypted before DRAM": the PTY path, emulator
   grid, committed-line serialization, replay, and forwarding all require
   plaintext in host memory (§6.3).

## 3. Process model

```
spawnd (host supervisor, one per host)
 ├── ws/rtc: content-free signaling/lifecycle; WebRTC peer connections
 ├── worker_backend: launch / adopt / signal workers
 │
 ├── spawn-worker --agent-id A … (one process per agent, own process group)
 │    ├── owns the PTY master (portable-pty)
 │    ├── agent process (session leader on the PTY slave)
 │    ├── headless emulator (grid state + bounded history drain window)
 │    ├── encrypted scrollback log (ChaCha20-Poly1305, segmented)
 │    ├── lifetime flock: $WORKER_DIR/<agent-id>.lock
 │    ├── supervisor listener: $WORKER_DIR/<agent-id>.sock
 │    └── lifecycle datagram: $WORKER_DIR/<agent-id>.lifecycle.sock
 └── spawn-worker --agent-id B …
```

- **spawnd stays the host supervisor.** It owns the control-plane connection,
  WebRTC, and agent registry. It launches workers, adopts orphaned ones, routes
  input/output, and reaps exits.
- **`spawn-worker`** (`daemon/src/bin/spawn-worker.rs`, logic in
  `daemon/src/sessiond/worker.rs`) is one process per agent. It binds its
  socket, waits for `Start`, spawns the agent argv on a PTY it owns
  with portable-pty,
  and from then on: streams output, accepts input/resize, maintains the
  scrollback log, serves replay.
- The worker is spawned with `process_group(0)`: its fate is tied to the
  agent (it holds the PTY master), **not** to spawnd. spawnd dying, being
  upgraded, or being restarted leaves workers and their agents running.
  Deployment note: under systemd, spawnd's unit needs `KillMode=process`
  or workers get killed with the cgroup on `systemctl restart`.
- Worker runtime cost is scoped per agent: a tokio runtime pinned to 2 threads,
  two blocking PTY I/O threads, and headless primary/alternate screen grids
  whose size follows the current terminal geometry. It does not retain a
  session-length plaintext grid history.

### Filesystem layout

`worker_dir()` resolves `$SPAWND_WORKER_DIR` → `$XDG_RUNTIME_DIR/spawn/workers`
→ `<config_dir>/workers`, created `0700`:

```
workers/
  <agent-id>.lock          # lifetime exclusive reservation (0600)
  <agent-id>.sock          # ordinary supervisor listener
  <agent-id>.lifecycle.sock # atomic fixed-size TERM/KILL datagrams
  <agent-id>.scrollback/   # 0700; seg-00000001.log … (ciphertext only, 0600)
```

The directory is ownership-checked and forced to `0700`; failure is fatal.
Both sockets and the reservation are ownership-checked and forced to `0600`.
`spawnd` acquires the per-agent flock before it spawns a worker and exposes the
locked fd only in that post-fork child. The worker holds it for its lifetime.
Duplicate creates therefore fail before a second worker is spawned. A lock
released by a crash authorizes stale-socket recovery; no code unlinks an
endpoint while the lock says a worker may still own it. Each endpoint cleanup
also compares the socket's recorded device/inode identity, so a delayed old
cleanup cannot unlink a replacement at the same pathname.

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
JSON; hot-path payloads are raw bytes. `PROTO_VERSION = 5`, checked at
adoption time from `Hello.version` — a version-skewed worker is refused, not
guessed at.

| Type | Dir | Payload | Purpose |
|---|---|---|---|
| `T_HELLO` 0x01 | w→d | JSON `{version, agent_id, instance_id, state, pid?, cols, rows, cwd?}` | first frame on **every** accepted connection; enables stateless adoption, binds lifecycle to this exact worker instance, and in v5 retains the canonical absolute cwd capability required by direct agent uploads |
| `T_START` 0x02 | d→w | JSON `{cwd, argv, env, cols, rows}` | spawn the agent. Env goes over the private socket, not argv, so secrets never appear in `/proc/*/cmdline` |
| `T_STARTED` 0x03 | w→d | JSON `{pid}` | agent is running (the **real** agent pid, unlike the tmux backend's attach pid) |
| `T_OUTPUT` 0x04 | w→d | `watermark u64 LE ‖ raw bytes` | live PTY output with the same durable producer coordinate used by replay |
| `T_INPUT` 0x05 | d→w | raw bytes | PTY stdin |
| `T_RESIZE` 0x06 | d→w | `cols u16 LE, rows u16 LE` | PTY resize (kernel sends SIGWINCH); lines displaced by a narrowing reflow commit to history |
| `T_REDRAW` 0x07 | d→w | empty | obsolete (ignored by workers; reserved — see §8.2) |
| `T_REPLAY_REQ` 0x08 | d→w | `max_bytes u32 LE` | request decrypted scrollback |
| `T_REPLAY` 0x09 | w→d | `watermark u64 LE ‖ raw bytes` | self-describing v2 replay: geometry marker + history sentinel + committed lines, then geometry marker + live screen repaint (§8.1); watermark = cumulative lifetime PTY output bytes at capture, including output never committed to history |
| `T_EXIT` 0x0A | w→d | JSON `{exit_code?, signal?}` | agent exited |
| `T_SHUTDOWN` 0x0B | d→w | JSON `{signal?: TERM\|KILL}` | compatibility command; current spawnd lifecycle delivery uses the independent endpoint below |
| `T_ERROR` 0x0C | w→d | JSON `{message}` | recoverable command failure |

Connection semantics: the worker serves **one live supervisor connection**.
It validates the candidate peer's effective UID and sends that candidate its
`Hello`; only then does it close the old writer, abort and await the old reader,
and install one new reader. Thus only one task/fd can feed the bounded command
queue. Generation tags also discard anything the old peer queued immediately
before cancellation. A restarted spawnd connects and wins without leaving a
stale reader able to flood the worker. `spawnd` verifies that
`Hello.agent_id` matches the agent implied by the socket path before trusting
the instance token. Unknown frame types are rejected. The five-byte header is
parsed before allocation and a strict per-type cap is applied (`T_INPUT` is at
most 64 KiB; fixed commands require their exact size); a command never inherits
the generic 32 MiB replay ceiling.

Lifecycle timers: a worker that never receives `Start` exits after 120 s; a
worker whose agent exited lingers 60 s to deliver `T_EXIT` to a reconnecting
spawnd, then cleans up regardless. On exit the worker deletes its scrollback
(the key dies with it anyway), unlinks its socket, and terminates.

The lifecycle socket is a separate adoptable **Unix datagram** IPC path, not
another command in the ordinary frame queue. A request is one atomic datagram
of exactly 17 bytes: the 16-byte random `Hello.instance_id` plus a one-byte
`TERM`/`KILL` enum. The worker replies with one content-free status-byte
datagram only after the signal syscall. It rejects stale instance IDs, unknown
codes, and non-exact datagrams. There are no accepted stream fds or per-request
tasks for partial peers to retain: one task, one fixed 18-byte receive buffer,
and the bounded kernel datagram queue are the complete server-side resource
surface. The client retries idempotent delivery within one absolute two-second
deadline, so a datagram flood cannot reserve all lifecycle capacity. The worker retains the
unreaped portable-pty `Child` handle behind the same lock used by its exit
monitor; while holding that stable ownership it validates the child and calls
`killpg` only. `ESRCH` means safely gone. There is deliberately no fallback to
`kill(pid)`, so PID reuse can never redirect a delayed request.

## 5. Data path — where bytes flow, who can read them

```
agent process
  │ PTY slave → kernel → PTY master (plaintext, kernel buffers, user's host)
  ▼
spawn-worker: read buffer ── encrypt → scrollback log (ciphertext, disk)
  │                └─ zeroized after each hop
  ▼ T_OUTPUT (unix socket, 0700 dir, same host)
spawnd: bounded per-agent outbox → forwarder ──→ DataChannel direct sinks
  ▼ WebRTC DataChannel (DTLS, peer-to-peer; TURN sees ciphertext)
browser: xterm.js — the user-facing terminal renderer and scrollback owner
```

`pty::run_forwarder` and `ForwarderControl` provide bounded outbox → direct-sink
routing. `AgentHandle` has one implementation: `write_stdin`, `resize`, and
`replay` dispatch bounded `WorkerCmd`s over the worker socket. Shutdown binds a
short-lived `0600` datagram endpoint in the same private directory and sends to
the separate worker-owned lifecycle socket with the instance ID captured from
the same `Hello`; one absolute deadline covers validation, fixed-size delivery,
retries, and acknowledgement. It therefore cannot sit behind queued or
partially written PTY input. Registry delivery also revalidates the immutable
generation+lifecycle pair while holding the generation-transition lock.
Restart checks TERM delivery and deterministically escalates to KILL. `spawnd`
does not hold a local agent PTY, a child process handle, or a backend
discriminator.

The Unix-socket hop adds no control-plane exposure. P2-AGENT-02 removes daemon
WS terminal binary frames, browser relay/history/snapshot frames, transcripts,
and content pubsub. `spawn.ctl` replay carries a stream-position watermark
directly to the browser. This agent cut does not make all of Phase 2 true:
uploads, host operations, launch manifests, error detail, historical purge,
and the final audit remain separate tracked tasks.

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
- **Kinds**: `HISTORY` (a batch of committed scrollback lines, serialized as
  self-contained styled text; §8.1). An app-driven scrollback wipe (`ED 3`)
  is not a record at all — it physically unlinks every retained segment
  (`truncate_all`), so cleared history stops existing on disk. The seq
  counter never resets across truncation, so nonces cannot repeat.

### 6.2 Encrypt-on-read, bounded growth

Each output chunk is fed into the emulator; the lines it commits are
encrypted before any scrollback write. The worker subsequently forwards the
same plaintext chunk live and wipes its owned buffers. This is an
encrypt-before-disk property, not encryption at the PTY/DRAM boundary.
Plaintext is never written to segment files (unit-tested by grepping them for
a marker; `plaintext_never_hits_disk`).

Growth is controlled by two knobs. `--segment-bytes` defaults to 256 KiB of
additional charged record bytes per segment before rotation
is due. `--max-log-bytes` defaults to an 8 MiB conservative total scrollback
resource budget. Operators/tests may lower that value; values above the
compiled 8 MiB upper bound are rejected. The charge includes exact retained
ciphertext and record framing, twice each segment's replay representation (one
returned buffer plus one decryption/framing scratch allowance), and the log's
retained `Vec`/path bookkeeping, actual allocated file/directory blocks with
safe floors, and conservative inode/directory-entry overhead. A hard 128-file
cap plus ring-reused filenames bounds live inodes and directory growth under
one-byte-output/resize adversaries. Before admitting a record the log removes
whole oldest segments; it never returns a partial segment. A record that
fails conservative preflight is rejected before its file is created. If an
append or rotation cannot preserve those invariants, the worker destroys and
disables its replay log but continues live output; subsequent replay is
unavailable rather than partial or over-budget.

The 8 MiB value is therefore neither "8 MiB of plaintext output" nor an exact
measurement of process RSS. It is a hard ceiling on this deliberately
conservative charge model, including grid/line serialization in replay
form and bounded transient replay plaintext. The live emulator grid is a
separate, geometry-bounded resident allocation (§6.3). The `spawn.ctl` layer
also retains its independent 12 MiB response rejection ceiling.

### 6.3 Memory hygiene — what is and isn't guaranteed

`daemon/src/sessiond/secret.rs` (`SecretBytes`):

**Covered:**
- Key bytes are generated from `getrandom`, held in heap pages that are
  `mlock(2)`ed (no swap) and `MADV_DONTDUMP`ed (no core dumps, Linux), and
  **zeroized on drop**. mlock failure (e.g. `RLIMIT_MEMLOCK=0` containers) is
  logged, not fatal: the at-rest encryption stands; only the key's
  swap-residency guarantee weakens.
- Owned plaintext is explicitly wiped on drop across the implemented handoff:
  worker PTY read chunks and reader/writer scratch, queued input and worker
  frame payloads, serialized committed lines, and worker replay buffers. spawnd's
  replay result owns a self-wiping payload even while parked in a oneshot; its
  source bytes wipe on receiver cancellation and normal consumption.
  DataChannel input is copied into the self-wiping worker-input wrapper.
  `OutputChunk`, control output, and direct-viewer payloads likewise wipe on
  drop; their queues are bounded.

**Not covered — stated plainly, per TRUST.md's "honest inventory" ethos:**
- Plaintext **must** transit worker memory: kernel PTY buffers → userspace
  read buffer → AEAD input. There is no such thing as "encrypted before
  DRAM" on this path, and we do not claim it.
- The headless emulator retains semantic plaintext for the current primary and
  alternate screen, cursor, modes, and auxiliary terminal state for the
  worker's lifetime. That state scales with terminal geometry and has no deep
  history, but it is not transient. A serialized line batch and decrypted
  replay are additional transient plaintext buffers. The scrollback admission
  charge accounts conservatively for retained disk records, the returned
  replay, and decryption/framing scratch within its 8 MiB default; the
  control-channel response ceiling is an independent outer bound.
- Kernel-side copies (PTY line discipline, unix socket buffers) and copies
  inside webrtc/DTLS layers in spawnd are outside our control.
- spawnd still handles plaintext in flight (worker socket → bounded outbox →
  DataChannel). The outbox, worker-command channel, direct-viewer queues, and
  control responses are bounded; a lagging direct viewer is detached, and
  reconnect catch-up comes from worker replay. Owned queued payloads wipe on
  drop. Copies inside kernel unix/WebRTC/DTLS stacks are not owned or wiped by
  this code, so this is not a claim of complete system-wide zeroization.
- The guarantee here is **ciphertext-only scrollback segment files on the
  user's own host**, with best-effort wiping of transient buffers — not the
  absence of plaintext host memory. The threat this addresses is *disk*
  residue (backups, stolen disks, forensic carving, swap, core dumps), not a
  live root-level attacker on the host, which TRUST.md places out of scope (a
  compromised host sees everything regardless).

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
| Sealed to browser device keys (Phase-3 WebCrypto identities) | yes | nothing on the host can read it — including the worker | pub-key registry only | the strongest story ("host stores what only your devices can open") but the worker could no longer *serve* replay; replay/serialization logic would move client-side, multi-device needs key-wrapping fan-out. This is the TRUST.md "client-side-encrypted transcript backup" (Later) item, not the live-session log |

The live-session log exists to serve reattach while the agent is alive; the
ephemeral key covers exactly that lifetime with the smallest possible surface.
When TRUST.md's optional encrypted transcript backup lands, it should be a
*separate* artifact sealed to device keys, not a repurposing of this log.

## 8. Reattach and replay

### 8.1 Committed-line history

History is owned by the emulator, not reconstructed from bytes. A line is
**committed exactly once, at the moment it scrolls off the top of the
screen** (alacritty's grid provides the semantics: full-screen scrolls and
top-anchored regions rotate lines into grid history; `ED 2` scrolls the
viewport into history, VTE/kitty-style). After every feed stride the worker
drains those lines — serialized as self-contained styled text: SGR runs +
glyphs, `\r\n` per hard line end, soft-wrapped rows painted edge-to-edge with
no break so logical lines re-wrap at the consumer's width — and appends them
encrypted (`HISTORY` records). In-place TUI repaints never scroll, so they
never commit; a resize cannot retroactively reflow committed lines (narrowing
commits the displaced rows once, widening finds an empty drain window and has
nothing to un-commit); `ED 3` (`/clear` in claude/codex emits `2J 3J H`)
physically truncates the log (`scrollback_wipe_erases_replayed_history`).
Segment rotation is purely a storage/eviction concern — **the agent process
is never signaled, resized, or otherwise disturbed by it**
(`scrollback_rotation_must_not_disturb_the_agent`).

Replay concatenates the newest run of whole segments whose plaintext fits the
caller's `max_bytes` (failing closed rather than splitting a segment), then
the worker frames the response as a **self-describing v2 stream**:

```
CSI 8 ; rows ; cols t   APC "sp:h1" ST   <committed lines…>
CSI 8 ; rows ; cols t   <emulator-serialized live screen repaint>
```

Both markers carry the *current* geometry; the history section is
geometry-free flowing text. The screen repaint is synthesized from the live
emulator at request time (idempotent: full-row painting, no ED), so the
final chunk alone reconstructs the current screen — the browser's live
terminal is still **seeded from the final chunk with zero resize calls**.
The scrollback overlay, on recognizing the APC sentinel
(`parseHistoryReplay` in `Terminal.tsx`), writes the history as flowing text
at its own width (never geometry-walked, so nothing already rendered ever
reflows), scrolls the occupied viewport rows into the scrollback region, and
paints the screen chunk below. Clients without the sentinel fall back to the
legacy chunk walk; replays from pre-v2 workers (which persist across
upgrades) still parse via the same marker framing.

Two prior designs were retired. Checkpoint markers + SIGWINCH jiggle
duplicated full frames in scrollback on every rotation and left replay
quality dependent on app WINCH behavior. Its replacement — raw-byte segments
opened by emulator-serialized checkpoints — fixed the jiggle but kept
re-executing the byte stream to rebuild history, which pushed intermediate
repaint frames into the overlay's scrollback and reflowed (mangled) TUI rows
at every geometry transition. Committed lines fix the class: history is a
document written once, not a render re-run.

### 8.2 The emulator

`sessiond/emulator.rs` wraps alacritty_terminal's `Term` (grid history is
enabled but used only as a bounded drain window — `feed_output` serializes
and clears it every stride; deep history lives in the encrypted line log)
plus a shadow handler on a second vte parser for the states `Term` keeps
private (margins, charsets). `serialize()` emits an ANSI stream
reconstructing cells, attributes, hyperlinks, wide/combining chars, cursor
(including pending wrap), margins, modes, charsets, cursor style, and palette
overrides — for both screens when the alternate screen is active — including
the DECSC saved-cursor register, which Ink renderers (claude, codex) rely on
around every frame. A byte-exact cross-chunk scanner detects `ED 3`
(`CSI 3 J` / `CSI ? 3 J`) and surfaces it as a truncate event ordered into
the commit stream. The fidelity contract (`feed → serialize → re-feed ⇒
identical state`) is enforced cell-by-cell by the module's unit tests, and
end-to-end by `replay_reconstructs_the_live_screen_across_rotations`, which
renders the live byte stream and the replay through two emulators and
requires identical
screens. `T_REDRAW` is obsolete and ignored by workers: snapshots synthesized
from the emulator already carry cursor and modes, so there is nothing left to
provoke.

### 8.3 Replay and viewer seeding

`T_REPLAY_REQ(max_bytes)` → `T_REPLAY(watermark ‖ bytes)`. The watermark is
the cumulative lifetime count of output bytes logged at capture time; it is a
monotonic source coordinate, not the size of the retained replay tail. spawnd's
snapshot handler (`handle_agent_snapshot`, worker branch) samples the
requesting viewer's DataChannel byte offset *before* issuing the replay;
because the worker logs before forwarding, everything counted at that offset
is guaranteed to be covered by the replay, and the browser can drop already
seen live bytes deterministically using `dc_offset`.

`spawn.ctl` history/snapshot exposes this as styled terminal replay only:
clients send `plain:false`. A `plain:true` request fails closed with
`plain_replay_unsupported`; ANSI replay bytes are never mislabeled
as plain text.

Replay correctness (PTY in → bytes out → reattach replays both the initial
output and mid-session stdin echo) is asserted end-to-end in
`daemon/tests/worker_e2e.rs` against a real `/bin/sh` on a real PTY, and
through the full spawnd plumbing (forwarder, direct sinks, adopt path) in
`worker_backend::tests::worker_launch_adopt_and_priority_shutdown_roundtrip`.

## 9. Resize, flow control, multi-viewer

**Resize.** `AgentHandle::resize` dedupes unchanged geometry (as today) and
sends `T_RESIZE`; the worker applies it to the PTY master and the emulator,
committing any lines a narrowing reflow displaces. Resize *authority* is
negotiated endpoint-to-endpoint over `spawn.ctl`: the daemon's display-control
hub designates one
controlling viewer whose geometry drives the session while other viewers dim
without sending geometry or viewer timing through the application server. The
worker therefore stays a single-size PTY and needs no multi-size machinery.

**Multi-viewer.** Fan-out happens in spawnd's forwarder via per-viewer
DataChannel direct sinks: every viewer gets the same raw byte stream, and input
is accepted from whichever peer the control model lets type. There is no
daemon-side copy-mode or per-keystroke subprocess check. Client-side
scrollback/selection lives in xterm.js.

**Flow control / backpressure — current, honest status.** The PTY reader's
handoff to the worker loop holds at most eight queued chunks of at most 8 KiB
each. The worker logs and forwards each chunk it consumes. If the supervisor
socket stalls, those eight slots fill, the PTY reader blocks, and the kernel
PTY backpressures the agent instead of accumulating an unbounded worker `Vec`
queue. Downstream, spawnd holds at most 32 worker-output chunks and 32 ordinary
worker commands; each input command is capped at 64 KiB before spawnd copies
the caller's slice. The worker's separate lifecycle datagram endpoint accepts
only one atomic fixed 17-byte request into one fixed buffer and is independent
of the ordinary socket task, so TERM/KILL cannot be starved by the ordinary
queue, partial stream peers, or a stalled worker socket. The forwarder serves
only bounded direct-viewer sinks; a lagging viewer is disconnected instead of
accumulating plaintext. A new direct connection re-seeds from the worker replay
watermark. The replay log uses the conservative total resource budget
described in §6.2, including checkpoint and framing charges.

## 10. Crash isolation, restart, upgrades

| Event | Outcome |
|---|---|
| **Agent exits** | worker reports `T_EXIT` (real exit code), destroys its scrollback, identity-checks and unlinks both sockets, releases its lifetime lock, and exits; spawnd forwards `agent.exit`. If spawnd is down at that moment, the worker lingers 60 s so a restarted spawnd can collect the exit. |
| **Worker crashes** | the agent dies with it (it held the PTY master) — identical blast radius to "tmux server crashed" but scoped to **one** agent instead of every agent on the host. spawnd's connection reader reports `worker_lost`. The kernel releases the lifetime flock; the next launch, or a failed adoption that can acquire that lock, ownership-checks and removes the crashed worker's stale endpoints. Restart policy stays where it is today (user-driven `agent.restart`), which for agentic CLIs is the honest choice — blind auto-respawn of a stateful agent process is not a recovery. |
| **spawnd restarts / upgrades** | workers keep running (own process group). On startup `rediscover_existing_agents` scans the socket dir (`discover_ids`), connects, verifies `Hello.agent_id`, and adopts from the `Hello` (instance identity, state, pid, geometry), then derives the independent lifecycle socket — no persistent supervisor state. The same lazy adoption path (`ensure_agent_attached`) recovers an agent on first use if startup discovery raced. A reconnect displaces no agent state; viewers re-seed from emulator-synthesized snapshots on demand. |
| **spawnd upgrade + protocol change** | `Hello.version` gates adoption; private worker protocol version 5 additionally requires the worker's retained canonical cwd capability root for direct agent uploads. A mismatched or cwd-less worker is left untouched (its agent keeps running) and surfaced in logs rather than driven with a protocol it doesn't speak or falling back to a server upload path. Old workers drain away as their agents exit. |
| **Worker binary upgrade** | applies to newly launched agents only; running workers are never hot-swapped. `worker_bin()` resolves `$SPAWND_WORKER_BIN` → sibling of the running spawnd binary → `PATH`. |
| **Host reboot** | workers and agents die. Runtime-dir sockets/ciphertext evaporate with tmpfs. |

The only launch-time fd inheritance is the already-locked reservation, exposed
to that one post-fork child and immediately restored to close-on-exec inside
the worker. PTY and socket fds are never handed off: the **worker** owns them
and survives on its own. Adoption-by-reconnect has no listener handoff window.

## 11. Worker-only cutover

P2-TMUX-01 is the hard cutover, not a default flip. The daemon module,
subprocess calls, selector and escape hatch, creation/attach/discovery,
capture/repaint/copy-mode behavior, session label, and exact replay buffer are
removed. Agent restart performs escalating TERM→KILL through the worker before
creating a replacement; startup discovery scans worker sockets only.

A live pre-cutover session cannot be adopted or transformed into a worker
without unsafe content/state handling. Operators close ingress and drain it
before installing/restarting the worker-only build. If one remains, the daemon
fails it unavailable. This code change itself performs no deployment, signal,
or purge. Rollback cannot restore the retired content path; remediation rolls
forward with a corrected worker-only build. See [TMUX_REMOVAL.md](TMUX_REMOVAL.md).

The server/API/web `tmux_session` field and `agent.rename` frame are removed in
the same checkpoint. They are absent from daemon runtime structs as well.

## 12. Prior art

| | shpool (Google) | wezterm-mux-server | zellij server | **spawn-worker** |
|---|---|---|---|---|
| Language | Rust | Rust | Rust | Rust |
| Model | one daemon, N named sessions | one mux server, own client protocol | one server per session group, plugin runtime | **one process per agent** |
| Server-side emulation | minimal (keeps a restore buffer; explicitly *not* a multiplexer) | full (termwiz grid; clients render grid deltas) | full (its own grid + layout engine) | **headless checkpoint emulator only (alacritty core, plaintext current-screen grids); live path is raw bytes, user-facing rendering is xterm.js** |
| Reattach story | replays restore buffer | grid sync | grid sync | encrypted geometry-tagged byte replay opening with an emulator-serialized checkpoint (the iTerm2 restoration model, encrypted at rest) |
| Scrollback at rest | plaintext in memory | plaintext (grid) | plaintext (grid) | **ChaCha20-Poly1305 on disk, ephemeral key; transient owned replay buffers wiped, plaintext current grids disclosed above** |
| Crash blast radius | all sessions in daemon | all clients of the mux | session group | one agent |
| Remote transport | ssh | ssh/TLS, own protocol | ssh | WebRTC DataChannel (already existed; unchanged) |

shpool is the closest relative — it also concluded that "session persistence
without a multiplexer" is the right shape, and its restore-buffer replay is
the plaintext cousin of our checkpoint replay. We diverge where the operator
model demands it: per-agent process isolation, encryption at rest, and keeping
the worker's plaintext grid state to the current checkpoint screens rather
than a user-facing or deep-history multiplexer. wezterm/zellij solve a
different problem (rich multiplexing UX) with a server-side renderer in the
live path — exactly what §1 is eliminating.

## 13. Testability

The browser is the only user-facing terminal renderer, while the worker has a
headless checkpoint emulator (§2). Terminal-correctness testing therefore
splits into two independently-testable layers:

**Byte-transport correctness (this design).** The worker/backend guarantee is
byte-exactness, tested without any emulator: wire framing round-trips and
limits (`sessiond::wire` tests), crypto/log properties — plaintext never on
disk, tamper fails closed, budget enforcement, replay coherence
(`sessiond::scrollback` tests), memory hygiene (`sessiond::secret` tests),
and end-to-end PTY-in/bytes-out/reattach-replay through a real shell
(`daemon/tests/worker_e2e.rs`) and through the full spawnd plumbing
(`worker_backend` roundtrip test). `cargo test` in `daemon/` runs all of it
without network or browser dependencies.

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
harness's differ unmodified. A Rust-side version of that property already
runs in `worker_e2e.rs` (`replay_reconstructs_the_live_screen_across_
rotations`, diffing through the sessiond emulator); the xterm.js-side
integration is future work in `tools/term-conformance` territory and should
reuse its runner. The checkpoint emulator itself is a natural additional SUT
for the corpus: xterm.js(serialize(emulator(case))) ≡ xterm.js(case).

## 14. TRUST.md phase mapping

| TRUST.md phase | sessiond contribution |
|---|---|
| **Phase 1** (shipped) — DataChannel-only PTY | worker backend removed tmux as a plaintext holder; P2-AGENT-02 now removes the legacy server mirror at its review-pending implementation checkpoint |
| **Phase 2** — endpoint-owned data, server stores deleted | scrollback/history/snapshot are worker-owned encrypted artifacts with watermarked replay over `spawn.ctl`; `StartSpec.env` over the private socket keeps spawn-time secrets out of `/proc`, while later tasks must still make launch and host paths E2E and purge historical copies |
| **Phase 3** — signed signaling | orthogonal to sessiond (signaling-layer); nothing here assumes server-trusted introductions |
| **Phase 4 / Later** — open source; encrypted transcript backup | worker is self-contained and auditable (`daemon/src/sessiond/` has no control-plane deps); device-key-sealed backup slots in as a separate artifact per §7 |

## 15. Known gaps / future work

- **Backpressure follow-up** (§9): Phase 2 uses bounded per-viewer sinks,
  disconnect-on-stall and replay-based catch-up; future work may add adaptive
  queue sizing and transport telemetry.
- **History over DataChannel review** (Phase 2): `spawn.ctl` carries
  worker-backed connect history and snapshots using request-bound chunks
  and explicit PTY byte anchors; the legacy base64-WS leg is removed in the
  P2-AGENT-02 implementation and independent review remains.
- **Replay-fidelity conformance test** (§13): grid-diff live vs replayed
  streams via the harness.
- **Worker resource limits**: per-worker RLIMIT/cgroup knobs if agents start
  sharing hosts with untrusted workloads (out of scope for the current
  single-user host model).
- **`spawnd status` integration**: list worker-backed agents with pid/state
  from `Hello` without attaching.
