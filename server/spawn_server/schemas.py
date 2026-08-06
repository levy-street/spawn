"""Pydantic v2 schemas. Shapes intentionally match `proto/README.md`."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from .browser_registration import ED25519_SIGNATURE_B64URL_LENGTH
from .host_identity import (
    decode_ed25519_public_key,
    decode_host_public_key,
    ed25519_key_fingerprint,
    host_key_fingerprint,
)
from .host_pair_approval import APPROVAL_NONCE_B64URL_LENGTH, decode_approval_nonce
from .host_pair_possession import DEVICE_CODE_B64URL_LENGTH, decode_device_code

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
    email_verified_at: datetime | None = None


class TokenResponse(BaseModel):
    access_token: str
    user: UserOut


class MeResponse(BaseModel):
    user: UserOut


# ---------- browser devices ----------


class BrowserDeviceRegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Recognition only. Never used in a trust decision -- see BrowserDevice.
    label: str | None = Field(default=None, max_length=64)
    key_algorithm: Literal["ed25519"]
    public_key: str = Field(min_length=43, max_length=43)
    signature: str = Field(
        min_length=ED25519_SIGNATURE_B64URL_LENGTH,
        max_length=ED25519_SIGNATURE_B64URL_LENGTH,
    )

    @field_validator("public_key")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        decode_ed25519_public_key(value)
        return value


class BrowserDeviceRevokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_public_key: str = Field(min_length=43, max_length=43)

    @field_validator("expected_public_key")
    @classmethod
    def validate_expected_public_key(cls, value: str) -> str:
        decode_ed25519_public_key(value)
        return value


class BrowserDeviceOut(BaseModel):
    id: str
    key_algorithm: Literal["ed25519"]
    public_key: str
    fingerprint: str
    label: str | None = None
    created_at: datetime
    revoked_at: datetime | None = None


class BrowserDeviceRenameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, max_length=64)


class BrowserDevicePruneResponse(BaseModel):
    pruned: int


class PasswordResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr


class PasswordResetConfirm(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=16, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)


class EmailVerifyConfirm(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=16, max_length=256)


class AccountDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm_email: str
    password: str | None = None


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
    approval_nonce: str
    verification_uri: str
    interval: int
    expires_in: int


class DevicePossessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_code: str = Field(
        min_length=DEVICE_CODE_B64URL_LENGTH,
        max_length=DEVICE_CODE_B64URL_LENGTH,
    )
    approval_nonce: str = Field(
        min_length=APPROVAL_NONCE_B64URL_LENGTH,
        max_length=APPROVAL_NONCE_B64URL_LENGTH,
    )
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str = Field(min_length=43, max_length=43)
    signature: str = Field(
        min_length=ED25519_SIGNATURE_B64URL_LENGTH,
        max_length=ED25519_SIGNATURE_B64URL_LENGTH,
    )

    @field_validator("device_code")
    @classmethod
    def validate_device_code(cls, value: str) -> str:
        decode_device_code(value)
        return value

    @field_validator("approval_nonce")
    @classmethod
    def validate_approval_nonce(cls, value: str) -> str:
        decode_approval_nonce(value)
        return value

    @field_validator("host_public_key")
    @classmethod
    def validate_host_public_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value


class DevicePossessionResponse(BaseModel):
    verified: Literal[True]
    version: Literal[1]


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
    browser_device_id: str
    browser_key_algorithm: Literal["ed25519"]
    browser_public_key: str
    browser_key_fingerprint: str
    # Absent for ceremonies approved by a pre-0022 server, which is why the
    # daemon treats a missing proof as unverified rather than as a failure.
    account_id: str | None = None
    browser_approval_signature: str | None = None


class DevicePollPending(BaseModel):
    error: Literal[
        "authorization_pending",
        "slow_down",
        "expired_token",
        "denied",
        "invalid_device_binding",
        "key_conflict",
        "pin_conflict",
        "pin_limit",
    ]


class DevicePendingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_code: str


class DeviceApproveRequest(DevicePendingRequest):
    approval_nonce: str = Field(
        min_length=APPROVAL_NONCE_B64URL_LENGTH,
        max_length=APPROVAL_NONCE_B64URL_LENGTH,
    )
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str = Field(min_length=43, max_length=43)
    host_key_fingerprint: str = Field(min_length=23, max_length=23)
    browser_device_id: str = Field(min_length=36, max_length=36)
    browser_key_algorithm: Literal["ed25519"]
    browser_public_key: str = Field(min_length=43, max_length=43)
    browser_key_fingerprint: str = Field(min_length=23, max_length=23)
    signature: str = Field(
        min_length=ED25519_SIGNATURE_B64URL_LENGTH,
        max_length=ED25519_SIGNATURE_B64URL_LENGTH,
    )

    @field_validator("host_public_key")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value

    @field_validator("approval_nonce")
    @classmethod
    def validate_approval_nonce(cls, value: str) -> str:
        decode_approval_nonce(value)
        return value

    @field_validator("browser_device_id")
    @classmethod
    def validate_browser_device_id(cls, value: str) -> str:
        try:
            parsed = uuid.UUID(value)
        except ValueError as exc:
            raise ValueError("browser device id must be a UUID") from exc
        if value != str(parsed):
            raise ValueError("browser device id must be a canonical lowercase UUID")
        return value

    @field_validator("browser_public_key")
    @classmethod
    def validate_browser_public_key(cls, value: str) -> str:
        decode_ed25519_public_key(value)
        return value

    @model_validator(mode="after")
    def validate_fingerprint_binding(self) -> DeviceApproveRequest:
        expected = host_key_fingerprint(self.host_key_algorithm, self.host_public_key)
        if self.host_key_fingerprint != expected:
            raise ValueError("host key fingerprint does not match public key")
        browser_expected = ed25519_key_fingerprint(self.browser_public_key)
        if self.browser_key_fingerprint != browser_expected:
            raise ValueError("browser key fingerprint does not match public key")
        return self


class DeviceApproveResponse(BaseModel):
    host_name: str
    approval_nonce: str
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str
    host_key_fingerprint: str
    browser_device_id: str
    browser_key_algorithm: Literal["ed25519"]
    browser_public_key: str
    browser_key_fingerprint: str
    # Existing Host row for this key (re-pair only): lets the approving
    # browser bind its local pin to the host UUID immediately. Null on a
    # first pairing — the Host row is created later by the daemon's poll, and
    # the browser seeds the binding from /api/hosts instead.
    host_id: str | None = None


class DevicePendingResponse(BaseModel):
    host_name: str
    approval_nonce: str
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str
    host_key_fingerprint: str


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


class TrustBundleOut(BaseModel):
    """Opaque to the server by design; only the operator's device can read it."""

    sealed: str
    revision: int
    updated_at: datetime


class TrustBundlePut(BaseModel):
    sealed: str = Field(min_length=1)
    # None means "creating the first bundle". Replacing an existing one requires
    # the revision it was read at, so a stale device cannot silently drop host
    # keys another device added.
    expected_revision: int | None = Field(default=None, ge=0)


class PasskeyCredentialOut(BaseModel):
    id: str
    credential_id: str
    label: str | None
    created_at: datetime


class PasskeyCredentialCreate(BaseModel):
    credential_id: str = Field(min_length=1, max_length=512)
    label: str | None = Field(default=None, max_length=128)


class BrowserEndorsementCreate(BaseModel):
    """One trusted browser admitting another to a host."""

    model_config = ConfigDict(extra="forbid")

    host_id: str = Field(min_length=36, max_length=36)
    endorser_device_id: str = Field(min_length=36, max_length=36)
    endorsed_device_id: str = Field(min_length=36, max_length=36)
    signature: str = Field(
        min_length=ED25519_SIGNATURE_B64URL_LENGTH,
        max_length=ED25519_SIGNATURE_B64URL_LENGTH,
    )


class BrowserEndorsementOut(BaseModel):
    host_id: str
    endorsed_device_id: str
    endorsed_key_fingerprint: str
    endorser_device_id: str
    created_at: datetime


class BrowserEndorsementRecord(BaseModel):
    """One endorsement as presented to the ENDORSED device.

    Every field is server-claimed and untrusted on its own: the endorsed
    browser re-encodes the endorsement transcript from these claims plus its
    OWN key and device id, verifies the signature against the endorser key
    whose fingerprint the operator confirmed on the endorsing browser's
    screen, and only then treats `host_public_key` as introduced.
    """

    host_id: str
    host_name: str
    host_public_key: str
    endorser_device_id: str
    endorser_public_key: str
    endorser_label: str | None = None
    signature: str
