"""Pydantic v2 schemas. Shapes intentionally match `proto/README.md`."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

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


class AuthProviderOut(BaseModel):
    id: Literal["google", "microsoft", "github"]
    name: str


class AuthProviderList(BaseModel):
    providers: list[AuthProviderOut] = Field(default_factory=list)


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
    cols: int = 120
    rows: int = 32
    create_cwd: bool = True


class AgentRestart(BaseModel):
    cols: int = 120
    rows: int = 32
    create_cwd: bool = True


class AgentInput(BaseModel):
    text: str | None = None
    bytes_b64: str | None = None


class AgentInputResult(BaseModel):
    agent_id: str
    bytes: int


class AgentResize(BaseModel):
    cols: int = Field(default=120, ge=20, le=400)
    rows: int = Field(default=32, ge=5, le=200)


class AgentResizeResult(BaseModel):
    agent_id: str
    cols: int
    rows: int


class AgentScroll(BaseModel):
    lines: int = Field(ge=-200, le=200)


class AgentScrollResult(BaseModel):
    agent_id: str
    lines: int


class AgentRedrawResult(BaseModel):
    agent_id: str
    redraw: bool


class AgentSnapshotRequest(BaseModel):
    lines: int = Field(default=5000, ge=100, le=10000)
    plain: bool = False


class AgentSnapshotOut(BaseModel):
    agent_id: str
    bytes_b64: str
    plain: bool
    lines: int


class AgentUploadRequest(BaseModel):
    name: str | None = Field(default=None, max_length=255)
    mime_type: str | None = Field(default=None, max_length=128)
    bytes_b64: str
    paste: bool = True
    destination: Literal["cwd"] | None = None
    client_id: str | None = Field(default=None, max_length=128)


class AgentUploadOut(BaseModel):
    agent_id: str
    path: str
    client_id: str
    pasted: bool


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    archived: bool | None = None
    pinned: bool | None = None


class AgentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str | None = None
    tmux_session: str | None = None
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


class ScreenTab(BaseModel):
    name: str | None = Field(default=None, max_length=64)
    root: LayoutNode | None = None


class ScreenLayout(BaseModel):
    tabs: list[ScreenTab] = Field(default_factory=list, max_length=8)


class ScreenCreate(BaseModel):
    name: str = Field(max_length=128)
    layout: ScreenLayout = Field(default_factory=ScreenLayout)


class ScreenPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    layout: ScreenLayout | None = None


class ScreenOut(BaseModel):
    id: str
    name: str
    layout: ScreenLayout
    created_at: datetime
    updated_at: datetime
