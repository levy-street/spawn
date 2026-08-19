"""per-preset autonomy flag, so the server owns the argv composition

Revision ID: 0031
Revises: 0030
"""

import sqlalchemy as sa

from alembic import op

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Extra argv appended when an agent is created with YOLO on. Null means
    # "this tool has no such concept, or we have not confirmed one" — which is
    # not the same as an empty list, and the UI hides the toggle for it rather
    # than offering something that would do nothing.
    op.add_column("presets", sa.Column("yolo_argv", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("presets", "yolo_argv")
