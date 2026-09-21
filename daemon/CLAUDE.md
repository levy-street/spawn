# Working agreements for daemon/

Rust. Two binaries: `spawnd`, the supervisor that dials out to the spawn
server and registers the host, and `spawn-worker`, which owns one session's
PTY and survives spawnd restarts. `AGENTS.md` beside this file is a symlink to
it.

## Layout

```
src/
  main.rs        the spawnd binary; the module list lives here
  lib.rs         the deliberately small public surface (endorsements,
                 sessiond, signed_signal, secret_file, permissions, …) shared
                 with spawn-worker, the desktop app, tests, and browser golden
                 vectors — everything else stays private to the binary
  permissions.rs the one macOS consent moment, and the on-disk handshake the
                 desktop app uses to put a screen in front of it
  secret_file.rs how a secret is put on disk: atomic current-user-only write
                 (0600 on Unix, a protected owner-only DACL on Windows), owner
                 and permission checks through a no-follow handle, and a
                 cross-process lock. Used by creds.rs here and by the desktop
                 app's storage.rs, which keeps a different record under
                 identical handling
  bin/           spawn-worker.rs and cross-runtime-crypto.rs (vector
                 generator)
  platform/      OS leaf operations shared by daemon features: private files,
                 atomic moves, executable names, console modes, browser launch,
                 process liveness, and file identity
  sessiond/      supervisor↔worker shared pieces: wire protocol, terminal
                 emulator, scrollback, worker runtime
    endpoint/    platform transport boundary: mod.rs is the common facade,
                 unix.rs owns stream/datagram sockets, and windows.rs owns
                 named pipes plus reservation-handle transfer
  install.rs     the installed layout: the immutable release store, which
                 release each instance runs, the command on PATH, adopting a
                 legacy launch, and collecting releases nothing runs — see
                 "Where a daemon's binaries live"
  <feature>.rs   one module per concern: run.rs (register + main loop),
                 rtc_pair.rs (shared device connections and session-channel admission),
                 ws.rs, update.rs + update_io.rs (verified daemon self-update;
                 focused tests live in update_tests.rs), release_key.rs (pinned
                 release trust roots), login.rs, creds.rs, rtc.rs, host_*.rs,
                 upload.rs, sessions.rs, service.rs + service/ (launchd/systemd
                 dispatch, Windows Task Scheduler/Run watchdog and control
                 pipe), …
  tui.rs         shared TTY/NO_COLOR presentation: the live step frame
                 (`Ui`), panels, logo, and the single-line `Spinner`
  state.rs       atomic local daemon heartbeat contract (`state.json`)
  status.rs      human/JSON status across local account instances, each
                 described by the daemon running for it, never by the command
  doctor.rs      the ordered 15-check local health report, per instance, plus
                 the Windows agent-shell dependency diagnostic
  lifecycle.rs   reconnect, disconnect, logout, and local reset commands
  version.rs     the version the daemon reports; build.rs stamps the source
                 commit into it (0.1.0+g<commit>)
Info.plist       the sentences macOS prints in its consent dialogs; build.rs
                 links it into both binaries' `__TEXT,__info_plist` section
tests/           integration tests (worker_e2e.rs), and
                 xterm_checkpoint_proof.js, the headless xterm.js driver the
                 emulator's unit tests run against the web workspace's
                 `@xterm/xterm`. `SPAWN_XTERM_JS` names the bundle and makes
                 the proof required (scripts/test-all.sh sets it); unset, the
                 sibling web/node_modules is used when present and the test
                 skips otherwise
examples/        golden-vector generators for proto/
vendor/          exact upstream crate sources for narrowly documented patches;
                 currently webrtc-sctp 0.17.2 plus the #822 re-admission fix,
                 a read/reset missed-notification fix, and closing the
                 association closing its pending queue (a writer waiting on a
                 silent peer gets `ErrStreamClosed` instead of holding the
                 stream shutdowns, and so the peer connection close, forever),
                 webrtc-ice 0.17.2
                 with temporary UDP route errors treated as datagram loss
                 (ice/PATCHES.md), and webrtc 0.17.2
                 with closed-channel registry pruning (webrtc/PATCHES.md).
                 SCTP and ICE are workspace members so their tests use the
                 daemon's Cargo.lock; webrtc is excluded to avoid resolving
                 its optional OpenSSL features. Native daemon regressions
                 cover its patch; default cargo commands select only spawnd
```

## Where things go

- A new host capability: its own `src/<name>.rs`, registered in `main.rs`.
- Anything both binaries need: `sessiond/`; anything tests or the browser
  need too: the `lib.rs` surface.
- Wire changes: daemon frames must stay compatible with
  `server/spawn_server/ws/daemon.py` — change both sides in the same commit,
  and regenerate the `proto/` vectors when signed material changes. The
  subprotocol name `spawn.control.v3` (`src/ws.rs`) is the compatibility
  contract, not the version: bump it only for a change a daemon speaking the
  old name could not survive, and read "The wire protocols" in
  `docs/RELEASE.md` first — a bump is a fleet-wide cutover with a forced
  release order.

## Platform boundaries and Windows paths

OS syscalls and security policy that a feature module should not have to
understand live in `src/platform/`. Unix implementations preserve the existing
mode, uid, nofollow, terminal, and rename contracts. Windows `unsafe` Win32
calls stay concentrated in `platform/windows.rs`; feature modules operate on
verified files/directories and opaque identities instead of raw handles.

Windows storage is local, not roaming:

- config and the default single instance: `%LOCALAPPDATA%\spawn`
- account instances: `%LOCALAPPDATA%\spawn\<account_id>`
- service state/runtime files: `%LOCALAPPDATA%\spawn\state\<instance>`
- daemon/worker logs: `%LOCALAPPDATA%\spawn\logs\<instance>`
- installed command shims/binaries: `%LOCALAPPDATA%\spawn\bin`
- user-home expansion: `%USERPROFILE%`
- upload and preview staging: unique owner-DACL-protected children below
  `%TEMP%`, held through verified directory capabilities

`SPAWN_CONFIG_DIR` remains an exact override on every OS. Never fall back from
`dirs::state_dir() == None` to `%USERPROFILE%\.local\state` on Windows, and
reserve Roaming AppData for data deliberately designed to roam. Private
Windows directories/files use a protected, canonical current-user-only DACL;
existing objects are validated and never silently repaired, and reparse points
or filesystems where ownership/DACLs cannot be proved fail closed.

Windows worker discovery metadata lives below
`%LOCALAPPDATA%\spawn\state\<instance>\workers`; encrypted scrollback and
detached worker stderr live below
`%LOCALAPPDATA%\spawn\logs\<instance>\workers`. The worker receives the
metadata directory explicitly rather than deriving it from the log path.
Named endpoints are flat owner-only pipes named
`\\.\pipe\spawn-<user-SID>[-<8hex-config-tag>]-<session-uuid>` with `-lc`
for lifecycle delivery. `spawnd` reserves the session with an exclusive file
handle and transfers only that handle plus NUL standard handles to the worker.

Paths sent over daemon frames remain native strings. Windows drive roots
(`C:\`) and UNC roots (`\\server\share\`) are accepted where that feature is
supported, compared case-insensitively for containment, and never converted by
prepending `/`. Upload roots deliberately reject UNC and device namespaces in
the first Windows release because their reparse, identity, hard-link, and
atomic-move guarantees have not been established.

Construct every installed binary name with `std::env::consts::EXE_SUFFIX` via
the platform helpers. Tags precede the suffix: `spawnd.prev.exe`,
`spawnd.tmp.<pid>.exe`, and `spawnd.failed.<pid>.exe`; `spawnd.updating` is data
and has no executable suffix. Do not use `with_extension` for these names.

Windows v1 intentionally does not provide host-side desktop reveal/open,
Quick Look-style preview rendering, or Linux systemd/cgroup CPU focus scopes.
Their advertised capabilities stay false/no-op. These are product limits, not
reasons to make shared file staging, metrics, emulator, or crypto code
Windows-incompatible.

## Terminal output

`tui.rs` has two modes, chosen once from the environment. Rich draws a
fixed-height live region pinned below normal scrollback; plain emits the
`spawn: `-prefixed lines. Which one you get is not a style choice:

- **While a `Ui` is alive it owns stdout.** A bare `println!` alongside it
  lands mid-frame — that is what produced `waiting for approvalspawn: opened
  your browser…`. Inside a ceremony, print with `tui::log_line` (or
  `Ui::log` / `Ui::block`), which queues above the frame instead. Both fall
  back to the identical `spawn: <text>` line when no frame is drawing, so
  call sites need no mode check.
- **Plain output is a contract.** Piped, `NO_COLOR`, CI, and any terminal
  under `tui::MIN_FRAME_COLUMNS` see byte-for-byte what the command printed
  before the frame existed; `login.rs` pins it with tests. Adding a line to
  rich mode is free — changing a plain one is a breaking change.
- **Prompts must degrade to their default.** Under `curl … /install.sh | sh`
  the shell owns stdin, so the installer reattaches the controlling terminal
  (`run_attached`/`exec_attached` in `routes/install.py`) before handing over.
  Where there is no `/dev/tty` — CI, a headless or remote install — there is
  no terminal to prompt, so `tui::press_enter`, `prompt_line`, `prompt_choice`
  and `confirm` all return their default without printing. Never write a
  prompt that blocks when `stdin().is_terminal()` is false.
- **The live region itself never reads a key.** It renders only; prompts are
  separate calls made before or after a frame, never inside one. A prompt does
  move the cursor, though — the terminal echoes the Enter that ends it — so it
  tells the frame with `tui::frame_pushed_down(1)`. Forgetting instead (the old
  `drawn = 0`) left the answered frame stranded on screen while the next one
  printed below it, which is what "the UI gets duplicated" was.
- **A fingerprint shown for comparison uses `login::fingerprint_rows`.** Its own
  line, bold and accented, with air. Set as dim inline prose it reads as a
  serial number to skip — and a check nobody performs is worth nothing.
- **A ceremony ends by releasing the terminal.** `possess` closes with
  `print_possessed`: this window is finished with, the daemon is not, and here
  are the commands to reach it. Without it the live region simply stops moving
  and the reader is left guessing whether it is still working.
- `Ui` is registered process-wide while it lives, so exactly one may exist at
  a time. `Spinner` is for commands with no step list (`doctor`, `update`)
  and owns its single line — `finish` it before printing anything else.

### The ceremony has one shape

A fresh `spawnd possess` or `spawnd login` prints the approval link and offers
Enter to open it when both a terminal and a browser opener are available. With
no terminal but an available opener it opens the browser immediately.
`--no-browser` still prints the link but never launches a browser or offers
Enter; embedders such as the desktop companion use it. When no opener is
available the daemon also renders a QR unless `--no-qr` was given, and `--qr`
forces one. The link carries the host key, so the browser or phone checks the
machine identity itself; there is no pairing code or terminal fingerprint to
compare.

## Where a server URL comes from

One command, one server. `possess` resolves it once and everything downstream
uses that value:

- **Whoever named an origin decides the default.** `install.sh` bakes the
  origin its one-liner was fetched from into `--server`, and running that
  command *is* the choice — so it leads the prompt and Enter accepts it, with
  spawnd.dev beside it. Only when nothing named a server does the hosted
  service lead and "Host yourself" ask for a URL. `server_offer` makes that
  decision without touching the terminal, so every branch has a test.
- **Offer the action, do not print the command.** Where there is a terminal,
  anything the daemon could do for the reader is a `prompt_choice` row they
  arrow to and press Enter on — not a sentence ending in something to copy.
  They are already in front of the program that can do it, and a named command
  often does not even match how they arrived (an install one-liner takes
  `sh -s -- --new-account`, never `spawnd possess --new-account`). So
  "already possessed here" is a menu — keep it, approve a new browser, add
  another account, check for an update — and each row performs the thing.
  Non-interactive installs never see it and keep resuming, because a re-run of the
  same command with nobody watching should be a no-op. Build such a menu from a
  pure `*_options`/`*_choice` pair so the rows can be tested without a keyboard;
  `possess::resume_action` is the pattern.
- The answer `choose_server` returns is passed to `login::run_with_ui`, not the
  raw `--server` argument. Registering against one origin while installing a
  service for another produces a daemon that cannot start.
- `service::install` writes the unit for the origin in the instance's
  `credentials.json`, whatever the caller passed. `spawnd run` refuses to start
  when its `--server` disagrees with the stored origin, so a unit built from
  any other value is a service that boots, exits 1, and is restarted for ever
  — while the terminal has already said "possessed" and the web app waits at
  Online for a machine that can never connect. Reach for `registered_server`
  rather than trusting a caller.

To look at the frame without running a ceremony:

```bash
script -q /dev/null cargo test --bin spawnd render_demo -- --ignored --nocapture
```

## What macOS asks, and when

The daemon reads the home directory, so macOS gates Desktop, Documents and
Downloads — and it asks the *responsible* process, which is `spawnd` even when
the thing that touched the file was an agent someone started in a session. That
is not avoidable. Three rules keep it from reading as an app grabbing at things:

- **`Info.plist` is the copy, and it only works signed.** `build.rs` links it
  into `__TEXT,__info_plist` in both binaries, but the signature the linker
  applies by itself seals nothing it did not write — `codesign -dv` says
  `Info.plist=not bound` and the dialogs fall back to a per-build hash with no
  product name and no sentence. A `codesign` pass fixes both at once
  (`Identifier=dev.spawnd.daemon`, `Info.plist entries=`), which is why
  `.github/workflows/prebuilt.yml` re-signs and fails if either is missing.
  A local build is linker-signed, so re-sign before judging a dialog:
  `codesign -f -s - target/release/spawnd`.
- **Ask once, behind a screen, where a person can answer.** `permissions.rs`
  asks for the three folders in order on the first registration after
  possession, then records the answers and never asks again — a refusal is
  sticky and only System Settings can lift it, so re-asking teaches people to
  say no.

  It never asks on its own initiative. The desktop app leaves a
  `permissions.request` marker before showing its screen; the daemon waits up to
  two minutes for the matching `permissions.consent`, and **with no request
  marker it primes nothing at all** — an `install.sh` run or a possession over
  SSH keeps the ordinary lazy prompts. All three files plus the
  `permissions.json` report live in one shared `<config>/spawn/` directory
  rather than per instance, because TCC grants the *binary*, once, whoever it is
  running for; a per-instance answer would re-ask the same person the first time
  they added a second account. `someone_is_at_this_screen()` still guards it,
  because a dialog nobody can answer is auto-refused and the refusal kept.
  `SPAWND_NO_PERMISSION_PRIME=1` turns it off.

  The wait is why this is **spawned, never awaited**, from the `Registered`
  handler: it can sit for two minutes on a person, and that handler is how every
  other frame on the socket gets processed.
- **Never prime what the daemon does not set out to read.** The photo and music
  library prompts people saw came from an agent walking `$HOME`, not from us.
  Adding one to `Location::ORDER` would put it in front of every new user, and
  a test refuses that.

`docs/RELEASE.md` has the release half: which dialogs notarization removes, and
what it takes for a grant to survive a self-update.

## The diagnostics variant

The same daemon, built with `--features diagnostics` under the
`[profile.diagnostics]` in `Cargo.toml` (release codegen, symbols kept):

```bash
cargo build --locked --profile diagnostics --features diagnostics
```

What the feature changes: `version::DIAGNOSTICS_BUILD` is true, so the
version gains a `.diagnostics` build-metadata segment
(`0.1.0+g<commit>.diagnostics`, reported by `--version`, `status`, and the
register frame), logging starts at `-v` (`spawnd=debug`) with nothing set,
every attach failure is attributed at warning level, `session_ctl.rs` runs a
watchdog that names whoever holds a session's control transaction and for how
long, and `rtc.rs` logs the attach and bootstrap exchange at debug. Setting
`SPAWND_DIAG_REPLAY_DUMP_DIR` in this variant only also writes the exact
replay bytes each viewer was sent to that directory — terminal plaintext on
the host's own disk, opt-in by environment and nowhere else. `RUST_BACKTRACE=1`
in the unit is what the kept symbols are for.

Delivery is a release variant, not a fork: `.github/workflows/prebuilt.yml`
builds it beside the release pair for `linux-x86_64`, the signed manifest
lists it under `variants.diagnostics`, and the server serves it from
`/api/install/<kind>/<target>/diagnostics`. `update.rs` follows the variant
the running binary was built as (`ReleaseVariant::own()`), so a diagnostics
host stays diagnostics across updates with nothing configured and a release
host never picks it up by accident; `SPAWND_RELEASE_VARIANT=release|diagnostics`
overrides that in either direction, and any other value blocks self-update
with `invalid_variant`. The variable is read by whichever process updates:
the service, for the next release the server pushes, or `spawnd update`, from
its own shell environment — the daemon itself only checks for an update
when a protocol bump refuses it at the handshake (`run.rs`, the
protocol-required path), so moving a host across on the tree it already runs
is `SPAWND_RELEASE_VARIANT=diagnostics spawnd update`. A diagnostics daemon whose
release carries no diagnostics pair for its target refuses the update with
`variant_unavailable` and keeps running what it has — it never falls back to
the release pair. "The diagnostics variant" in `docs/RELEASE.md` has the
operator's side, including the one-time step for a daemon built before the
updater knew about variants.

- Shared device RTC lives in `rtc_pair.rs`: signed host-v2 admission owns
  the peer; local registry attachments reuse the session protocol and own only
  channels. Fence every effect by parent trust/binding and worker generation.
  `session_ctl.rs` retains the controlling device's lease until explicit take
  or session removal; `focus_view` only moves control within that device.
  See `docs/DEVICE_CONNECTIONS.md` for the lifecycle and compatibility contract.

`host_control::install` returns a `Lifetime` handle with only `is_retired` and
`retire`. Pair retirement fences those handles before removal from the host
map becomes observable, then performs asynchronous channel cleanup. The
protected-content guard pins that narrow exported surface; it exposes no
content or server publication capability.

Exactly one teardown owns a peer: the first caller to `claim` its
`PeerCloseCoordinator` takes it out of service (`take_out_of_service`) and
settles it (`settle_detached_peer`); a later close of the same peer finds it
out of the live map and does nothing. In particular it never touches the
transport: `RTCPeerConnection::close` marks the connection closed before it
does anything, so a duplicate close dropped at a deadline would turn the
owner's close into a silent no-op and leak the sockets. When a host peer
leaves the host map — reaped, closed by the server, or superseded by the
same device — its attachments leave the peer map with it, under the same
locks (`detach_pair_children`), so a device re-attaching the same view never
finds a stale child and the old transport feeds no PTY past that moment; the
tracked task settles them and then closes the transport; and an attach that
was in flight when its pair was retired is refused under the peer-map lock
(`attach_pair_channel`), so no attachment lands after the sweep. A device
offer is checked for collisions before the device's working connection is
taken, so an offer refused at admission never costs the device the
connection it has (an offer that fails after admission — negotiation, answer
signing — has superseded it already, and the device reconnects). The
superseding connection takes the superseded pair's slot when the cap is
full (`AdmissionSlot::transfer`, `SlotDisposition::Keep`), so a device
reconnecting at the cap is never refused for want of the slot its own old
connection held. A cleanup task pays its debts on every exit, a panic's
unwind included (`TeardownSettlement`): the slot back to the cap and the
peer out of the closing map.

The peer cap (`MAX_RTC_PEERS` in `rtc.rs`) charges one `AdmissionSlot` per
session or host peer; a pair session inherits its host peer's slot and never
returns it. A slot returns when its owner leaves the live map — for a session
peer, once its close deadline passes or its teardown settles, whichever is
first, released from inside the tracked cleanup task, which nothing cancels;
for a host peer, the moment it leaves the host map, under that lock, before
its transport close begins. Never tie a slot to a clone of the peer dropping:
clones live on in the closing-peer map, the fenced cleanup task, and stored
callbacks for as long as a remote that will never answer keeps a transport
close pending, and that is how dream refused every offer for a day with
`capacity exhausted` while its status said `connected`.

The owning teardown of a mapped peer never abandons its transport close: a
session teardown past its deadline and every close of a host peer that was
in the map run in a tracked cleanup task (`spawn_host_closes` →
`close_retired_host_peer`), and `settle_with_watchdog` names one still
pending at `RTC_TEARDOWN_WATCHDOG` and every `RTC_TEARDOWN_REMINDER` after.
A duplicate close of a transport some other teardown owns — a reaper firing
for a pc already leaving — does nothing at all. No path awaits a transport close while holding the
admission lock, which every offer serializes on, or ahead of an answer: a
superseded pair closes in a tracked task after the lock drops, and trust
invalidation waits for host closes only until the teardown deadline. A
device re-attaching a view of its superseded connection (the mobile client
keeps its attachment ids across a reconnect) finds nothing stale: the old
attachment left the peer map when its pair was superseded. Every
transport close the daemon owns stops the SCTP association before
`RTCPeerConnection::close` (`pair::stop_then_close`): the close begins with
a shutdown of each data channel, and against a peer that stopped
acknowledging those wait behind a writer that never gets room; the closed
association releases the writer and the shutdowns bail on state. Every
retirement the daemon starts on its own — the reaper's never-connected,
failed, and stayed-disconnected closes, a session that ended, was replaced,
or is restarting, and a device connection superseded by a newer one — tells
the server `unavailable` for that binding, once it has claimed the peer
(`reap_session_peer`, `close_for_session`, `reap_host_peer`,
`take_device_pair`). A session close hands its announcements back for the
caller in `run.rs` to send once the exit or the replacement is on the wire:
sent earlier, a device re-offers into a session that is not running, is
refused with `failed`, and reads that as the host dropping it. The server's
own per-host, per-browser, and per-user
binding caps free a binding on that status, a browser's shared connection
never sends `rtc.close`, and a binding the server keeps for a peer only this
daemon knows is gone would otherwise count until its TTL or this daemon's
next registration. `unavailable`, not `failed`: to a device `failed` on its
active binding is a refusal of its offer and it drops its trust verdict,
while `unavailable` is a connection that is gone, answered with a new one.
A status deferred for want of channel room is retried from the control
connection's heartbeat once registration's replay has run; at reconnect a
deferred terminal status is replayed only for a binding the register frame
carried (the server kept exactly those), and a deferred `connected` never
is — the replay says `connected` for every peer that is. One race is
accepted: a status for a binding the server retired on its own a moment
earlier (a browser's close still in flight) earns a rate-limited warning on
both sides and nothing else. In the deferred map a
terminal status always wins: a replayed `connected` never overwrites the
`unavailable` deferred after it. A retired host peer's association stops
before its attachments settle, so their channel closes are not each held
to their deadline by the writer the silent peer left stuck. The cap is
read by the daemon's own 30 s state timer in `run.rs` — not the control
connection's, since peers keep opening and closing through a server outage
— and written to the state file as `rtc_peers` (`in_use`, `closing`,
`host_closing`, `cap`); `spawnd status` prints it as the `peers` line, so a
leak — of slots, or of peers that never finish closing — shows while it is
one peer. Never write the state file from the RTC path: that write is an
fsync, and the offer path waits on the locks it would run under.

## Before calling a change done

```bash
cargo build --locked
cargo test --locked --bin spawnd <module>::
```

Both feature sets are checked, because the variant is a real release build;
`scripts/test-all.sh` runs both `cargo test` lines, the clippy and build
lines are the local checklist:

```bash
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --all-targets --features diagnostics -- -D warnings
cargo test --locked
cargo test --locked --features diagnostics
cargo test --locked -p webrtc-sctp --lib -- stream::stream_test:: queue::queue_test::
cargo test --locked -p webrtc-ice --lib agent_transport_test::
cargo build --locked --profile diagnostics --features diagnostics
```

Upload admission tests coordinate async tasks with a Tokio barrier; blocking
filesystem pauses use release guards so a failed assertion cannot strand a
worker during runtime shutdown. The same-owner case runs on a single-thread
executor and has a bounded completion deadline.

The SCTP stream tests also run in Linux and Windows CI. `read_sctp` registers
its notification waiter before checking shutdown or awaiting the reassembly
queue lock: a remote reset uses `notify_waiters`, so registering afterward can
lose the notification and strand a closed channel's reader. The regression
holds that queue lock and resets the stream while the reader is waiting.

ICE route recovery tests also run in Linux and Windows CI. Typed temporary
network-unreachable errors drop the UDP datagram so SCTP can retransmit after
ICE recovery; they must not close the shared association. Other IO errors
and explicit connection closure still fail. The tests inject the route error
and require the next datagram to reach a real receiver on the same connection.

Stored channel handlers capture their channel weakly, including `on_open`
handlers that may never fire. The vendored WebRTC registry prunes closed
channels on each local or remote admission, preserving cumulative close stats
and bounded stream-ID reservations rather than reusing IDs before SCTP reset
completes. Native daemon tests exercise 256 host consumers on one live parent
and require all consumer state to be released after parent close.

Set `SPAWND_RTC_TEST_TRACE=1` to capture WebRTC/SCTP diagnostics in the shared
session lifecycle regression. On a failed unknown-session refusal, the test
also reports both peers' channel states without changing its deadline.
Windows CI repeats this regression twenty times after the full suite to expose
intermittent channel-close failures without enabling timing-altering trace logs.

Native Windows CI additionally gates every binary, test/example target, and
cfg-specific lint path:

```bash
cargo check --locked --target x86_64-pc-windows-msvc --bins
cargo check --locked --target x86_64-pc-windows-msvc --all-targets
cargo clippy --locked --target x86_64-pc-windows-msvc --all-targets -- -D warnings
```

Windows installs one persisted per-instance background mode: the primary
least-privilege interactive-token Task Scheduler task, or the HKCU Run
watchdog fallback when Scheduler denies worker breakaway. The task action is
always an absolute `spawnd.exe` path and invokes the hidden
`run --background-service` mode; the Run registration invokes the hidden
`__watchdog --instance <8hex>` mode. Those internal flags are service-owned and
are not ordinary foreground commands. The owner-only named control pipe handles
ping/reconnect/graceful shutdown; Unix SIGHUP and systemd `KillMode=process`
stay unchanged. `possess --service-mode task|run` explicitly changes the
persisted manager, and an interactive `possess` offers the safe Run fallback
after a denied Task Scheduler breakaway probe. Windows CI must run `cargo test --locked --target
x86_64-pc-windows-msvc` and the standard-user breakaway integration probe.

Windows background logs identify process roles and PIDs. The Run watchdog logs
each daemon launch, observed exit code, and stop reason, distinguishing removed
or changed registration from a registry read error. Session restart progress
records peer closure, TERM/KILL acknowledgement, and replacement launch. Check
both `spawnd.log` and `spawnd.log.1` when investigating a stopped daemon; the
watchdog can still hold a log file that a later daemon startup rotated.

Run `cargo clippy` and `cargo fmt` on what you touched. Shipping binaries to
users goes through the rolling prebuilt release — read `docs/RELEASE.md`.

WebRTC operational notes: `webrtc-ice` 0.17 cannot use TURN over TCP/TLS, so
the offered ICE list must include a UDP `turn:` URL. Direct LAN ICE uses UDP
ports 50000–50999 (`RTC_UDP_PORT_MIN..=RTC_UDP_PORT_MAX` in `src/rtc.rs`);
allow that inbound range in the host firewall. The range is the budget for
direct paths — one server-reflexive socket per ICE URL per address family
plus one host socket per address of every interface `interface_is_allowed`
admits, VPN interfaces included by design; a full range means relay-only
peers, since the TURN client binds outside it. The open-file limit is the
ceiling that stops a peer gathering anything: `run.rs` raises the soft limit
when the daemon starts to run, and `service.rs` writes soft-only limits into
the units (`LimitNOFILE=65536:infinity`, launchd `SoftResourceLimits`) —
never a hard limit, which every shell in a terminal would inherit. For
temporary SCTP #822 confirmation, use `RUST_LOG=webrtc_sctp=debug` and look for
`receive buffer full. dropping DATA with tsn=` immediately before an ABORT.

`host.agents.install` is a refusal-only compatibility frame: server identity
does not authorize running an installer or self-updater. Never restore its
execution path to make an old server work. The replacement requires endpoint
authorization and durable effect handling; `docs/DAEMON_COMMAND_AUTHORITY.md`
records the remaining command surfaces, including server-selected version probes.

## Where a daemon's binaries live

Two daemons under one OS user used to share one pair of files,
`~/.local/bin/spawnd` and `spawn-worker`, and every unit named that pair.
Installing a second account replaced both under the first daemon, which kept
running its old image while every worker it launched came from the new files
(2026-09-09, dream: `worker_mismatch`, no new sessions, and a `spawnd status`
that reported the *command's* version and "up to date"). `install.rs` owns
the layout that ends this:

```text
<root>/                         ~/.local (Unix), %LOCALAPPDATA%\spawn (Windows)
  bin/spawnd -> ../lib/spawn/releases/<id>/spawnd      the command on PATH
  lib/spawn/                    (Windows: <root> itself)
    releases/<version>-<hash>/  immutable: spawnd, spawn-worker, release.json
    instances/<tag>/current -> ../../releases/<id>     what this instance runs
    instances/<tag>/spawnd.updating                    an update on trial
<config_dir>/install.json       names <root> for the instance
```

- **A release is published once and never modified.** `install::publish`
  probes both binaries' `--version` and the daemon's `__build-info`, refuses
  a pair whose halves disagree or whose daemon predates the release store,
  writes a staging directory under `releases/` and renames it into place.
  Publishing the same bytes again returns the release already there; a
  different pair under the same name is refused. Two installers racing to
  publish one release both end up with it.
- **Each instance owns a pointer, nothing else.** On Unix the `current`
  symlink is swapped atomically and the unit's `ExecStart` goes through it,
  so the worker beside the running executable is the worker of the same
  release *by construction* (`worker_backend::worker_bin` resolves beside the
  canonical executable, once). On Windows, where a link needs a privilege a
  user may not have, `instances\<tag>\` holds a hard-linked pair only that
  instance's update swaps, `current.json` names the release, and the task or
  Run registration names that constant path.
- **Installers publish; `possess` and `update` select.** `install.sh` and
  `install.ps1` download into scratch and run `spawnd __publish-release
  --install-root <root>` from there; they never write into `bin/`. The
  command on PATH becomes a link into the store — unless some daemon still
  starts from a regular-file pair in `bin/` (`service::legacy_pair_in_use`),
  in which case that pair is left untouched until the daemon restarts.
  `possess` selects the installer build, preserving the instance's variant
  (fetching its signed pair when the installer is another variant), then
  registers and starts it. It never adopts a live pre-store daemon. Legacy
  heartbeats without an executable field are checked against the live process;
  process images also cover foreground launches before their first heartbeat.
  An unknown image keeps the shared pair intact. `service::install` writes a
  unit for the instance's launch path; `update` publishes the signed
  pair and repoints one instance. Nothing ever writes a file another instance
  is running.
- **A legacy launch converges on its first start.** `run` calls
  `install::prepare_launch` before anything else: a daemon launched from
  `bin/` (or from a pair placed by hand under `instances/<tag>/`) adopts its
  own pair into the store, selects it unless a selection exists, rewrites its
  unit or plist for the constant launch path, and on Unix re-executes from
  the store with the same PID and argv. Windows records the pointer and keeps
  running until its next restart; only `possess`, `reconnect`, or `update`
  from a shell re-register it, and a daemon still launched from `bin\`
  blocks its own self-update with `legacy_launch`.
- **Probation is per instance.** The marker lives in `instances/<tag>/`; a
  failed probation points the instance back at the previous release, which
  stays on disk until nothing refers to it. A marker the in-place updater left
  beside a legacy binary is still honoured with its `.prev` semantics, once.
  Installers and updaters lock `selection.lock` before changing the pointer;
  an existing probation marker prevents another update from replacing it.
- **Collection is conservative.** `install::collect_garbage` removes releases
  no instance selects, no marker names, the command on PATH does not resolve
  to, this process does not run, no live heartbeat records, and that are older
  than fifteen minutes; it runs after a healthy registration and after
  `spawnd update`, `exorcise`, and `reset`.

`SPAWN_INSTALL_ROOT` chooses the root for an install and for a binary the
store does not yet manage. An instance's `install.json` takes precedence over
the inspecting CLI's install root; without a record the executable supplies
its root. A checkout's `target/debug/spawnd` is "unmanaged": it is
launched from where it is and only its first update moves it into the store.

`spawn-worker --version` prints the same build/tree identity stamped into
`spawnd`. The supervisor checks that pair at startup and before every new
session; a mismatch is reported as `worker_mismatch`, recorded in `state.json`
for `status` and `doctor`, and existing workers keep running, but new sessions
are refused. Inside the store the check is a tripwire — the pair cannot
disagree by construction — and it remains the frontline for a daemon still
launched from a legacy path. Two failed startups or five minutes without
registration point the instance back at the previous release and report a
`health` update failure after the old daemon registers.

`status` and `doctor` describe the *instance*: the version, tree, executable,
and worker verdict its live daemon wrote to `state.json` (on Linux, whether
`/proc/<pid>/exe` says the file was replaced under it), the release it is
pointed at, and what its service will actually start (`service::launch_report`
reads `systemctl show`, which is how a drop-in override is caught). The
command's own build appears once, as `cli_version`, and is never mistaken for
a daemon's.

Every self-update first downloads the origin-pinned
`/api/install/manifest.json{,.sig}`, verifies the exact manifest bytes against
the rotation list in `release_key.rs`, matches its tree and both artifact
hashes, and enforces the build.rs-stamped monotonic release counter. A CLI
uses the higher counter of the target instance's selected and live builds,
recorded in `release.json` and its heartbeat; a known instance with missing
  identity blocks updating until possession migrates it. Downloaded build
metadata must match the signed counter, version, tree, and store capability.
Nothing the
server sends can waive that counter: `daemon.update` carries an
`allow_downgrade` flag, but it only *asks*, and the daemon proceeds only when a
downgrade has also been consented to on this machine — a `allow-downgrade` file
touched in the config dir within the last 30 minutes. The server is untrusted
(`docs/TRUST.md`), and rollback to a known-vulnerable release is precisely what
the counter exists to prevent, so it is not the server's to switch off.
Development
harness builds may set `SPAWND_DAEMON_TREE_OVERRIDE`,
`SPAWND_BUILD_COUNTER_OVERRIDE`, and
`SPAWND_RELEASE_PUBLIC_KEYS_OVERRIDE`. `SPAWND_ALLOW_UNSIGNED_UPDATE=1` is a
local-development-only escape hatch that skips the signature and counter
checks, emits one warning, and must never be used by production tooling.
Which build of a release is installed — the release pair or a variant such as
diagnostics — is decided by the daemon from its own build and
`SPAWND_RELEASE_VARIANT`, never by the server; see "The diagnostics variant"
above.

The user-facing command set is `possess` (`setup`), `exorcise` (`remove`),
`status`, `doctor`, `reconnect`, `disconnect`, `update`, `login`, `logout`,
`reset`, and foreground-only `run`; `__publish-release` is the installers'
hidden handoff, and `__build-info` reports version, tree, monotonic counter,
and release-store capability as JSON without changing `--version`.
`possess --new-account` creates another isolated account
instance with its own release pointer. `update`, like `reconnect`, acts on
every instance it can see and judges each by the release it runs, whatever
build the command itself is. On Windows, `possess --service-mode task|run`
selects and persists the instance's background manager; a denied task
breakaway is offered as a switch to the Run watchdog on the next `possess`.
`run` writes `state.json` atomically (`<config_dir>` on Unix,
`%LOCALAPPDATA%\spawn\state\<instance>` on Windows) on
connection/session transitions and every 30 seconds; SIGHUP requests an
immediate reconnect without terminating session workers.

## Keeping this file true

Agents and people plan work from this file, so a stale version misroutes every
change that follows it. A commit that adds, renames, or moves a directory
under `src/`, changes a convention, or changes a command above updates this
file in the same commit. `scripts/check-claude-md.sh` (run by
`scripts/test-all.sh`) fails when a tracked directory here is not named in
this file.
