# spawn-server

The control-plane server for `spawn`. FastAPI + SQLAlchemy 2.0 (async), with
SQLite for local development and Postgres/Redis for production-style
deployments. It brokers REST and WebSocket traffic between the web app and the
per-host Erlang/OTP daemons (`spawnd`).

See `../docs/DESIGN.md` for the full architecture and `../proto/README.md` for
the wire protocol this server implements.

## Setup

```bash
# install deps
uv sync

# copy env template (from repo root)
cp ../.env.example .env
# set SPAWN_JWT_SECRET for shared or production environments

# optional for local single-process development:
# export SPAWN_DATABASE_URL=sqlite+aiosqlite:///./data/spawn.db
# export SPAWN_USE_INPROCESS_PUBSUB=1

# for Postgres/Redis deployments, start those services and set:
# export SPAWN_DATABASE_URL=postgresql+asyncpg://...
# export SPAWN_REDIS_URL=redis://...

# run migrations
uv run alembic upgrade head

# run dev server
uv run uvicorn spawn_server.main:app --reload --port 8000
```

## Migrations

```bash
uv run alembic revision -m "describe change" --autogenerate
uv run alembic upgrade head
```

The initial migration `0001_initial.py` creates `users`, `hosts`, `presets`,
`agents`, and `device_codes`, then seeds the built-in presets. Later migrations
add preset install metadata, agent display/activity fields, host tool policies,
and pinning. Built-in presets are re-synchronized idempotently on app startup.

## Tests

```bash
uv run pytest -q
```

Tests use SQLite in-memory by default so no Postgres is needed for the
sanity suite.

## Lint

```bash
uv run ruff check .
uv run ruff format .
```
