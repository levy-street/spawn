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
  <feature>.rs   one module per concern: run.rs (register + main loop),
                 ws.rs, update.rs + update_io.rs (verified daemon self-update;
                 focused tests live in update_tests.rs), release_key.rs (pinned
                 release trust roots), login.rs, creds.rs, rtc.rs, host_*.rs,
                 upload.rs, sessions.rs, service.rs + service/ (launchd/systemd
                 dispatch, Windows Task Scheduler/Run watchdog and control
                 pipe), …
  tui.rs         shared TTY/NO_COLOR presentation: the live step frame
                 (`Ui`), panels, logo, and the single-line `Spinner`
  state.rs       atomic local daemon heartbeat contract (`state.json`)
  status.rs      human/JSON status across local account instances
  doctor.rs      the ordered 14-check local health report, plus the Windows
                 agent-shell dependency diagnostic
  lifecycle.rs   reconnect, disconnect, logout, and local reset commands
  version.rs     the version the daemon reports; build.rs stamps the source
                 commit into it (0.1.0+g<commit>)
Info.plist       the sentences macOS prints in its consent dialogs; build.rs
                 links it into both binaries' `__TEXT,__info_plist` section
tests/           integration tests (worker_e2e.rs)
examples/        golden-vector generators for proto/
vendor/          exact upstream crate sources for narrowly documented patches;
                 currently webrtc-sctp 0.17.2 plus the #822 re-admission fix
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
cargo build --locked --profile diagnostics --features diagnostics
```

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

Run `cargo clippy` and `cargo fmt` on what you touched. Shipping binaries to
users goes through the rolling prebuilt release — read `docs/RELEASE.md`.

WebRTC operational notes: `webrtc-ice` 0.17 cannot use TURN over TCP/TLS, so
the offered ICE list must include a UDP `turn:` URL. Direct LAN ICE uses UDP
ports 50000–50100; allow that inbound range in the host firewall. For temporary
SCTP #822 confirmation, use `RUST_LOG=webrtc_sctp=debug` and look for
`receive buffer full. dropping DATA with tsn=` immediately before an ABORT.

`spawn-worker --version` prints the same build/tree identity stamped into
`spawnd`. The supervisor checks that pair at startup and before every new
session; a mismatch is reported as `worker_mismatch` and existing workers keep
running, but new sessions are refused. Reapplying the same release is allowed
while mismatched so self-update can repair the pair. Self-updates retain both `.prev`
binaries and a sibling `spawnd.updating` probation marker until the new daemon
registers. Two failed startups or five minutes without registration atomically
restore the pair and report a `health` update failure after the old daemon
registers.

Every self-update first downloads the origin-pinned
`/api/install/manifest.json{,.sig}`, verifies the exact manifest bytes against
the rotation list in `release_key.rs`, matches its tree and both artifact
hashes, and enforces the build.rs-stamped monotonic release counter. Nothing the
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
`reset`, and foreground-only `run`. `possess --new-account` creates another
isolated account instance. On Windows, `possess --service-mode task|run`
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
