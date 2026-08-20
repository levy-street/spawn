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
    # Required on a closed deployment unless this is the very first account.
    invite: str | None = Field(default=None, max_length=256)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: EmailStr
    created_at: datetime
    email_verified_at: datetime | None = None
    is_admin: bool = False


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
    # Register this key as the account ROOT (pk_R), not a browser (device mesh
    # §3). Not bound in the registration proof: is_root grants no trust on its
    # own (a root anchors only via possess/re-anchor, never automatically), so a
    # server flipping it is at most a denial of service, which it can do anyway.
    is_root: bool = False

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
    # True for the account root (pk_R): clients filter it out of connect/ceremony
    # lists since it never connects — it only endorses and anchors.
    is_root: bool = False


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


class AdminUserOut(BaseModel):
    id: str
    email: EmailStr
    created_at: datetime
    email_verified_at: datetime | None = None
    is_admin: bool = False
    host_count: int = 0
    agent_count: int = 0
    browser_device_count: int = 0


class AdminInviteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr | None = None
    ttl_hours: int | None = Field(default=None, ge=1, le=24 * 30)


class AdminInviteOut(BaseModel):
    id: str
    email: str | None = None
    state: Literal["pending", "used", "expired", "revoked"]
    expires_at: datetime
    created_at: datetime
    used_at: datetime | None = None
    created_by_user_id: str | None = None
    used_by_user_id: str | None = None
    # Only ever populated in the response that created the invite.
    url: str | None = None


class AdminMailStatus(BaseModel):
    backend: str
    # False when the backend only logs (console) or is switched off.
    delivering: bool
    from_address: str
    smtp_host: str | None = None


class AdminEmailOut(BaseModel):
    id: str
    to_email: str
    subject: str
    kind: str
    status: Literal["sent", "failed", "not_delivered"]
    error: str | None = None
    # Credentials are stripped before storage; see mail.redact_credentials.
    body_redacted: str = ""
    created_at: datetime


class AdminTestEmail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    to: EmailStr | None = None


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
    # Committed-ephemeral SAS: the daemon's commitment Cd = H(domain ‖ H ‖ Nd),
    # opaque to the server. Absent from a pre-SAS daemon.
    sas_commit: str | None = Field(default=None, min_length=43, max_length=43)

    @field_validator("host_public_key")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value


class DeviceStartResponse(BaseModel):
    device_code: str
    user_code: str
    # Opaque handle the daemon bakes into the browser URL (`/device?ref=…`).
    approval_ref: str
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

    # Identify the pending ceremony by either the short human code OR the opaque
    # URL handle. Exactly one is required; the browser normally sends the ref it
    # read from the URL, the manual-entry form sends the user_code.
    user_code: str | None = None
    approval_ref: str | None = None

    @model_validator(mode="after")
    def exactly_one_identifier(self) -> DevicePendingRequest:
        if bool(self.user_code) == bool(self.approval_ref):
            raise ValueError("provide exactly one of user_code or approval_ref")
        return self


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
    # SAS relay: the daemon's commitment (present ⇒ the browser runs the SAS and
    # contributes Nb via POST /sas), and the daemon's opened nonce Nd once it has
    # revealed it (present ⇒ the browser can verify the commit and show the SAS).
    sas_commit: str | None = None
    sas_host_nonce: str | None = None


class DeviceSasRequest(DevicePendingRequest):
    """Browser's SAS contribution: its fresh nonce Nb and its public key B, so
    the daemon can compute the number before the human approves. Identified like
    pending, by exactly one of user_code / approval_ref."""

    sas_browser_nonce: str = Field(min_length=43, max_length=43)
    browser_public_key: str = Field(min_length=43, max_length=43)

    @field_validator("browser_public_key")
    @classmethod
    def validate_browser_public_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value


class DeviceSasResponse(BaseModel):
    # Echoed back so the browser can confirm its contribution landed; the daemon
    # nonce Nd arrives later via DevicePendingResponse.sas_host_nonce.
    ok: bool = True


class DeviceSasHostRequest(BaseModel):
    """Daemon's side of the SAS handshake, authenticated by the device_code
    (like poll — no user session). The daemon calls this to fetch the browser's
    Nb/B and, once it has them, to reveal its own Nd. Kept off the poll's
    approval CAS so the pairing race logic is untouched."""

    model_config = ConfigDict(extra="forbid")

    device_code: str
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str = Field(min_length=43, max_length=43)
    # The daemon's opened nonce Nd — sent only after it has seen Nb here
    # (commit-reveal ordering). Omitted until then.
    sas_host_nonce: str | None = Field(default=None, min_length=43, max_length=43)


class DeviceSasHostResponse(BaseModel):
    sas_browser_nonce: str | None = None
    sas_browser_key: str | None = None
    sas_host_nonce: str | None = None


# ---------- browser-to-browser add-device pairing (device mesh §4) ----------


class DevicePairingStart(BaseModel):
    """Initiator opens a committed-ephemeral SAS ceremony to admit a new device.

    It sends its own key K_I and the commitment Cd = SHA256(tag ‖ K_I ‖ N_I),
    hiding its fresh nonce N_I until the joiner has contributed.
    """

    model_config = ConfigDict(extra="forbid")

    initiator_device_id: str = Field(min_length=36, max_length=36)
    joiner_device_id: str = Field(min_length=36, max_length=36)
    initiator_public_key: str = Field(min_length=43, max_length=43)
    initiator_commit: str = Field(min_length=43, max_length=43)

    @field_validator("initiator_public_key")
    @classmethod
    def _validate_initiator_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value


class DevicePairingContribute(BaseModel):
    """Joiner's move: its own key K_J and a fresh nonce N_J (sent before it can
    learn the initiator's opened nonce, so it cannot adapt N_J to the number)."""

    model_config = ConfigDict(extra="forbid")

    joiner_public_key: str = Field(min_length=43, max_length=43)
    joiner_nonce: str = Field(min_length=43, max_length=43)

    @field_validator("joiner_public_key")
    @classmethod
    def _validate_joiner_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value


class DevicePairingReveal(BaseModel):
    """Initiator opens its commitment by revealing N_I (only accepted after the
    joiner has contributed, and only if it opens Cd)."""

    model_config = ConfigDict(extra="forbid")

    initiator_nonce: str = Field(min_length=43, max_length=43)


class DevicePairingOut(BaseModel):
    id: str
    expires_at: datetime


class DevicePairingState(BaseModel):
    """The relayed ceremony state, polled by both devices. Every value is
    server-relayed and untrusted on its own — the SAS number each side derives
    from it, compared by the human across both screens, is the check."""

    id: str
    initiator_device_id: str
    joiner_device_id: str
    initiator_public_key: str
    initiator_commit: str
    joiner_public_key: str | None = None
    joiner_nonce: str | None = None
    initiator_nonce: str | None = None
    created_at: datetime
    expires_at: datetime


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
    # Mesh R9: true once this host's daemon validates account-scoped chains;
    # the legacy per-host device-endorsement path is refused for such hosts.
    supports_account_chains: bool = False


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


class AccountEndorsementCreate(BaseModel):
    """One device account-endorsing another (no host — docs §3).

    The signature is over the SPAWN-ACCT-ENDORSE-V1 transcript
    (account_id, endorser_pk, endorsed_pk, endorsed_device_id).
    """

    model_config = ConfigDict(extra="forbid")

    endorser_device_id: str = Field(min_length=36, max_length=36)
    endorsed_device_id: str = Field(min_length=36, max_length=36)
    signature: str = Field(
        min_length=ED25519_SIGNATURE_B64URL_LENGTH,
        max_length=ED25519_SIGNATURE_B64URL_LENGTH,
    )


class AccountEndorsementOut(BaseModel):
    id: str
    endorser_device_id: str
    endorsed_device_id: str
    created_at: datetime


class AccountEndorsementRecord(BaseModel):
    """One account-scoped endorsement edge, as served to a device assembling its
    carried chain.

    Untrusted on its own, exactly like BrowserEndorsementRecord: the consumer
    re-encodes the SPAWN-ACCT-ENDORSE-V1 transcript from these claims and
    verifies the signature against the endorser key. The account has no host in
    the transcript, so the same edge is valid toward every host.
    """

    endorser_device_id: str
    endorser_public_key: str
    endorsed_device_id: str
    endorsed_public_key: str
    signature: str
    created_at: datetime
