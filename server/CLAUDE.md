# Working agreements for server/

The FastAPI server: HTTP API, browser and daemon websockets, and the installer
(including the daemon prebuilts it hands out). SQLAlchemy + Alembic on
Postgres, Redis for pub/sub. `AGENTS.md` beside this file is a symlink to it.
Read the repo root `CLAUDE.md` first: both frontends are clients of this API,
so a contract change here lands with matching `web/` and `mobile/` changes in
the same commit.

## Layout

```
spawn_server/
  routes/       one module per HTTP surface: auth, auth_config,
                auth_providers, account_recovery, admin, agents,
                browser_devices, capabilities, device, device_pairing,
                host_introductions, hosts, install, profile, push, release,
                root_introductions, sessions, support_log, trust_bundle, waitlist,
                workspace_templates, workspaces
  ws/           websocket handlers: browser.py, daemon.py, host.py,
                broker.py, alerts.py, activity.py, host_signal.py,
                owner_dispatch.py, signed_signal_relay.py, reliability.py,
                close_codes.py
  models.py     SQLAlchemy models — the schema of record
  schemas.py    pydantic request/response shapes
  main.py       app assembly, startup, route registration
  support_consent.py       signed statement encoding, validation and current storage
  support_log.py           request admission, pacing and conditional state transitions
  support_log_dispatch.py  the server process's collection pump and statement delivery
  support_log_cli.py       the operator command, run locally with the server settings
  support_log_types.py     exact unsigned timestamps on SQLite and PostgreSQL
  support_log_files.py     private atomic disk writes and file presence checks
  support_log_retention.py bounded sweeps, withdrawal and account deletion cleanup
  <concern>.py  one module per concern: auth, config, db, redis, mail, push,
                web_push, release, invites, limits, rate_limit, trust_events,
                data_events, host_status, …
alembic/        migrations
tests/          pytest; test_<module>.py mirrors the module it covers
```

## Where things go

- A new endpoint: the matching `routes/<area>.py` (or a new one), request and
  response shapes in `schemas.py`, tests in `tests/test_<area>.py`.
- Hosted daemon installers are rendered by `routes/install.py` at `/install.sh`
  and `/install.ps1`. Prebuilt API paths stay extensionless; canonical Windows
  files and download filenames keep `.exe` (`spawnd.exe`,
  `spawn-worker.exe`).
  `release.prebuilt_root()` pins the atomic `current` pointer to one immutable
  published generation per request, with legacy flat-directory compatibility.
  All manifest and binary reads use this resolver; publication never mutates
  the previous generation or paths retained by in-flight downloads.
- A new websocket frame: the matching `ws/` module — daemon frames in
  `ws/daemon.py`, browser frames in `ws/browser.py`. The daemon side of the
  wire lives in `daemon/src/`; change both sides in the same commit. The
  subprotocol names each module enforces (`spawn.control.v3`, `spawn.v3`,
  `spawn.alerts.v1`) are the compatibility contract every deployed peer is held
  to — adding a frame never touches them, and changing one is a fleet-wide
  cutover: read "The wire protocols" in `docs/RELEASE.md` before you do.
- A schema change: `models.py` plus an Alembic revision. Keep a single head —
  check `alembic heads` after any merge. Migrations run before the new server
  starts, so old code must tolerate the new schema (`docs/RELEASE.md`).
- Validate at the boundary: request bodies through pydantic, websocket frames
  field by field before use.
- Production's database is SQLite. `db.py` sets every connection's pragmas —
  WAL, a fifteen-second busy timeout, `synchronous=NORMAL`, foreign keys — so
  readers never wait on a writer. A `database is locked` in the log is a
  transaction held open too long, never a reason to add a retry.

Agent installation through REST is refused after ownership checks; the server
does not dispatch installers or run an agent auto-update scheduler. Historical
policies remain stored but inactive. Do not restore these effects from a
server-side flag: `docs/DAEMON_COMMAND_AUTHORITY.md` records the endpoint
authorization and durable-state requirements for their replacement.

- Shared device RTC uses `/ws/host?rtc_version=2` with the existing
  `spawn.host.v1` websocket subprotocol. Relay only signed host-v2 envelopes;
  preserve the exact binding tuple through offers, resume, and close. Legacy
  host-v1 and session-v2 routes remain supported. The daemon advertises
  `supports_device_connections`; an old daemon must produce an explicit update
  refusal. Session channel attachment never becomes a server signaling route.

## Support log delivery and storage

Only an operator on the server can request a collection. The command inserts a
database record. The app signing switch and owner history are still to come.

When storage is ready, registration records the literal JSON boolean
`supports_support_log: true` in the existing host activation write. Every host
receives the ordinary `registered` frame with its full trust data. Registration
wakes the pump after a capable host finishes connecting.

The pump is the only sender of support statements and collection requests. It
runs at startup, on wake and about every ten seconds. First it sends the current
statement in a separate `host.support_log_consent` frame to each capable host
that needs it. A signed off is sent intact. Missing consent or an on whose signer
has left the account is sent as null. A host can skip intermediate changes.
The daemon accepts this frame after `registered`. The wire document describes
delivery inside `registered` and should be aligned when the daemon next changes.
Each send has a two-second deadline. The pump retries a missed statement on a later pass. Next
the pump cancels open requests for accounts whose sharing is off. It then
checks pending requests against the enabled statement sent on this connection.

The released daemon denies sharing until its process restarts if an ordinary
`registered` frame exceeds 65,536 UTF-8 bytes, even with consent omitted, and
tries once to erase its stored statement. The server leaves a 1,024-byte margin.
Above 64,512 bytes it logs once and withholds both support frames for the whole
connection. Lifting the daemon limit requires a daemon change. A consent frame
over 64,512 bytes is also withheld until the current statement fits. The local
operator command sees the last declared capability in the database. It cannot
see a connection's frame size, so a request can wait until it expires.

Removing the signer still sends the ordinary trust update. A collect claimed
just before removal can be sent just after the removal commits. At request start
the daemon checks its stored on statement and whether it still admits the
signer. One bundle can already be in flight. The server rejects uploads if
sharing is off at arrival and checks sharing again before storing a bundle.

A host can have one open request and must wait five minutes between dispatches.
An account can request up to ten collections in a rolling 24 hours. The same
limit on dispatch times covers requests delayed while a host was offline.
The server allows two dispatched records across all accounts. A body still
being read occupies a slot even after its record closes. The pump reads pages
of 32 in request-time and ID order, yields between candidates and stops
claiming once full or stopping. Admission and
dispatch check the records table, including attempts that failed or were
declined. Dispatch verifies the socket owner and the enabled statement last
sent there, commits the conditional transition, then sends `support_log.collect`
with the request ID and a window of 60 to 259200 seconds. A failed send stays
dispatched until retention closes it. The server sends each request at most once.

Run `python -m spawn_server.support_log_cli` from the server directory with
the server's settings. All commands accept `--json` for one output object.

| Command | Result |
| --- | --- |
| `accounts` | Accounts with sharing on and their hosts' last seen time and last capability declaration |
| `collect --account <id-or-email> --host <id-or-name> --reason <text> [--by <label>] [--hours N] [--wait SECONDS]` | Creates one request. The reason is 1 to 200 characters. Supply a label through `--by` or `SPAWN_SUPPORT_LOG_BY`. Hours must be positive and at most 72, with a default of 24. The wait is 0 to 86400 seconds. Waiting polls the database and returns the last state when the deadline passes. |
| `status <id>` | Current state and any typed refusal |
| `list [--account <id-or-email>] [--days N]` | Requests in the chosen period, seven days by default |
| `show <id> [--raw]` | Read the unexpired collected bundle locally. Raw output refuses a terminal. |
| `purge` | Run one bounded retention pass |

The operator can read the whole bundle as the machine reported it. The server
checks its form and cannot guarantee what the events contain. Under the store
lock, `show` verifies a regular file, size, SHA-256 and JSON object framing
before printing. Default output prints one object per line with terminal
controls escaped. `show --raw` refuses a terminal and otherwise writes the stored bytes unchanged. Metadata commands omit tokens, keys and signatures. An account-scoped
lookup exposes no other account's data.

Exit codes are 0 for success, 2 for usage, 3 for sharing off, 4 for a host
outside the account or unknown there, 5 for missing capability, 6 for an open
request, 7 for pacing, 8 for unavailable storage and 9 for a missing account,
record or readable collection result. Use the host ID when names repeat.

`POST /api/support-log/uploads/{request_id}` accepts only a daemon token bound
to a dispatched collection.

`SPAWN_SUPPORT_LOG_DIR` is unset by default. Unset means 404 without reading
the body, no support file access and no sweep task. Use an absolute private
directory outside the repository checkout. It must be on the server's local
disk because startup waits for a worker thread to prepare it with mode 0700
and check locking and writing. Under the directory lock, the server marks a
new or empty directory with the extended attribute `user.spawnd.support-log-store`,
version `v1`. A populated unmarked directory, including a legacy store, is
left alone. Keep it for manual recovery and configure a fresh empty directory.
The filesystem must support user extended attributes. The CLI opens an existing
private marked directory and never creates, marks or chmods it. Before inserting
a request, `collect` locks and verifies the directory and runs the startup write probe.
Each lifespan starts dispatch, installs the
upload route and starts retention only after that check succeeds. With storage
off, registration sends its ordinary frame and performs its ordinary SQL. A failure logs one error and
keeps storage off for that lifespan.
Keeping bundles outside the checkout prevents a deploy or source backup from
copying plain diagnostic logs. They are separate from database backups.

Files are `<record id>.ndjson`, mode 0600, written through a flushed and synced
temporary file in the same directory before rename and database completion.
A directory lock coordinates publication and deletion across server workers.
Database transactions never span a body read or filesystem work. File status
reports a missing collected file explicitly; it never substitutes an empty log.

Retention starts in the background at startup and repeats every 15 minutes.
Each pass handles at most 100 entries in each category: expired bundles,
old requested records, old dispatched records, year-old records and directory
entries. The orphan sweep verifies the store identity under lock and considers
only canonical `<uuid>.ndjson` and `.upload-<uuid>.tmp` names. Directory
scanning resumes across passes. Bundles expire after seven
days; orphans get ten minutes of grace. Open requests expire after 24 hours or
fail five minutes after dispatch. Collection records last at most 365 days,
subject to the bounded sweep backlog. Signed statements have no expiry.

The statement table retains the original signed device ID alongside the nullable
roster reference, so pruning a removed device preserves the signed artifact.
Unsigned millisecond timestamps use 20-digit decimal text: SQLite integers
cannot represent all of u64. This preserves ordering without rounding.
Removing a signer makes every sharing check false without rewriting the statement.
The app route should pass the ready store to `store_statement`. A signed off
cancels open requests and marks collected records deleted in the same commit.
File cleanup then uses only those record IDs. Account deletion reads its file
IDs, commits both ordinary deletes and immediately tries file cleanup. Cleanup
tries the verified directory lock once and has a two-second deadline. The
orphan sweep removes leftovers after its grace period.

HTTP metadata uses unsigned event counts and signed 64-bit time ranges; the
first NDJSON object is the header and is excluded from the event count. The
server checks JSON object framing, not a new event schema. Content types are
the two exact wire values, without parameters. Malformed refusals and
unsupported content types close the attempt as failed, as malformed bundles do.
JSON refusals have a 256-byte cap. An oversized declared body is refused before
parsing support headers; absent Content-Length still uses the streaming bound.
The stored time range and line count are what the machine reported, checked
only for form and framing, not verified against event contents. Each process
permits one upload per record and four body reads at once; excess requests
receive 409 or 503 before reading, leaving the record untouched. Each body has
a total receive deadline of 60 seconds; expiry returns 408 and marks the record
failed.
The daemon independently checks consent and trust; these server checks cannot
enable sharing.

## Before calling a change done

```bash
.venv/bin/ruff check . && .venv/bin/python -m pytest -q
```

## Keeping this file true

Agents and people plan work from this file, so a stale version misroutes every
change that follows it. A commit that adds, renames, or moves a directory
under `spawn_server/`, changes a convention, or changes a command above
updates this file in the same commit. `scripts/check-claude-md.sh` (run by
`scripts/test-all.sh`) fails when a tracked directory here is not named in
this file.
