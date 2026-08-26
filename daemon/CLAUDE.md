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
                 sessiond, signed_signal, …) shared with spawn-worker,
                 tests, and browser golden vectors — everything else stays
                 private to the binary
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
  and regenerate the `proto/` vectors when signed material changes.

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

### The ceremony has two shapes, and they say different things

`device/possession` answers `attended`, which is true exactly when the request
carried a `--setup` token. That token is minted by a signed-in browser sitting
on the setup screen, so on that path the reader started in the browser and the
browser is already watching this ceremony and already showing this host's
fingerprint.

- **Attended** shows `attended_panel` — the fingerprint and nothing else — and
  never opens a browser, prints a link, or renders a QR. All of those are
  instructions for work the reader has finished. The web copy on the other
  side is written to match, so changing one means changing both. After 25 s
  with no approval the link is *revealed* as a fallback (a closed tab has to
  be recoverable), never auto-opened.
- **Unattended** — a bare `spawnd possess` — offers the link and nothing
  else: the link, an optional QR of it, and Enter to open it here. The pairing
  code and the fingerprint used to be printed beside it and read as three
  ways to approve; the link carries the key, so the other side checks it.

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
  Unattended installs never see it and keep resuming, because a re-run of the
  same command with nobody watching should be a no-op. Build such a menu from a
  pure `*_options`/`*_choice` pair so the rows can be tested without a keyboard;
  `possess::resume_action` is the pattern.
- A `--setup` token names its own server (it is only redeemable on the origin
  that minted it), so `choose_server` never prompts when one is present. It
  also names an *account*, so it always holds its own ceremony rather than
  resuming an instance already on the machine — see `staged_login_required`.
  Resuming instead answered "put this machine on that account" by reporting
  some unrelated account, and left the browser that issued the token waiting.
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
