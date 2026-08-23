"""Template home: the folder a template was saved from.

Revision ID: 0049
Revises: 0048
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0049"
down_revision = "0048"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("workspace_templates") as batch:
        batch.add_column(
            sa.Column(
                "host_id",
                sa.String(36),
                sa.ForeignKey(
                    "hosts.id",
                    ondelete="SET NULL",
                    # SQLite batch mode requires named constraints.
                    name="fk_workspace_templates_host_id_hosts",
                ),
                nullable=True,
            )
        )
        batch.add_column(sa.Column("cwd", sa.String(1024), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("workspace_templates") as batch:
        batch.drop_column("cwd")
        batch.drop_column("host_id")
