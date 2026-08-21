"""SQLAlchemy 2.0 ORM models."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base
from .limits import MAX_SAFE_FENCING_GENERATION


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _new_uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    # Bumped whenever every existing session must stop working (password
    # reset). Tokens carry the epoch they were minted under, so a stale one is
    # refused even though JWTs are otherwise stateless and unrevocable.
    session_epoch: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    email_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Grants the admin surface. Bootstrapped from SPAWN_ADMIN_EMAILS (or the
    # first account on a fresh install) rather than hardcoded anywhere.
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    hosts: Mapped[list[Host]] = relationship(back_populates="owner")
    agents: Mapped[list[Agent]] = relationship(back_populates="owner")
    skills: Mapped[list[Skill]] = relationship(back_populates="owner")
    auth_identities: Mapped[list[AuthIdentity]] = relationship(back_populates="user")
    auth_provider_states: Mapped[list[AuthProviderState]] = relationship(back_populates="user")
    browser_devices: Mapped[list[BrowserDevice]] = relationship(back_populates="owner")
    host_key_claims: Mapped[list[HostKeyClaim]] = relationship(back_populates="owner")


class BrowserDevice(Base):
    """Account-bound browser Ed25519 key, retained after revocation as a tombstone."""

    __tablename__ = "browser_devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    key_algorithm: Mapped[str] = mapped_column(String(16), nullable=False)
    public_key: Mapped[str] = mapped_column(String(43), nullable=False)
    # Recognition only, never verification: server-stored and server-mutable, so
    # a hostile server could label its own device convincingly. The fingerprint
    # remains the value an operator compares.
    label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # The account ROOT (device mesh §3, stage 5), not a real browser: pk_R held
    # here so it reuses the endorsement store, pin/anchor delivery, and chain
    # validation. A root never connects (it has no browser and no RTC), only
    # endorses (R→d) and anchors. At most one per account.
    is_root: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    # Stamped whenever the device's identity registration reconciles (each app
    # load) — an honest "last seen" without per-request tracking.
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Stamped when this (unapproved) device actively asks to be approved — it
    # tried to open an agent session. Lets other devices surface, and
    # re-surface, the approval toast. Advisory display data, never authorization.
    approval_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Which of the account's devices asked for the revocation (R4: the removed
    # screen names its remover). Advisory display data, never authorization.
    revoked_by_device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    owner: Mapped[User] = relationship(back_populates="browser_devices")
    host_pins: Mapped[list[HostBrowserPin]] = relationship(
        back_populates="browser_device", passive_deletes=True
    )

    __table_args__ = (
        CheckConstraint(
            "key_algorithm = 'ed25519' AND length(public_key) = 43",
            name="ck_browser_devices_ed25519_key",
        ),
        UniqueConstraint(
            "key_algorithm",
            "public_key",
            name="uq_browser_devices_public_key",
        ),
        # DB-level guard behind the "at most one root" app check in the
        # register route: a concurrent double-mint must not fork the account's
        # trust anchor. Partial (live roots only) so rotation — revoke the old
        # root, mint a successor — still works.
        Index(
            "uq_browser_devices_live_root",
            "owner_user_id",
            unique=True,
            sqlite_where=text("is_root AND revoked_at IS NULL"),
            postgresql_where=text("is_root AND revoked_at IS NULL"),
        ),
    )


class RevokedBrowserKey(Base):
    """Permanent, account-scoped tombstone for a revoked browser key (R10).

    The account deny-list pushed to daemons must never shrink: revocation is a
    permanent tombstone, and re-admitting a device requires a fresh ceremony
    over a NEW key, never un-revoking. The ``browser_devices`` tombstone row is
    roster history the operator may prune ("Clear history"); this row is the
    key-level fact that survives that prune, so a pruned key can never drop out
    of the deny-list and be re-admitted via a cached endorsement chain. Nothing
    deletes rows here (account deletion cascades aside): the deny-list is
    computed as the union of currently-revoked roster rows and this table.
    """

    __tablename__ = "revoked_browser_keys"

    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    public_key: Mapped[str] = mapped_column(String(43), primary_key=True)
    key_algorithm: Mapped[str] = mapped_column(String(16), nullable=False)
    revoked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Advisory attribution carried over from the roster row; never authorization.
    revoked_by_device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "key_algorithm = 'ed25519' AND length(public_key) = 43",
            name="ck_revoked_browser_keys_ed25519_key",
        ),
    )


class AuthIdentity(Base):
    __tablename__ = "auth_identities"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    provider_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="auth_identities")

    __table_args__ = (
        UniqueConstraint("provider", "provider_user_id", name="uq_auth_identities_provider_user"),
    )


class AuthProviderState(Base):
    __tablename__ = "auth_provider_states"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    state_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    return_to: Mapped[str] = mapped_column(String(2048), nullable=False, default="/")
    user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    user: Mapped[User | None] = relationship(back_populates="auth_provider_states")


class TrustBundle(Base):
    """The operator's sealed trust bundle: ciphertext the server cannot read.

    Holds the host keys this account has verified out of band, encrypted under
    a key derived from a WebAuthn PRF secret that never leaves the operator's
    authenticator. The server stores and serves these bytes without being able
    to read or forge them -- that is the entire point, and it is what lets a new
    device learn real host keys without trusting this server.
    """

    __tablename__ = "trust_bundles"

    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # Canonical base64url of iv || AES-GCM ciphertext. Opaque here by design.
    sealed: Mapped[str] = mapped_column(Text, nullable=False)
    # Monotonic, client-supplied. Lets a device notice it is about to overwrite
    # a newer bundle sealed by another device rather than silently clobbering it.
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    __table_args__ = (
        CheckConstraint("length(sealed) > 0", name="ck_trust_bundles_sealed_present"),
        CheckConstraint("revision >= 1", name="ck_trust_bundles_revision_positive"),
    )


class PasskeyCredential(Base):
    """A WebAuthn credential ID used to unlock the trust bundle.

    Deliberately not secret and deliberately unverified: the PRF secret is
    derived and consumed entirely in the browser, so the server never checks an
    assertion. A server that tampers with this list can only cause an unlock to
    fail -- it cannot learn or forge the secret, which lives in the
    authenticator. Corrupting it is denial of service, not disclosure.
    """

    __tablename__ = "passkey_credentials"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    credential_id: Mapped[str] = mapped_column(String(512), nullable=False)
    label: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint("owner_user_id", "credential_id", name="uq_passkey_owner_credential"),
        CheckConstraint("length(credential_id) > 0", name="ck_passkey_credential_id_present"),
    )


class HostKeyClaim(Base):
    """Durable account ownership for a stable host identity key."""

    __tablename__ = "host_key_claims"

    host_key_algorithm: Mapped[str] = mapped_column(String(16), primary_key=True)
    host_public_key: Mapped[str] = mapped_column(String(43), primary_key=True)
    owner_user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    owner: Mapped[User] = relationship(back_populates="host_key_claims")

    __table_args__ = (
        CheckConstraint(
            "host_key_algorithm = 'ed25519' AND length(host_public_key) = 43",
            name="ck_host_key_claims_ed25519_key",
        ),
    )


class Host(Base):
    __tablename__ = "hosts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    os: Mapped[str | None] = mapped_column(String(64), nullable=True)
    arch: Mapped[str | None] = mapped_column(String(64), nullable=True)
    version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # The daemon advertises chain admission at register (mesh R9): once true,
    # the legacy per-host device-endorsement path is refused for this host so a
    # hostile server cannot steer admission onto the weaker rail. Ratchets up
    # only — an old build reconnecting must not reopen the retired path.
    supports_account_chains: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Nullable only for hosts created before the 0017 pairing migration. Every
    # new device-code approval stores an immutable Ed25519 pin here.
    host_key_algorithm: Mapped[str | None] = mapped_column(String(16), nullable=True)
    host_public_key: Mapped[str | None] = mapped_column(String(43), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="offline", nullable=False)
    daemon_connection_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    daemon_generation: Mapped[int] = mapped_column(
        BigInteger,
        CheckConstraint(
            f"daemon_generation BETWEEN 0 AND {MAX_SAFE_FENCING_GENERATION}",
            name="ck_hosts_daemon_generation_safe",
        ),
        default=0,
        server_default="0",
        nullable=False,
    )
    daemon_generation_counter: Mapped[int] = mapped_column(
        BigInteger,
        CheckConstraint(
            f"daemon_generation_counter BETWEEN 0 AND {MAX_SAFE_FENCING_GENERATION}",
            name="ck_hosts_daemon_generation_counter_safe",
        ),
        CheckConstraint(
            "daemon_generation_counter >= daemon_generation",
            name="ck_hosts_daemon_generation_counter_monotonic",
        ),
        default=0,
        server_default="0",
        nullable=False,
    )
    daemon_pending_connection_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    daemon_pending_generation: Mapped[int | None] = mapped_column(
        BigInteger,
        CheckConstraint(
            f"daemon_pending_generation IS NULL OR daemon_pending_generation BETWEEN 1 AND {MAX_SAFE_FENCING_GENERATION}",
            name="ck_hosts_daemon_pending_generation_safe",
        ),
        CheckConstraint(
            "(daemon_pending_connection_id IS NULL) = (daemon_pending_generation IS NULL)",
            name="ck_hosts_daemon_pending_owner_pair",
        ),
        nullable=True,
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    owner: Mapped[User] = relationship(back_populates="hosts")
    agents: Mapped[list[Agent]] = relationship(back_populates="host")
    browser_pins: Mapped[list[HostBrowserPin]] = relationship(
        back_populates="host", passive_deletes=True
    )

    __table_args__ = (
        CheckConstraint(
            "(host_key_algorithm IS NULL AND host_public_key IS NULL) OR "
            "(host_key_algorithm IS NOT NULL AND host_public_key IS NOT NULL AND "
            "host_key_algorithm = 'ed25519' AND length(host_public_key) = 43)",
            name="ck_hosts_host_key_pair",
        ),
        UniqueConstraint(
            "host_key_algorithm",
            "host_public_key",
            name="uq_hosts_host_public_key",
        ),
    )


class HostBrowserPin(Base):
    """Immutable snapshot of one browser identity explicitly approved for a host."""

    __tablename__ = "host_browser_pins"

    host_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("hosts.id", ondelete="CASCADE"), primary_key=True
    )
    browser_device_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("browser_devices.id", ondelete="CASCADE"), primary_key=True
    )
    browser_key_algorithm: Mapped[str] = mapped_column(String(16), nullable=False)
    browser_public_key: Mapped[str] = mapped_column(String(43), nullable=False)
    browser_key_fingerprint: Mapped[str] = mapped_column(String(23), nullable=False)
    # Present when this pin was created by endorsement rather than by the device
    # ceremony. Retained so the daemon can re-verify the signature against the
    # browser keys it already trusts instead of believing this row.
    endorser_device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    endorsement_signature: Mapped[str | None] = mapped_column(String(86), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    host: Mapped[Host] = relationship(back_populates="browser_pins")
    browser_device: Mapped[BrowserDevice] = relationship(back_populates="host_pins")

    __table_args__ = (
        CheckConstraint(
            "browser_key_algorithm = 'ed25519' AND length(browser_public_key) = 43 "
            "AND length(browser_key_fingerprint) = 23",
            name="ck_host_browser_pins_key",
        ),
    )


class DeviceEndorsement(Base):
    """One device account-endorsing another: a directed edge in the account's
    device trust graph, with NO host binding (docs/TRUST_DEVICE_MESH.md §3).

    This is the account-scoped successor to the per-host endorsement stored on
    HostBrowserPin. The server stores and relays these but is NOT their
    authority and does not gate on the endorser being "trusted" — in the mesh,
    trust is decided by the daemon when it validates a carried chain against its
    own anchors, not by this table. Storing an edge grants nothing: an edge from
    a device that does not chain to a host's anchor is inert. Retained as an
    immutable record; trust is withdrawn via the revocation deny-list on keys,
    not by deleting rows.
    """

    __tablename__ = "device_endorsements"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    endorser_device_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("browser_devices.id", ondelete="CASCADE"), nullable=False
    )
    endorsed_device_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("browser_devices.id", ondelete="CASCADE"), nullable=False
    )
    # base64url of the 64-byte Ed25519 signature over the SPAWN-ACCT-ENDORSE-V1
    # transcript (86 chars). The daemon re-verifies this; the server only checks
    # it to keep malformed rows out.
    signature: Mapped[str] = mapped_column(String(86), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint(
            "endorser_device_id",
            "endorsed_device_id",
            name="uq_device_endorsements_pair",
        ),
        CheckConstraint(
            "endorser_device_id <> endorsed_device_id",
            name="ck_device_endorsements_not_self",
        ),
        CheckConstraint(
            "length(signature) = 86",
            name="ck_device_endorsements_signature",
        ),
    )


class DevicePairing(Base):
    """A browser↔browser committed-ephemeral SAS ceremony to admit a new device
    to the account's trust mesh (docs/TRUST_DEVICE_MESH.md §4, Appendix A).

    An existing device (the *initiator*, in the daemon's commit-first role) and a
    new device (the *joiner*) each contribute a fresh 32-byte ephemeral nonce and
    their own public key. The initiator commits to its nonce before the joiner
    reveals, so a substituting server cannot grind the short number. The server is
    a dumb relay: it stores and forwards these opaque base64url values (32-byte
    keys / nonces / SHA-256 commitment, 43 chars each) and can neither forge a
    matching number nor read anything. On a human number-match both devices sign a
    MUTUAL account endorsement (POST /api/trust/account-endorsements).

    The nonce/key fields nullable until each move lands; each is set-once so a
    relay cannot swap a value after seeing the opposing fresh nonce.
    """

    __tablename__ = "device_pairings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    initiator_device_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("browser_devices.id", ondelete="CASCADE"), nullable=False
    )
    joiner_device_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("browser_devices.id", ondelete="CASCADE"), nullable=False
    )
    # Move 1 (initiator, at start): its key K_I and commit Cd = SHA256(tag‖K_I‖N_I).
    initiator_public_key: Mapped[str] = mapped_column(String(43), nullable=False)
    initiator_commit: Mapped[str] = mapped_column(String(43), nullable=False)
    # Move 2 (joiner): its key K_J and fresh nonce N_J.
    joiner_public_key: Mapped[str | None] = mapped_column(String(43), nullable=True)
    joiner_nonce: Mapped[str | None] = mapped_column(String(43), nullable=True)
    # Move 3 (initiator opens): its nonce N_I, accepted only after the joiner
    # contributed and only if it opens the commitment.
    initiator_nonce: Mapped[str | None] = mapped_column(String(43), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "initiator_device_id <> joiner_device_id",
            name="ck_device_pairings_distinct",
        ),
    )


class Preset(Base):
    __tablename__ = "presets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    agent_kind: Mapped[str] = mapped_column(String(64), nullable=False)
    default_argv: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    env_template: Mapped[dict[str, str]] = mapped_column(JSON, nullable=False, default=dict)
    # Optional shell command run by the daemon when `default_argv[0]` is not
    # on PATH at agent.create time. Output streams into the agent's PTY.
    install: Mapped[str | None] = mapped_column(String(2048), nullable=True)

    __table_args__ = (UniqueConstraint("owner_user_id", "name", name="uq_presets_owner_name"),)


class HostToolPolicy(Base):
    __tablename__ = "host_tool_policies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    host_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    preset_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("presets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    auto_update: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_auto_update_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_auto_update_error: Mapped[str | None] = mapped_column(String(2048), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "owner_user_id",
            "host_id",
            "preset_id",
            name="uq_host_tool_policies_owner_host_preset",
        ),
    )


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    host_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    preset_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("presets.id", ondelete="SET NULL"), nullable=True
    )
    cwd: Mapped[str] = mapped_column(String(1024), nullable=False)
    argv: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    env: Mapped[dict[str, str]] = mapped_column(JSON, nullable=False, default=dict)
    name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="starting", nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    exited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_output_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_input_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exit_code: Mapped[int | None] = mapped_column(nullable=True)
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    owner: Mapped[User] = relationship(back_populates="agents")
    host: Mapped[Host] = relationship(back_populates="agents")


class Skill(Base):
    __tablename__ = "skills"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(String(512), nullable=False, default="")
    content: Mapped[str] = mapped_column(String(65535), nullable=False)
    enabled_by_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    owner: Mapped[User] = relationship(back_populates="skills")

    __table_args__ = (UniqueConstraint("owner_user_id", "name", name="uq_skills_owner_name"),)


class AgentSkillGrant(Base):
    __tablename__ = "agent_skill_grants"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agent_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    skill_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("skills.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    __table_args__ = (UniqueConstraint("agent_id", "skill_id", name="uq_agent_skill_grants"),)


class DeviceCode(Base):
    __tablename__ = "device_codes"

    device_code: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_code: Mapped[str] = mapped_column(String(16), unique=True, nullable=False, index=True)
    # High-entropy handle for URL-based browser lookup (`/device?ref=…`), so the
    # short human user_code never rides in a link. Nullable only for rows from an
    # interrupted pre-0029 ceremony; device/start always sets it.
    approval_ref: Mapped[str | None] = mapped_column(
        String(43), unique=True, nullable=True, index=True
    )
    # Committed-ephemeral SAS relay fields (docs/TRUST_DEVICE_MESH.md App. A). The
    # server only stores and forwards these; it cannot forge a matching number.
    # sas_commit (Cd) is set by the daemon at start; sas_browser_nonce (Nb) +
    # sas_browser_key (B) by the browser; sas_host_nonce (Nd) by the daemon after
    # it sees Nb. Absent ⇒ a peer that doesn't speak SAS ⇒ fingerprint fallback.
    sas_commit: Mapped[str | None] = mapped_column(String(43), nullable=True)
    sas_browser_nonce: Mapped[str | None] = mapped_column(String(43), nullable=True)
    sas_browser_key: Mapped[str | None] = mapped_column(String(43), nullable=True)
    sas_host_nonce: Mapped[str | None] = mapped_column(String(43), nullable=True)
    host_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    os: Mapped[str | None] = mapped_column(String(64), nullable=True)
    arch: Mapped[str | None] = mapped_column(String(64), nullable=True)
    version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Nullable only for device codes left behind by an interrupted pre-0017
    # deployment. New endpoints fail closed if either value is absent.
    host_key_algorithm: Mapped[str | None] = mapped_column(String(16), nullable=True)
    host_public_key: Mapped[str | None] = mapped_column(String(43), nullable=True)
    approval_nonce: Mapped[str | None] = mapped_column(String(43), nullable=True)
    # Nullable is the explicit fail-closed state for pre-0021 and newly-started
    # ceremonies. Only a verified v1 host-key signature sets this one-way pair.
    host_possession_version: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    host_possession_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    browser_device_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("browser_devices.id", ondelete="CASCADE"), nullable=True
    )
    browser_key_algorithm: Mapped[str | None] = mapped_column(String(16), nullable=True)
    browser_public_key: Mapped[str | None] = mapped_column(String(43), nullable=True)
    browser_key_fingerprint: Mapped[str | None] = mapped_column(String(23), nullable=True)
    # The browser's SPAWN-HOST-PAIR-APPROVE-V1 signature, retained so the poll
    # response can hand it to the daemon. Nullable for ceremonies approved by a
    # pre-0022 server; whether a daemon insists on it is the daemon's policy.
    browser_approval_signature: Mapped[str | None] = mapped_column(String(86), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "(host_key_algorithm IS NULL AND host_public_key IS NULL) OR "
            "(host_key_algorithm IS NOT NULL AND host_public_key IS NOT NULL AND "
            "host_key_algorithm = 'ed25519' AND length(host_public_key) = 43)",
            name="ck_device_codes_host_key_pair",
        ),
        CheckConstraint(
            "approval_nonce IS NULL OR length(approval_nonce) = 43",
            name="ck_device_codes_approval_nonce",
        ),
        CheckConstraint(
            "(host_possession_version IS NULL AND host_possession_verified_at IS NULL) OR "
            "(host_possession_version IS NOT NULL AND host_possession_version = 1 AND "
            "host_possession_verified_at IS NOT NULL)",
            name="ck_device_codes_host_possession",
        ),
        CheckConstraint(
            "(browser_device_id IS NULL AND browser_key_algorithm IS NULL AND "
            "browser_public_key IS NULL AND browser_key_fingerprint IS NULL) OR "
            "(browser_device_id IS NOT NULL AND browser_key_algorithm IS NOT NULL AND "
            "browser_public_key IS NOT NULL AND browser_key_fingerprint IS NOT NULL AND "
            "browser_key_algorithm = 'ed25519' AND length(browser_public_key) = 43 AND "
            "length(browser_key_fingerprint) = 23)",
            name="ck_device_codes_browser_binding",
        ),
        CheckConstraint(
            "browser_approval_signature IS NULL OR "
            "(length(browser_approval_signature) = 86 AND browser_device_id IS NOT NULL)",
            name="ck_device_codes_browser_approval_signature",
        ),
        Index(
            "ix_device_codes_host_key",
            "host_key_algorithm",
            "host_public_key",
        ),
    )


class Screen(Base):
    __tablename__ = "screens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # {"root": <split tree>|null} — a split tree is {"type": "pane",
    # "agent_id": ...} or {"type": "split", "direction": "row"|"column",
    # "ratio": ..., "a": <node>, "b": <node>}. Kept as loose JSON so layout
    # evolution doesn't need migrations.
    layout: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # Ad-hoc screens (drag one agent onto another) start ephemeral: they are
    # auto-deleted when emptied and promoted to permanent on rename or a
    # third pane. Deliberate "New screen" screens are never ephemeral.
    ephemeral: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class EmailToken(Base):
    """A single-use secret mailed to a user's address.

    Only the SHA-256 of the emailed value is stored. The token IS the
    credential — anyone holding it can reset a password — so the database
    must not contain anything replayable if it leaks.
    """

    __tablename__ = "email_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )


class Invite(Base):
    """A single-use signup code for a closed deployment.

    Only the hash is stored: the code travels in a shareable URL, so a leaked
    database must not let anyone mint accounts. That also means the plaintext
    exists exactly once, at creation, and cannot be shown again afterwards.
    """

    __tablename__ = "invites"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # Advisory only -- the code admits whoever holds it. Records who it was
    # meant for, and addresses the invitation email when present.
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    used_by_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )


class EmailLog(Base):
    """One outbound email attempt, kept so an operator can see what was sent.

    The body is stored with credentials redacted: password-reset and invite
    links admit whoever holds them, and an audit trail that stores live
    credentials is a liability rather than a record.
    """

    __tablename__ = "email_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    to_email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_redacted: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
