"""committed-ephemeral SAS fields for device pairing

Revision ID: 0030
Revises: 0029
"""

import sqlalchemy as sa

from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


# The dumb-relay columns for the 3-move committed SAS (docs/TRUST_DEVICE_MESH.md
# Appendix A). The server only stores and forwards these opaque values; it can
# neither forge a matching number nor read anything. All are 43-char base64url
# (32-byte hash / nonces / Ed25519 key). Nullable: a pre-0030 daemon or browser
# simply never sets them, and the flow falls back to the full fingerprint.
_COLS = ("sas_commit", "sas_browser_nonce", "sas_browser_key", "sas_host_nonce")


def upgrade() -> None:
    for col in _COLS:
        op.add_column("device_codes", sa.Column(col, sa.String(43), nullable=True))


def downgrade() -> None:
    for col in reversed(_COLS):
        op.drop_column("device_codes", col)
