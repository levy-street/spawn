# spawnd

The `spawn` daemon. Runs on a host you control, dials WSS out to a spawn
server, and lets that server spin up CLI coding agents (claude code, codex,
opencode, aider, …) on the host.

## Build

```sh
cargo build --release
# -> target/release/spawnd
```

The build produces both `spawnd` and `spawn-worker`. Keep the two binaries
beside each other (or set `SPAWND_WORKER_BIN`). Each agent runs in its own
purpose-built worker and survives supervisor reconnects/restarts.

## Login

```sh
spawnd --server https://spawn.example.com login
```

This uses a device-code flow:

1. The daemon prints a verification URL and short user code.
2. Open the URL in a browser, sign in, and approve the code.
3. The daemon stores the resulting access token in your OS keyring (with a
   mode-600 file fallback at `~/.config/spawn/credentials.json` on headless
   hosts) along with the assigned `host_id` and the server URL.

## Run

```sh
spawnd run            # uses stored server URL
spawnd --server https://other run    # override
```

This is a foreground service. It connects WSS to `<server>/ws/daemon`,
registers, and processes `agent.create` / `agent.kill` / `agent.resize`
frames, multiplexing PTY I/O for any number of concurrent agents over the
single connection. When the browser and daemon can establish WebRTC, terminal
input/output also flows over a direct `spawn.pty` DataChannel while the
websocket remains the control plane and transcript/fallback path. On disconnect
it reconnects with exponential backoff
(1s, 2s, 4s, … capped at 60s) and re-registers with `existing_agents = […]`
so the server resyncs its routing map without disturbing running workers.

## Other commands

```sh
spawnd status     # show server URL, host_id, token presence
spawnd logout     # wipe stored token (and host_id)
```

## Config

| Source | Effect |
|---|---|
| `--server <url>` | Override server URL (highest precedence) |
| `SPAWN_SERVER_URL` | Same, via env |
| stored creds | Fallback to the URL used at login |
| default | `https://localhost:8000` |

Credentials live at `~/.config/spawn/credentials.json` (mode 600) and/or in
your OS keyring under service `spawn`, user `daemon`.

## Wire protocol

The daemon implements the daemon-side of `proto/README.md` (subprotocol
`spawn.v1`). Binary PTY frames are `u8 kind | 16-byte big-endian uuid |
bytes`, with `0x01` for output (daemon→server) and `0x02` for input
(server→daemon).

## Process model

Each agent runs in a `spawn-worker` process which owns the PTY, encrypted
resource-budgeted replay log, and plaintext headless checkpoint emulator
(current screen grids only, no deep history). `spawnd` communicates with it
over a mode-600 Unix socket. On `Ctrl-C`, `spawnd` closes the WS but does not stop
workers; the next supervisor discovers and adopts their sockets.

There is one mandatory backend and no environment or per-agent escape hatch.
An old session created by a pre-cutover daemon is not adopted. Operators must
drain it before upgrading, then restart the daemon and create a fresh worker
session; see `docs/TRUST_PHASE2_PROGRESS.md`.

## Dev

```sh
cargo test          # frame encode/decode + credential materialization
cargo clippy -- -D warnings
cargo fmt
```
