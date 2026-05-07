# spawn-server

The control-plane server for `spawn`. FastAPI + SQLAlchemy 2.0 (async) +
Postgres + Redis. Brokers REST and WebSocket traffic between the web app and
the per-host Rust daemons (`spawnd`).

See `../docs/DESIGN.md` for the full architecture and `../proto/README.md` for
the wire protocol this server implements.

## Setup

```bash
# install deps
uv sync

# copy env template (from repo root)
cp ../.env.example .env
# fill in SPAWN_VAULT_KEY (32 random bytes hex) and SPAWN_JWT_SECRET

# start postgres + redis (use ../infra/ compose if present, or your own)
# then run migrations
uv run alembic upgrade head

# run dev server
uv run uvicorn spawn_server.main:app --reload --port 8000
```

## Migrations

```bash
uv run alembic revision -m "describe change" --autogenerate
uv run alembic upgrade head
```

The initial migration `0001_initial.py` creates `users`, `hosts`,
`credentials`, `presets`, `agents`, `device_codes` and seeds the built-in
presets. Built-in presets are also re-seeded idempotently on app startup.

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
