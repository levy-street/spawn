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
  secret_file.rs how a secret is put on disk: atomic 0600 write, owner and
                 permission checks, NOFOLLOW open, cross-process lock. Used by
                 creds.rs here and by the macOS app's storage.rs, which keeps a
                 different record under identical handling
  bin/           spawn-worker.rs and cross-runtime-crypto.rs (vector
                 generator)
  sessiond/      supervisor↔worker shared pieces: wire protocol, terminal
                 emulator, scrollback, worker runtime
  <feature>.rs   one module per concern: run.rs (register + main loop),
                 ws.rs, update.rs + update_io.rs (verified daemon self-update;
                 focused tests live in update_tests.rs), release_key.rs (pinned
                 release trust roots), login.rs, creds.rs, rtc.rs, host_*.rs,
                 upload.rs, sessions.rs, service.rs, …
  tui.rs         shared TTY/NO_COLOR presentation: the live step frame
                 (`Ui`), panels, logo, and the single-line `Spinner`
  state.rs       atomic local daemon heartbeat contract (`state.json`)
  status.rs      human/JSON status across local account instances
  doctor.rs      the ordered 14-check local health report
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

## Before calling a change done

```bash
cargo build --locked
cargo test --locked --bin spawnd <module>::
```

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
hashes, and enforces the build.rs-stamped monotonic release counter. Development
harness builds may set `SPAWND_DAEMON_TREE_OVERRIDE`,
`SPAWND_BUILD_COUNTER_OVERRIDE`, and
`SPAWND_RELEASE_PUBLIC_KEYS_OVERRIDE`. `SPAWND_ALLOW_UNSIGNED_UPDATE=1` is a
local-development-only escape hatch that skips the signature and counter
checks, emits one warning, and must never be used by production tooling.

The user-facing command set is `possess` (`setup`), `exorcise` (`remove`),
`status`, `doctor`, `reconnect`, `disconnect`, `update`, `login`, `logout`,
`reset`, and foreground-only `run`. `possess --new-account` creates another
isolated account instance. `run` writes `<config_dir>/state.json` atomically on
connection/session transitions and every 30 seconds; SIGHUP requests an
immediate reconnect without terminating session workers.

## Keeping this file true

Agents and people plan work from this file, so a stale version misroutes every
change that follows it. A commit that adds, renames, or moves a directory
under `src/`, changes a convention, or changes a command above updates this
file in the same commit. `scripts/check-claude-md.sh` (run by
`scripts/test-all.sh`) fails when a tracked directory here is not named in
this file.
