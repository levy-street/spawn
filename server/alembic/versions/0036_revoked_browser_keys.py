"""permanent revoked-browser-key tombstones

Revision ID: 0036
Revises: 0035
"""

import sqlalchemy as sa

from alembic import op

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None


# Device mesh R10: revocation is a PERMANENT tombstone. The account deny-list
# pushed to daemons used to be computed solely from browser_devices rows with
# revoked_at set — so "Clear history" (prune), which hard-deletes those roster
# rows, silently dropped the pruned keys from the deny-list and a stolen device
# carrying a cached endorsement chain was re-admitted with no fresh ceremony.
# This table is the key-level tombstone prune never touches; the deny-list is
# now the union of currently-revoked roster rows and this table.
def upgrade() -> None:
    op.create_table(
        "revoked_browser_keys",
        sa.Column("owner_user_id", sa.String(length=36), nullable=False),
        sa.Column("public_key", sa.String(length=43), nullable=False),
        sa.Column("key_algorithm", sa.String(length=16), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_by_device_id", sa.String(length=36), nullable=True),
        sa.CheckConstraint(
            "key_algorithm = 'ed25519' AND length(public_key) = 43",
            name="ck_revoked_browser_keys_ed25519_key",
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("owner_user_id", "public_key"),
    )
    # Backfill: every roster tombstone that already exists becomes a permanent
    # key tombstone, so keys revoked before this migration survive a later
    # prune. (owner, public_key) is unique among the source rows because
    # browser_devices carries a global unique on the key.
    op.execute(
        sa.text(
            "INSERT INTO revoked_browser_keys "
            "(owner_user_id, public_key, key_algorithm, revoked_at, revoked_by_device_id) "
            "SELECT owner_user_id, public_key, key_algorithm, revoked_at, revoked_by_device_id "
            "FROM browser_devices WHERE revoked_at IS NOT NULL"
        )
    )


def downgrade() -> None:
    # A tombstone whose roster row was pruned is the ONLY record keeping that
    # key denied; dropping it would silently re-admit the key (the exact defect
    # this migration fixes). Refuse to discard such knowledge by rollback —
    # while every tombstone is still mirrored by a revoked roster row, the
    # downgrade is lossless and a re-upgrade re-backfills identically.
    pruned_tombstones = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT count(*) FROM revoked_browser_keys AS tomb "
                "WHERE NOT EXISTS ("
                "SELECT 1 FROM browser_devices AS device "
                "WHERE device.owner_user_id = tomb.owner_user_id "
                "AND device.public_key = tomb.public_key "
                "AND device.revoked_at IS NOT NULL)"
            )
        )
        .scalar_one()
    )
    if pruned_tombstones:
        raise RuntimeError(
            "cannot downgrade 0036 while pruned revoked-browser-key tombstones exist"
        )
    op.drop_table("revoked_browser_keys")
