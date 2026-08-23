"""Workspace icon: a folder's own mark instead of two grey letters.

Revision ID: 0054
Revises: 0053

Every workspace in the sidebar wears the same monogram tile, so the list reads
as one shape repeated. A project almost always ships something better — a
favicon, an app icon, a logo — and the browser can find it over the host
control channel and hand back a small square thumbnail.

``icon`` holds that thumbnail as a self-contained ``data:image/(png|webp)``
URL, validated on every write by ``schemas.validate_workspace_icon``: never a
remote URL (which would make each sidebar render fetch from a third party) and
never SVG (which carries markup). Null means the monogram, exactly as before.

``icon_source`` records whether the question is *settled*, which is the part
``icon`` alone cannot say — a null icon is both "nobody has looked yet" and
"looked, found nothing", and only the first should trigger a scan. NULL is
unlooked; ``auto`` (the folder scan found one), ``custom`` (the owner chose
it, or deliberately cleared it) and ``none`` (scanned, nothing worth using)
all mean: leave it alone.

Both columns land on ``workspace_templates`` too, so a template carries the
mark of the workspace it was saved from.

Two nullable columns per table, no data migration: every existing row is
unlooked (``icon_source IS NULL``) and gets its scan the next time it opens.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0054"
down_revision = "0053"
branch_labels = None
depends_on = None

_TABLES = ("workspaces", "workspace_templates")


def upgrade() -> None:
    for table in _TABLES:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("icon", sa.Text(), nullable=True))
            batch.add_column(sa.Column("icon_source", sa.String(16), nullable=True))


def downgrade() -> None:
    for table in _TABLES:
        with op.batch_alter_table(table) as batch:
            batch.drop_column("icon_source")
            batch.drop_column("icon")
