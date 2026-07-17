"""Pydantic v2 schemas. Shapes intentionally match `proto/README.md`."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from .host_identity import decode_host_public_key, host_key_fingerprint

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


class AuthProviderOut(BaseModel):
    id: Literal["google", "microsoft", "github"]
    name: str


class AuthProviderList(BaseModel):
    providers: list[AuthProviderOut] = Field(default_factory=list)


# ---------- device code ----------


class DeviceStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    host_name: str = Field(max_length=128)
    os: str | None = None
    arch: str | None = None
    version: str | None = None
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str = Field(min_length=43, max_length=43)

    @field_validator("host_public_key")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value


class DeviceStartResponse(BaseModel):
    device_code: str
    user_code: str
    verification_uri: str
    interval: int
    expires_in: int


class DevicePollRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_code: str
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str = Field(min_length=43, max_length=43)

    @field_validator("host_public_key")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value


class DevicePollSuccess(BaseModel):
    access_token: str
    host_id: str
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str
    host_key_fingerprint: str


class DevicePollPending(BaseModel):
    error: Literal["authorization_pending", "slow_down", "expired_token", "denied"]


class DevicePendingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_code: str


class DeviceApproveRequest(DevicePendingRequest):
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str = Field(min_length=43, max_length=43)
    host_key_fingerprint: str = Field(min_length=23, max_length=23)

    @field_validator("host_public_key")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value

    @model_validator(mode="after")
    def validate_fingerprint_binding(self) -> DeviceApproveRequest:
        expected = host_key_fingerprint(self.host_key_algorithm, self.host_public_key)
        if self.host_key_fingerprint != expected:
            raise ValueError("host key fingerprint does not match public key")
        return self


class DeviceApproveResponse(BaseModel):
    host_name: str
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str
    host_key_fingerprint: str


class DevicePendingResponse(DeviceApproveResponse):
    pass


# ---------- hosts ----------


class HostOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    os: str | None = None
    arch: str | None = None
    version: str | None = None
    host_key_algorithm: Literal["ed25519"] | None = None
    host_public_key: str | None = None
    host_key_fingerprint: str | None = None
    status: str
    last_seen_at: datetime | None = None
    agent_count: int = 0


class HostPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=128)


class HostToolTarget(BaseModel):
    preset_id: str
    preset_name: str
    agent_kind: str
    command: str
    install: str | None = None


class HostToolStatus(HostToolTarget):
    installed: bool = False
    path: str | None = None
    version: str | None = None
    latest_version: str | None = None
    update_available: bool | None = None
    error: str | None = None
    auto_update: bool = False
    last_checked_at: datetime | None = None
    last_auto_update_at: datetime | None = None
    last_auto_update_error: str | None = None


class HostToolList(BaseModel):
    tools: list[HostToolStatus] = Field(default_factory=list)


class HostToolInstallResult(BaseModel):
    preset_id: str
    preset_name: str
    agent_kind: str
    command: str
    install: str | None = None
    success: bool
    exit_code: int | None = None
    output: str = ""
    error: str | None = None
    status: HostToolStatus | None = None


class HostToolPolicyPatch(BaseModel):
    auto_update: bool | None = None


class HostToolPolicyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    preset_id: str
    auto_update: bool = False
    last_checked_at: datetime | None = None
    last_auto_update_at: datetime | None = None
    last_auto_update_error: str | None = None


# ---------- presets ----------


class PresetCreate(BaseModel):
    name: str = Field(max_length=128)
    agent_kind: str = Field(max_length=64)
    default_argv: list[str] = Field(default_factory=list)
    env_template: dict[str, str] = Field(default_factory=dict)
    install: str | None = Field(default=None, max_length=2048)


class PresetPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    agent_kind: str | None = Field(default=None, max_length=64)
    default_argv: list[str] | None = None
    env_template: dict[str, str] | None = None
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


# ---------- managed skills ----------


class SkillCreate(BaseModel):
    name: str = Field(max_length=128)
    description: str = Field(default="", max_length=512)
    content: str = Field(max_length=65535)
    enabled_by_default: bool = False


class SkillPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    description: str | None = Field(default=None, max_length=512)
    content: str | None = Field(default=None, max_length=65535)
    enabled_by_default: bool | None = None


class SkillOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    owner_user_id: str
    name: str
    description: str
    content: str
    enabled_by_default: bool
    created_at: datetime


class AgentAccessPatch(BaseModel):
    skill_ids: list[str] | None = None


class AgentAccessOut(BaseModel):
    agent_id: str
    skills: list[SkillOut] = Field(default_factory=list)


class AgentSkillConfig(BaseModel):
    id: str
    name: str
    description: str
    content: str


# ---------- agents ----------


class AgentCreate(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    host_id: str
    preset_id: str | None = None
    cwd: str
    argv: list[str] | None = None
    env: dict[str, str] | None = None
    skill_ids: list[str] | None = None
    create_cwd: bool = True


class AgentRestart(BaseModel):
    create_cwd: bool = True


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    archived: bool | None = None
    pinned: bool | None = None


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
    pinned_at: datetime | None = None
    archived_at: datetime | None = None


# ---------- screens ----------


class LayoutPane(BaseModel):
    type: Literal["pane"]
    agent_id: str


class LayoutSplit(BaseModel):
    type: Literal["split"]
    direction: Literal["row", "column"]
    ratio: float = Field(default=0.5, ge=0.05, le=0.95)
    a: LayoutNode
    b: LayoutNode


LayoutNode = Annotated[LayoutPane | LayoutSplit, Field(discriminator="type")]


class ScreenLayout(BaseModel):
    root: LayoutNode | None = None


class ScreenCreate(BaseModel):
    name: str = Field(max_length=128)
    layout: ScreenLayout = Field(default_factory=ScreenLayout)
    ephemeral: bool = False


class ScreenPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    layout: ScreenLayout | None = None
    ephemeral: bool | None = None
    pinned: bool | None = None


class ScreenOut(BaseModel):
    id: str
    name: str
    layout: ScreenLayout
    ephemeral: bool = False
    pinned_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
