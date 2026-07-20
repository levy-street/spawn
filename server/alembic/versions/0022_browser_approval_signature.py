"""carry the browser approval proof through to the daemon

Revision ID: 0022
Revises: 0021
"""

import sqlalchemy as sa

from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The browser already signs SPAWN-HOST-PAIR-APPROVE-V1 at approval time and
    # the server verifies it, but until now it was discarded — so the daemon had
    # no way to check that a browser pin reflects real browser consent. Retain
    # it on the ceremony row so the poll response can hand it to the daemon.
    #
    # Deliberately NOT an iff-constraint against the browser binding: a ceremony
    # approved by a pre-0022 server is mid-flight when this migration lands, and
    # invalidating it would fail those pairings at poll. The shape is enforced
    # when present, and requiring it at all is the daemon's policy decision.
    with op.batch_alter_table("device_codes") as batch:
        batch.add_column(sa.Column("browser_approval_signature", sa.String(length=86), nullable=True))
        batch.create_check_constraint(
            "ck_device_codes_browser_approval_signature",
            "browser_approval_signature IS NULL OR "
            "(length(browser_approval_signature) = 86 AND browser_device_id IS NOT NULL)",
        )


def downgrade() -> None:
    # Dropping the column returns every surviving ceremony to the unproved
    # state. A downgraded server may not be used for pairing if any daemon has
    # approval-proof verification enforced, because it cannot supply the proof.
    with op.batch_alter_table("device_codes") as batch:
        batch.drop_constraint("ck_device_codes_browser_approval_signature", type_="check")
        batch.drop_column("browser_approval_signature")
