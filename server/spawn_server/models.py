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
    sessions: Mapped[list[Session]] = relationship(back_populates="owner")
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

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
    sessions: Mapped[list[Session]] = relationship(back_populates="host")
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


class Agent(Base):
    """A launchable CLI tool definition — a shortcut, not a process."""

    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    # NULL owner marks a built-in: visible to everyone, immutable via the API.
    owner_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    # The full shell command the shortcut bar types into a session's PTY.
    command: Mapped[str] = mapped_column(String(1024), nullable=False)
    env: Mapped[dict[str, str]] = mapped_column(JSON, nullable=False, default=dict)
    # Optional shell command offered when the command's binary is missing on a
    # host ("install & run"); typed visibly into the PTY, never run silently.
    install: Mapped[str | None] = mapped_column(String(2048), nullable=True)

    __table_args__ = (UniqueConstraint("owner_user_id", "name", name="uq_agents_owner_name"),)


class HostAgentPolicy(Base):
    __tablename__ = "host_agent_policies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    host_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agent_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False, index=True
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
            "agent_id",
            name="uq_host_agent_policies_owner_host_agent",
        ),
    )


class Session(Base):
    """A PTY on a host. Always starts as the user's login shell in `cwd`."""

    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    host_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    cwd: Mapped[str] = mapped_column(String(1024), nullable=False)
    name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="starting", nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    exited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_output_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_input_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exit_code: Mapped[int | None] = mapped_column(nullable=True)
    # Basename of the foreground process (daemon-reported, <= 64 chars). The
    # documented content-free exception: a process name, nothing else, so the
    # UI can label panes. See docs/TRUST.md.
    foreground_command: Mapped[str | None] = mapped_column(String(255), nullable=True)

    owner: Mapped[User] = relationship(back_populates="sessions")
    host: Mapped[Host] = relationship(back_populates="sessions")


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


class SessionSkillGrant(Base):
    __tablename__ = "session_skill_grants"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    skill_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("skills.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    __table_args__ = (UniqueConstraint("session_id", "skill_id", name="uq_session_skill_grants"),)


class DeviceCode(Base):
    __tablename__ = "device_codes"

    device_code: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_code: Mapped[str] = mapped_column(String(16), unique=True, nullable=False, index=True)
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


class Workspace(Base):
    """A named 12x12 grid of session tiles."""

    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # The workspace's home: the host and folder it was created in. New
    # sessions default here so the folder is chosen once, at creation.
    # Nullable: pre-0034 workspaces, or a deleted host (SET NULL).
    host_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("hosts.id", ondelete="SET NULL"), nullable=True
    )
    cwd: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # Layout schema v3 (tabs over grid-schema-v3 grids), validated on every write by
    # spawn_server.grid + routes/workspaces (docs/OVERHAUL.md §4.4).
    layout: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # Sidebar ordering, contiguous from 0 per owner. Archived rows leave that
    # space entirely — they order by `archived_at` and their `position` is
    # stale until a restore appends them back at the end.
    position: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0", nullable=False
    )
    # The workspace's mark: a small square thumbnail as a self-contained
    # `data:image/(png|webp);base64,...` URL, checked on every write by
    # `schemas.validate_workspace_icon`. Null -> the sidebar draws the name's
    # initials, as it always has.
    icon: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Whether the icon question is settled, which `icon` alone cannot say: a
    # null icon is both "nobody has looked" and "looked, found nothing". NULL
    # -> the browser scans this workspace's folder next time it opens; "auto"
    # (that scan found one), "custom" (the owner chose it, or deliberately
    # cleared it) and "none" (scanned, nothing worth using) all mean: leave it.
    icon_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Set -> the workspace is put away: out of the sidebar's list, and every
    # session in it stopped. Nothing else moves — `layout` still names the same
    # windows and `position` still holds the slot the row will come back to. A
    # timestamp rather than a flag so the UI can say "archived 3 days ago".
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class WorkspaceTemplate(Base):
    """A saved workspace shape: tabs, tile geometry, and what runs in each
    tile (shell / agent command / files widget). No folder or host — those
    are chosen when a workspace is created from it."""

    __tablename__ = "workspace_templates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # The folder the template was saved from: creating from the template goes
    # straight there, no folder prompt. Nullable — the host may be gone.
    host_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("hosts.id", ondelete="SET NULL"), nullable=True
    )
    cwd: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # {"version": 1, "tabs": [{"name", "tiles": [{x, y, w, h, "run"}]}]},
    # validated by routes/workspace_templates on every write.
    spec: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # The mark the saved workspace was wearing, in the same form and under the
    # same validation as `Workspace.icon`; a workspace created from this
    # template inherits it instead of scanning its folder.
    icon: Mapped[str | None] = mapped_column(Text, nullable=True)
    icon_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class RecentDir(Base):
    """A directory a session was recently started in, per owner and host."""

    __tablename__ = "recent_dirs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    host_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    path: Mapped[str] = mapped_column(String(1024), nullable=False)
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "owner_user_id", "host_id", "path", name="uq_recent_dirs_owner_host_path"
        ),
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
