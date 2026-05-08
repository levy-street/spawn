"""Pydantic v2 schemas. Shapes intentionally match `proto/README.md`."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

# ---------- auth ----------


class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: EmailStr
    created_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    user: UserOut


class MeResponse(BaseModel):
    user: UserOut


# ---------- device code ----------


class DeviceStartRequest(BaseModel):
    host_name: str = Field(max_length=128)
    os: str | None = None
    arch: str | None = None
    version: str | None = None


class DeviceStartResponse(BaseModel):
    device_code: str
    user_code: str
    verification_uri: str
    interval: int
    expires_in: int


class DevicePollRequest(BaseModel):
    device_code: str


class DevicePollSuccess(BaseModel):
    access_token: str
    host_id: str


class DevicePollPending(BaseModel):
    error: Literal["authorization_pending", "slow_down", "expired_token", "denied"]


class DeviceApproveRequest(BaseModel):
    user_code: str


class DeviceApproveResponse(BaseModel):
    host_name: str


# ---------- hosts ----------


class HostOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    os: str | None = None
    arch: str | None = None
    version: str | None = None
    status: str
    last_seen_at: datetime | None = None
    agent_count: int = 0
    home_dir: str | None = None


class HostPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)


class HostDirEntry(BaseModel):
    name: str
    path: str


class HostDirList(BaseModel):
    path: str
    home_dir: str | None = None
    parent: str | None = None
    entries: list[HostDirEntry] = Field(default_factory=list)
    error: str | None = None


# ---------- presets ----------


class PresetCreate(BaseModel):
    name: str = Field(max_length=128)
    agent_kind: str = Field(max_length=64)
    default_argv: list[str] = Field(default_factory=list)
    env_template: dict[str, str] = Field(default_factory=dict)
    install: str | None = Field(default=None, max_length=2048)


class PresetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    owner_user_id: str | None
    name: str
    agent_kind: str
    default_argv: list[str]
    env_template: dict[str, str]
    install: str | None = None


# ---------- agents ----------


class AgentCreate(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    host_id: str
    preset_id: str | None = None
    cwd: str
    argv: list[str] | None = None
    env: dict[str, str] | None = None
    cols: int = 120
    rows: int = 32
    create_cwd: bool = True


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    archived: bool | None = None


class AgentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str | None = None
    host_id: str
    host_name: str | None = None
    preset_id: str | None = None
    cwd: str
    argv: list[str]
    env: dict[str, str]
    status: str
    started_at: datetime
    exited_at: datetime | None = None
    last_output_at: datetime | None = None
    last_input_at: datetime | None = None
    last_activity_at: datetime | None = None
    activity_state: str = "unknown"
    activity_label: str = "Unknown"
    exit_code: int | None = None
    archived_at: datetime | None = None
