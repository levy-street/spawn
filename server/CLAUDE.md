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
                root_introductions, sessions, trust_bundle, waitlist,
                workspace_templates, workspaces
  ws/           websocket handlers: browser.py, daemon.py, host.py,
                broker.py, alerts.py, activity.py, host_signal.py,
                owner_dispatch.py, signed_signal_relay.py, reliability.py,
                close_codes.py
  models.py     SQLAlchemy models — the schema of record
  schemas.py    pydantic request/response shapes
  main.py       app assembly, startup, route registration
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
