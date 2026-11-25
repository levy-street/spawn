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
                root_introductions, sessions, support_log, support_log_account, trust_bundle, waitlist,
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
  daemon_release_offers.py offers a newly active daemon release to connected daemons
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

## Daemon release offers

Registration offers the active daemon release to each daemon that registers
(`_auto_update_after_registration` in `ws/daemon.py`). A deploy restarts the
server before it switches the prebuilt `current` pointer, so every daemon
registers again while the previous release is still active. Without a second
path, a connected daemon would get each release one registration late, which
usually means at the next deploy.

`daemon_release_offers.py` is that second path. It is one lifespan task,
started and stopped like the support log pump. Every 15 seconds it reads the
active manifest in a worker thread, because the first read of a new release
hashes every binary the manifest lists. The tree and the release counter name
a release. At startup the task records the active release and offers nothing.
When the release changes, it calls the registration's own offer function for
each connected daemon, one host at a time, with two seconds between offers. It
calls it only for hosts that function would give an ordinary update: automatic
updates on, the host behind the release, self-update available, not already
updating, and not failed for this release. A host whose worker pair is
mismatched is left to registration. Registration repairs such a host whatever
its update state and whatever the automatic-update setting, and a second offer
while the first is running would be refused by the daemon as busy and stored as
a failure for the new release. A host marked updating is left alone however
long ago the update began. That function stops counting an update as running
after three minutes, but a daemon still busy with it would refuse the new
release, which would then be stored as failed. Registration settles the mark
when the host next connects.

Just before each offer the task pings the daemon (`request_host_ping`, two
seconds). A send into the socket of a machine that has just gone to sleep still
succeeds, and the release would then be stored as failed for that host when it
came back on its old build. So a daemon that does not answer, or whose ping
fails, is offered nothing and its host row is not written; its next
registration offers the release. Every daemon that can update itself answers
pings.

Nothing is offered while the manifest is unreadable or missing. Nothing is
offered when the release changes to one the task has already seen, or to one
whose counter is lower than any it has seen. The daemon refuses a downgrade as
well.

Registration's offer reads the host, then writes it, then sends. Two callers
inside that window could both send. So the task offers only to a connection the
previous poll already saw. A connection that became routable since then is
checked on the next poll, by which time its registration has normally recorded
its own offer. Only a registration still inside its own offer a whole poll
after its connection became routable could still race the task.
The task holds no database transaction across a send and takes no lock of its
own. Stopping the server stops it between hosts; shutdown waits for the ping,
offer or manifest read in progress. Each pass logs one INFO line
with the number of connections considered and of hosts handed to the offer
function, which does not report whether it sent, and no host identifiers.

`SPAWN_DAEMON_RELEASE_OFFERS=false` means the task is never started, and only
registration offers a release. `SPAWN_DAEMON_AUTO_UPDATE=false` stops the task
from offering anything, and stops registration's offers except its repair of a
mismatched worker pair.

## Support log delivery and storage

Only an operator on the server can request a collection. The command inserts a
database record. The app controls are still to come.

When storage is ready, `GET /api/support-log` returns the signed-in owner's
stored choice, signing device, server-side sharing state, hosts' declared
capability and last seen time, and up to 100 collections from the last 365 days,
newest first. The next signing time is an unsigned millisecond count or an
object with a refusal code if the clock or the timestamp floor prevents signing.
The owner's app discovers the feature through this route. Both account routes
are absent when storage is off.

`PUT /api/support-log/consent` takes the signed wire envelope (64 KiB maximum).
The server serializes concurrent choices for one account in its single worker.
Before checking a signature it decides pacing from the stored row's `updated_at`
and the server clock. The first statement can be stored immediately. Each on
after that must wait 60 seconds from the last stored change. A 429 gives the
remaining whole seconds rounded up in `detail.retry_after_seconds`. A withdrawal
has no cooldown. A valid off when already off returns the current state and
leaves the row's time alone. This allows at most ten ons and ten offs per ten
minutes. The released daemon stops sharing for the life of its process after
30 state-changing writes in ten minutes.

Once a change commits, the server wakes the pump and publishes one
`support-log` data event to the owner's alert channel. The response has the
same fields as GET. Statements are stored and sent, never confirmed by a host.
Authentication failures return 401 with a string in `detail`. Consent refusals
carry `detail.code`. A stale statement returns 409 with the
stored `detail.issued_at_ms`. Malformed or future-dated statements return
422, bad signatures return 400, and account or signer refusals return 403.

When storage is ready, registration records the literal JSON boolean
`supports_support_log: true` in the existing host activation write. Every host
receives the ordinary `registered` frame with its full trust data. Registration
wakes the pump after a capable host finishes connecting.

The pump is the only sender of support statements and collection requests. It
runs at startup and waits about ten seconds between passes unless woken sooner.
A pass over many hosts with stalled sockets takes longer. Shutdown waits for
the send or database operation in progress. First the pump sends the current
statement in a separate `host.support_log_consent` frame to each capable host
that needs it. A signed off is sent intact. Missing consent or an on whose signer
has left the account is sent as null. A host can skip intermediate changes.
The daemon accepts this frame after `registered`. The wire document describes
delivery inside `registered` and should be aligned when the daemon next changes.
The pump skips connections whose send lock is held or has waiters. Each
support send has a 250 ms deadline on that lock. A timeout makes the pump
resend the current statement on a later pass. An ordinary frame can lose up
to 250 ms of its two-second deadline waiting for a support send to release the
lock. The installed sans-I/O backend can leave both frames buffered in the
transport after their sends return.

Next the pump cancels open requests for accounts whose sharing is off. It then
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

If the trust update reaches the released daemon before a statement signed by
the removed device, the daemon refuses that statement. Sharing stays off until
SPAWN D restarts on that machine, even if the owner turns sharing on again.
The same can happen on a fresh connection if the stored turn-off was signed
by a device that has since been removed.

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
The server process is the only writer of statements. The app route runs in
that process. While a statement commit is in progress, the pump returns an
unsent claim to requested for a later pass. If the pump sees a completed
statement change between claim and handoff, it cancels the request.
The operator can request again under the usual
pacing limits. A collect already handed to the socket cannot be recalled.
The daemon and upload route still apply the checks above.

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
the body, no support file access and no sweep task. To switch on, create an
empty private directory on local disk outside the checkout and database backups,
set `SPAWN_SUPPORT_LOG_DIR` to its absolute path, add `--ws websockets-sansio` to the
server launch command, and restart. This backend writes an automatic Pong
without competing with a paused application write for a drain waiter.
Startup checks the launch arguments before a worker prepares the directory
with mode 0700 and checks locking and writing. Under the directory lock, the server marks a
new or empty directory with the extended attribute `user.spawnd.support-log-store`,
version `v1`. A populated unmarked directory, including a legacy store, is
left alone. Keep it for manual recovery and configure a fresh empty directory.
The filesystem must support user extended attributes and named pipes. A ready
server holds the read end of `.server-ready` open. The CLI opens an existing
private marked directory and checks readiness by opening the write end of
the pipe without blocking or sending data. Before inserting
a request, `collect` locks and verifies the directory and runs the startup write probe.
Each lifespan starts dispatch, installs the
upload and account routes and starts retention only after that check succeeds. With storage
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
A signed off cancels open requests and marks collected records deleted in the
same commit. The account route leaves their files for the orphan sweep.
Account deletion reads its file IDs and commits both ordinary deletes.
After the response, a background task
tries the verified directory lock once and has two seconds to remove the
files. Each store admits one filesystem cleanup job at a time. Deletions
during that job leave their files to the orphan sweep after its grace period.
Shutdown stops new cleanup and waits up to two seconds for active cleanup
before closing the store. A stuck daemon thread owns its directory descriptor
and allows the process to exit. If it resumes, it stops before the next file.

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
