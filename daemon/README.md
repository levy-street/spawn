# spawnd

The `spawn` daemon. Runs on a host you control, dials WSS out to a spawn
server, and lets that server spin up CLI coding agents (claude code, codex,
opencode, aider, …) on the host.

## Build

Requires Erlang/OTP 27 or newer, `rebar3`, and a C/C++ build toolchain for the
`erlexec` PTY port program.

```sh
rebar3 release
rebar3 escriptize
# -> _build/default/rel/spawnd and _build/default/bin/spawnd
```

`spawnd` is an Erlang/OTP service. It uses `erlexec` to launch each agent as a
direct supervised subprocess attached to a PTY; `tmux` is no longer required.

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

Installed hosts use the wrapper at `~/.local/bin/spawnd`, which starts the
OTP release for `run` and uses the CLI escript for login/status commands. In a
dev checkout, run the release directly with
`_build/default/rel/spawnd/bin/spawnd foreground`.

This is a foreground service. It connects WSS to `<server>/ws/daemon`,
registers, and processes `agent.create` / `agent.kill` / `agent.resize`
frames, multiplexing PTY I/O for any number of concurrent agents over the
single connection. On disconnect it reconnects with exponential backoff
(1s, 2s, 4s, … capped at 60s) and re-registers with `existing_agents = […]`
so the server resyncs its routing map without disturbing running agent
supervisors in the current daemon VM.

## Other commands

```sh
spawnd status     # show server URL, host_id, token presence
spawnd logout     # wipe stored token (and host_id)
spawnd agents     # query the local daemon control socket
spawnd kill <id>  # terminate a local agent subprocess
spawnd update-check # report whether the checkout is clean enough to update
```

## Config

| Source | Effect |
|---|---|
| `--server <url>` | Override server URL (highest precedence) |
| `SPAWN_SERVER_URL` | Same, via env |
| stored creds | Fallback to the URL used at login |
| default | `https://localhost:8000` |

Credentials live at `~/.config/spawn/credentials.json` (mode 600).

## Wire protocol

The daemon implements the daemon-side of `proto/README.md` (subprotocol
`spawn.v1`). Binary PTY frames are `u8 kind | 16-byte big-endian uuid |
bytes`, with `0x01` for output (daemon→server) and `0x02` for input
(server→daemon).

## Process model

Each agent is an OTP worker backed by an `erlexec` OS process. The daemon
writes browser stdin directly to the PTY, forwards PTY output as binary
frames, keeps an in-memory snapshot buffer for reconnect history, and sends
TERM followed by KILL when an agent is stopped.

## Dev

```sh
rebar3 eunit
rebar3 release
rebar3 escriptize
```
