# spawnd

The `spawn` daemon. Runs on a host you control, dials WSS out to a spawn
server, and lets that server spin up shell sessions on the host. Agent CLIs
(claude code, codex, opencode, aider, …) are commands the UI types into those
shells.

## Build

```sh
cargo build --release
# -> target/release/spawnd
```

The build produces both `spawnd` and `spawn-worker`. Keep the two binaries
beside each other (or set `SPAWND_WORKER_BIN`). Each session runs in its own
purpose-built worker and survives supervisor reconnects/restarts.

## Login

```sh
spawnd --server https://spawn.example.com login
```

This uses a device-code flow:

1. The daemon prints a verification URL and short user code.
2. Open the URL in a browser, sign in, and approve the code.
3. The daemon stores the resulting access token, host identity, assigned
   `host_id`, server URL, and bounded approving-browser pin set. On Unix the
   parent-synced mode-600 `~/.config/spawn/credentials.json` record is complete
   and automatically remains authoritative when the optional OS keyring is
   unavailable.

## Run

```sh
spawnd run            # uses stored server URL
spawnd --server https://other run    # override
```

This is a foreground service. It connects WSS to `<server>/ws/daemon`,
registers, and processes lifecycle and bound WebRTC-signaling frames. Terminal
input/output uses the mandatory fully reliable ordered `spawn.pty` DataChannel;
history, snapshots, resize, display ownership, and capability/generation-bound
session uploads use the mandatory fully reliable ordered `spawn.ctl` DataChannel.
The WebSocket is a JSON-only control/signaling path, not a PTY, upload,
acknowledgement, transcript, or fallback leg. If either DataChannel is
unavailable or partially reliable, the terminal fails closed. Upload filesystem
work and cleanup run in owned blocking operations; teardown uses one absolute
deadline and retains admission charges until descriptor/temp cleanup actually
finishes. Post-publication failures are `outcome_unknown` and must not be
retried without reconciliation. On disconnect it reconnects with exponential backoff
(1s, 2s, 4s, … capped at 60s) and re-registers with `existing_sessions = […]`
so the server resyncs its routing map without disturbing running workers.

## Other commands

```sh
spawnd status     # show server URL, host_id, token presence
spawnd logout     # wipe stored token, host identity, and host_id
```

## Config

| Source | Effect |
|---|---|
| `--server <url>` | Override server URL (highest precedence) |
| `SPAWN_SERVER_URL` | Same, via env |
| stored creds | Fallback to the URL used at login |
| default | `https://localhost:8000` |

Credentials live at `~/.config/spawn/credentials.json` (mode 600) and/or in
your OS keyring under service `spawn`, with the account scoped by a SHA-256
identity of the canonical config directory. Linux uses kernel keyutils, not
Secret Service/DBus. Only the exact default config directory may migrate the
legacy global `daemon` account, and only when its file does not conflict; an
alternate `SPAWN_CONFIG_DIR` never reads or deletes that global account. On Unix the fallback is
accepted only as a regular, non-symlink file owned by the effective user with
no group/other permission bits; malformed, oversized, or insecure files fail
closed. New config directories are mode 700; credential replacement and reset
sync the parent directory, and narrowly named owned mode-600 orphan temps are
cleaned under the credential lock. A pin-bearing record may relogin only to the
same canonical server origin and Host ID; use `spawnd logout` for an explicit
trust reset or a separate `SPAWN_CONFIG_DIR` for another pairing. Other
platforms keep the private host seed in the native keyring and store only
non-seed fallback metadata. `spawnd logout` attempts both backends
and returns a failure if either cannot be cleared, so it never reports a
successful reset while credentials may remain.

## Wire protocol

The daemon implements the daemon side of `proto/README.md`. `/ws/daemon`
requires the server to select `spawn.control.v3`; every WebSocket frame is
JSON. Session RTC offer/candidate/close messages are bound to the exact
session scope, `spawn.pty` protocol, protocol version, nonce, and daemon
generation.
Binary WebSocket frames and legacy protocol selection fail closed.

## Process model

Each session runs in a `spawn-worker` process which owns the PTY, encrypted
resource-budgeted replay log, and plaintext headless checkpoint emulator
(current screen grids only, no deep history). `spawnd` communicates with it
over a mode-600 Unix socket. On `Ctrl-C`, `spawnd` closes the WS but does not stop
workers; the next supervisor discovers and adopts their sockets.

There is one mandatory backend and no environment or per-session escape hatch.
An old session created by a pre-cutover daemon is not adopted. Operators must
drain it before upgrading, then restart the daemon and create a fresh worker
session; see `docs/TRUST_PHASE2_PROGRESS.md`.

## Dev

```sh
cargo test          # frame encode/decode + credential materialization
cargo clippy -- -D warnings
cargo fmt
```
