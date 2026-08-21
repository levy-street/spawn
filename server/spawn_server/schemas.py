"""Pydantic v2 schemas. Shapes intentionally match `proto/README.md`."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    field_validator,
    model_serializer,
    model_validator,
)

from . import grid
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


class AdminUserOut(BaseModel):
    id: str
    email: EmailStr
    created_at: datetime
    email_verified_at: datetime | None = None
    is_admin: bool = False
    host_count: int = 0
    session_count: int = 0
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


class AuthConfigOut(BaseModel):
    """Everything the login/signup/onboarding surfaces need in one request.

    `email_verification_required` mirrors the exact condition `auth.verified_user`
    enforces, so onboarding never shows a gate the server won't enforce.
    """

    providers: list[AuthProviderOut] = Field(default_factory=list)
    email_verification_required: bool = False
    invite_only: bool = False


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
    session_count: int = 0


class HostPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=128)


class HostAgentTarget(BaseModel):
    agent_id: str
    agent_name: str
    # Deliberate asymmetry: the agents table (and AgentOut) call this `kind`,
    # but the host-availability wire keeps `agent_kind`, which the daemon and
    # web both encode by that name.
    agent_kind: str
    # The binary to `which` on the host: the first word of the agent's
    # command string, computed server-side.
    command: str
    install: str | None = None


class HostAgentStatus(HostAgentTarget):
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


class HostAgentList(BaseModel):
    agents: list[HostAgentStatus] = Field(default_factory=list)


class HostAgentInstallResult(BaseModel):
    agent_id: str
    agent_name: str
    agent_kind: str
    command: str
    install: str | None = None
    success: bool
    exit_code: int | None = None
    output: str = ""
    error: str | None = None
    status: HostAgentStatus | None = None


class HostAgentPolicyPatch(BaseModel):
    auto_update: bool | None = None


class HostAgentPolicyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    agent_id: str
    auto_update: bool = False
    last_checked_at: datetime | None = None
    last_auto_update_at: datetime | None = None
    last_auto_update_error: str | None = None


class RecentDirOut(BaseModel):
    path: str
    last_used_at: datetime


class RecentDirList(BaseModel):
    dirs: list[RecentDirOut] = Field(default_factory=list)


# ---------- agents (definitions) ----------


class AgentCreate(BaseModel):
    name: str = Field(max_length=128)
    kind: str = Field(max_length=64)
    command: str = Field(max_length=1024)
    env: dict[str, str] = Field(default_factory=dict)
    install: str | None = Field(default=None, max_length=2048)


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    kind: str | None = Field(default=None, max_length=64)
    command: str | None = Field(default=None, max_length=1024)
    env: dict[str, str] | None = None
    install: str | None = Field(default=None, max_length=2048)


class AgentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    # None marks a built-in (immutable via the API).
    owner_user_id: str | None
    name: str
    kind: str
    command: str
    env: dict[str, str]
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


class SessionAccessPatch(BaseModel):
    skill_ids: list[str] | None = None


class SessionAccessOut(BaseModel):
    session_id: str
    skills: list[SkillOut] = Field(default_factory=list)


class SkillLaunchConfig(BaseModel):
    id: str
    name: str
    description: str
    content: str


# ---------- sessions ----------


class TilePlacement(BaseModel):
    """An explicit grid position for a newly created session's tile."""

    model_config = ConfigDict(extra="forbid")

    x: int
    y: int
    w: int
    h: int


class SessionCreate(BaseModel):
    host_id: str
    cwd: str
    name: str | None = Field(default=None, max_length=128)
    # Omitted -> all skills marked enabled_by_default.
    skill_ids: list[str] | None = None
    # Optional: transactionally append a tile for this session to a workspace.
    workspace_id: str | None = None
    # Only meaningful with workspace_id; omitted -> server auto-places (§4.4).
    tile: TilePlacement | None = None


class SessionPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)


class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str | None = None
    host_id: str
    host_name: str | None = None
    cwd: str
    status: str
    started_at: datetime
    exited_at: datetime | None = None
    exit_code: int | None = None
    last_output_at: datetime | None = None
    last_input_at: datetime | None = None
    last_activity_at: datetime | None = None
    activity_state: str = "unknown"
    activity_label: str = "Unknown"
    foreground_command: str | None = None


# ---------- workspaces ----------

# A workspace icon is a small square thumbnail the browser renders itself, from
# an image found in the workspace's folder or picked by the owner. 32 KiB of
# base64 is roughly a 128x128 WebP with room to spare; anything larger is not an
# icon, it is a picture, and it would be paid for on every sidebar render.
WORKSPACE_ICON_MAX_CHARS = 32 * 1024
# Deliberately narrow: `data:` only, so a stored icon can never make a client
# fetch from a third party, and raster only — SVG is markup, and markup in an
# `<img>` is a surface we have no reason to take on for a 24px tile.
_WORKSPACE_ICON_PATTERN = re.compile(r"^data:image/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$")

WorkspaceIconSource = Literal["auto", "custom", "none"]


def validate_workspace_icon(value: str | None) -> str | None:
    """The icon as stored, or a `ValueError` naming what was wrong with it.

    Null is always allowed: it is how a workspace says "draw my initials".
    """
    if value is None:
        return None
    if len(value) > WORKSPACE_ICON_MAX_CHARS:
        raise ValueError("icon is too large")
    if _WORKSPACE_ICON_PATTERN.fullmatch(value) is None:
        raise ValueError("icon must be a base64 data URL of a PNG or WebP image")
    return value


class WorkspaceIconFields(BaseModel):
    """The icon pair, shared by workspaces and the templates saved from them.

    `icon` absent and `icon` explicitly null are different requests on a PATCH
    — "leave it" versus "clear it" — so routes read `model_fields_set` rather
    than testing for None.
    """

    icon: str | None = None
    icon_source: WorkspaceIconSource | None = None

    @field_validator("icon")
    @classmethod
    def _validate_icon(cls, value: str | None) -> str | None:
        return validate_workspace_icon(value)


class TileWidget(BaseModel):
    """Non-session pane content. A widget tile's `session_id` is its own id."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["files"]
    host_id: str
    path: str


class WorkspaceTile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    x: int
    y: int
    w: int
    h: int
    # Set -> the tile renders a widget instead of a session terminal.
    widget: TileWidget | None = None

    @model_serializer(mode="plain")
    def _serialize(self) -> dict:
        # `widget` stays off the wire unless set: session tiles are the norm
        # and their shape must not change.
        tile: dict = {
            "session_id": self.session_id,
            "x": self.x,
            "y": self.y,
            "w": self.w,
            "h": self.h,
        }
        if self.widget is not None:
            tile["widget"] = self.widget.model_dump()
        return tile


class WorkspaceLayout(BaseModel):
    """One tab's tile grid, in the 24x24 space of grid schema v3.

    A v2 grid is accepted and lifted on the way in. During a deploy there is a
    window where a browser still holds the old bundle and keeps PATCHing 12x12
    layouts; scaling them here means those writes land correctly instead of
    being rejected, or — far worse — being stored as v3 and read back at half
    scale. `grid.LAYOUT_VERSION` is the only thing that ever reaches the DB.
    """

    model_config = ConfigDict(extra="forbid")

    version: Literal[3]
    tiles: list[WorkspaceTile] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _lift_v2_grid(cls, value: Any) -> Any:
        return grid.lift_layout(value)


class WorkspaceTab(BaseModel):
    """One named 24x24 grid inside a workspace (layout schema v3).

    `host_id`/`cwd` are the tab's own default folder — where a window added to
    this tab opens. Null means "inherit the workspace's home", so a tab that
    has never been re-pointed follows the workspace as it moves; a host that
    stops being the owner's is nulled back to inheriting on the next write.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=64)
    layout: WorkspaceLayout
    host_id: str | None = None
    cwd: str | None = Field(default=None, max_length=1024)


class WorkspaceLayoutV3(BaseModel):
    """The workspace layout envelope: an ordered list of tabs, each holding a
    tile grid. The grid algebra (grid.py / grid.ts and the shared fixtures)
    sits below this — tabs are an envelope over it, and the two are versioned
    independently. A workspace always has at least one tab.
    """

    model_config = ConfigDict(extra="forbid")

    version: Literal[3]
    # The tab the workspace last had open; must name a tab when set. Carried
    # along on layout writes rather than written on every switch.
    active_tab: str | None = None
    tabs: list[WorkspaceTab] = Field(min_length=1, max_length=8)


class WorkspaceFirstSession(BaseModel):
    model_config = ConfigDict(extra="forbid")

    host_id: str
    cwd: str
    skill_ids: list[str] | None = None


class WorkspaceCreate(WorkspaceIconFields):
    # Omitted -> the server names it "Workspace N" (next free N).
    name: str | None = Field(default=None, max_length=128)
    # Optional: create the workspace and its first shell session atomically;
    # the session gets the full-canvas tile.
    first_session: WorkspaceFirstSession | None = None
    # The workspace's home host/folder, for a workspace created empty — the
    # tab opens on its empty state and every pane added later starts here.
    # Ignored when `first_session` is given, which sets the home itself.
    host_id: str | None = None
    cwd: str | None = Field(default=None, max_length=1024)


class WorkspacePatch(WorkspaceIconFields):
    name: str | None = Field(default=None, max_length=128)
    layout: WorkspaceLayoutV3 | None = None
    position: int | None = Field(default=None, ge=0)
    # The workspace's home host/folder ("core settings"): both optional and
    # independently patchable.
    host_id: str | None = None
    cwd: str | None = Field(default=None, max_length=1024)


class WorkspaceOut(WorkspaceIconFields):
    id: str
    name: str
    host_id: str | None = None
    cwd: str | None = None
    layout: WorkspaceLayoutV3
    position: int = 0
    # Set -> the workspace is put away: out of the default list and stopped.
    # Its layout is untouched, so what it holds is readable from `layout` and
    # the session rows it names, exactly as an active workspace's is.
    archived_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class WorkspaceCreateResponse(BaseModel):
    workspace: WorkspaceOut
    session: SessionOut | None = None


class TemplateRun(BaseModel):
    """What a template tile launches when instantiated."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["shell", "agent", "files"]
    # Required (non-empty) when kind == "agent": the command typed into the
    # freshly spawned shell.
    command: str | None = Field(default=None, max_length=512)


class TemplateTile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: int
    y: int
    w: int
    h: int
    run: TemplateRun


class TemplateTab(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=64)
    tiles: list[TemplateTile] = Field(default_factory=list, max_length=grid.MAX_TILES)


class WorkspaceTemplateSpec(BaseModel):
    """A workspace's shape, portable across folders: geometry + what runs.
    Tile geometry is validated against the same grid invariants as layouts.

    Version 2 carries 24x24 geometry; a v1 spec is 12x12 and is lifted on the
    way in, for the same reason `WorkspaceLayout` lifts a v2 grid.
    """

    model_config = ConfigDict(extra="forbid")

    version: Literal[2]
    tabs: list[TemplateTab] = Field(min_length=1, max_length=8)

    @model_validator(mode="before")
    @classmethod
    def _lift_v1_spec(cls, value: Any) -> Any:
        if not isinstance(value, dict) or value.get("version") != 1:
            return value
        scale = grid.GRID_COLS // grid.V2_GRID_COLS
        tabs = []
        for tab in value.get("tabs") or []:
            if not isinstance(tab, dict):
                tabs.append(tab)
                continue
            tiles = []
            for tile in tab.get("tiles") or []:
                if not isinstance(tile, dict):
                    tiles.append(tile)
                    continue
                scaled = dict(tile)
                for key in ("x", "y", "w", "h"):
                    size = scaled.get(key)
                    if isinstance(size, int) and not isinstance(size, bool):
                        scaled[key] = size * scale
                tiles.append(scaled)
            tabs.append({**tab, "tiles": tiles})
        return {**value, "version": 2, "tabs": tabs}


class WorkspaceTemplateCreate(WorkspaceIconFields):
    name: str = Field(min_length=1, max_length=128)
    # The folder the template remembers: instantiation goes straight there.
    host_id: str | None = None
    cwd: str | None = Field(default=None, max_length=1024)
    spec: WorkspaceTemplateSpec


class WorkspaceTemplatePatch(WorkspaceIconFields):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    host_id: str | None = None
    cwd: str | None = Field(default=None, max_length=1024)
    spec: WorkspaceTemplateSpec | None = None


class WorkspaceTemplateOut(WorkspaceIconFields):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    host_id: str | None = None
    cwd: str | None = None
    spec: WorkspaceTemplateSpec
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
    display, and only then treats `host_public_key` as introduced.
    """

    host_id: str
    host_name: str
    host_public_key: str
    endorser_device_id: str
    endorser_public_key: str
    endorser_label: str | None = None
    signature: str
