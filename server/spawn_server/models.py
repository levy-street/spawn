"""SQLAlchemy 2.0 ORM models."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


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

    hosts: Mapped[list[Host]] = relationship(back_populates="owner")
    agents: Mapped[list[Agent]] = relationship(back_populates="owner")
    skills: Mapped[list[Skill]] = relationship(back_populates="owner")
    auth_identities: Mapped[list[AuthIdentity]] = relationship(back_populates="user")
    auth_provider_states: Mapped[list[AuthProviderState]] = relationship(back_populates="user")


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
    status: Mapped[str] = mapped_column(String(16), default="offline", nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    owner: Mapped[User] = relationship(back_populates="hosts")
    agents: Mapped[list[Agent]] = relationship(back_populates="host")


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
    last_checked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
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
    host_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    os: Mapped[str | None] = mapped_column(String(64), nullable=True)
    arch: Mapped[str | None] = mapped_column(String(64), nullable=True)
    version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )
