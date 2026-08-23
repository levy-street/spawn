"""Legion: host capacity, and a durable daily record of what the fleet did.

Revision ID: 0055
Revises: 0054

Two unrelated-looking things that exist for the same surface.

``hosts`` gains what a machine *is* and, coarsely, how hard it is working:
``cpu_cores``/``cpu_physical_cores``/``cpu_model``/``memory_bytes``/``gpu`` are
sent once at registration and never change while a daemon runs; ``cpu_bucket``
and ``mem_bucket`` ride the thirty-second heartbeat and hold a reading in
``0..=5`` — a meter segment count, not a percentage. That distinction is
load-bearing rather than cosmetic: a per-second utilization trace of somebody's
machines is a behavioural fingerprint, and docs/TRUST.md names this server as
an adversary. Exact figures travel browser-to-daemon over ``spawn.host.ctl``
and are never written here. ``capacity_at`` stamps the last bucket write so the
UI can tell "idle" from "this daemon predates telemetry, or has it switched
off", both of which leave the buckets NULL.

``legion_days`` is the durable half. Session rows are hard-deleted when a
workspace is deleted, so nothing in the schema currently remembers that work
happened — a profile built on ``sessions`` would show a person's history
shrinking as they tidy up. One append-only row per owner per UTC day, counters
only: sessions started, seconds run, the day's peak simultaneous session and
online-host counts, and a small JSON tally of foreground agent basenames (the
same already-disclosed ``session.foreground`` vocabulary — ``claude``,
``codex``, ``cargo`` — never arguments or paths).

Both are additive. Every existing host reports NULL capacity until its daemon
reconnects, and the daily table simply starts empty.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0055"
down_revision = "0054"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("hosts") as batch:
        batch.add_column(sa.Column("cpu_cores", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("cpu_physical_cores", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("cpu_model", sa.String(128), nullable=True))
        batch.add_column(sa.Column("memory_bytes", sa.BigInteger(), nullable=True))
        batch.add_column(sa.Column("gpu", sa.String(128), nullable=True))
        batch.add_column(sa.Column("cpu_bucket", sa.SmallInteger(), nullable=True))
        batch.add_column(sa.Column("mem_bucket", sa.SmallInteger(), nullable=True))
        batch.add_column(
            sa.Column("capacity_at", sa.DateTime(timezone=True), nullable=True)
        )
        # A bucket is a meter segment count. Anything outside 0..5 is a bug in
        # a daemon or a forged frame, and either way must not reach the UI.
        batch.create_check_constraint(
            "ck_hosts_cpu_bucket_range",
            "cpu_bucket IS NULL OR (cpu_bucket >= 0 AND cpu_bucket <= 5)",
        )
        batch.create_check_constraint(
            "ck_hosts_mem_bucket_range",
            "mem_bucket IS NULL OR (mem_bucket >= 0 AND mem_bucket <= 5)",
        )

    op.create_table(
        "legion_days",
        sa.Column("owner_user_id", sa.String(36), nullable=False),
        # A plain ISO date string, not a DATE: the rollup is keyed on the UTC
        # calendar day the server computed, and storing the string it computed
        # keeps SQLite and Postgres reading back identically.
        sa.Column("day", sa.String(10), nullable=False),
        sa.Column("sessions_started", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("session_seconds", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("peak_sessions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("peak_hosts_online", sa.Integer(), nullable=False, server_default="0"),
        # {"claude": 12, "codex": 3} — basenames only, bounded server-side.
        sa.Column("agents", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("owner_user_id", "day"),
    )
    op.create_index(
        "ix_legion_days_owner_day",
        "legion_days",
        ["owner_user_id", "day"],
    )


def downgrade() -> None:
    op.drop_index("ix_legion_days_owner_day", table_name="legion_days")
    op.drop_table("legion_days")
    with op.batch_alter_table("hosts") as batch:
        batch.drop_constraint("ck_hosts_mem_bucket_range", type_="check")
        batch.drop_constraint("ck_hosts_cpu_bucket_range", type_="check")
        batch.drop_column("capacity_at")
        batch.drop_column("mem_bucket")
        batch.drop_column("cpu_bucket")
        batch.drop_column("gpu")
        batch.drop_column("memory_bytes")
        batch.drop_column("cpu_model")
        batch.drop_column("cpu_physical_cores")
        batch.drop_column("cpu_cores")
