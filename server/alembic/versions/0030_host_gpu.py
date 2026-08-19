"""best-effort GPU class reported by the daemon at registration

Revision ID: 0030
Revises: 0029
"""

import sqlalchemy as sa

from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # All nullable, and they stay that way: a host with no GPU, a host whose
    # detection failed, and a host running a daemon older than this field are
    # three different situations that must all render as "no badge". Nothing
    # here is required for a host to work.
    op.add_column("hosts", sa.Column("gpu_vendor", sa.String(16), nullable=True))
    op.add_column("hosts", sa.Column("gpu_name", sa.String(128), nullable=True))
    op.add_column("hosts", sa.Column("gpu_vram_mb", sa.Integer(), nullable=True))
    op.add_column("hosts", sa.Column("gpu_count", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("hosts", "gpu_count")
    op.drop_column("hosts", "gpu_vram_mb")
    op.drop_column("hosts", "gpu_name")
    op.drop_column("hosts", "gpu_vendor")
