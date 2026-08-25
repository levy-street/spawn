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
  tui.rs         shared TTY/NO_COLOR presentation, logo, steps, and spinner
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
