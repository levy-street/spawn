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
from .web_push import valid_subscription_key

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


class EmptyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SessionRenewResponse(BaseModel):
    access_token: str
    expires_at: datetime


class SessionTokenResponse(BaseModel):
    access_token: str


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
    # §3). BOUND in the V2 registration proof (security hardening B1): the
    # stored flag feeds real server-side authority (the R9 per-host endorsement
    # exemption and the pin-liveness ratchet), so the claim must carry the key
    # holder's signature — a flipped flag fails proof verification and is
    # refused.
    is_root: bool = False

    @field_validator("public_key")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        decode_ed25519_public_key(value)
        return value


class BrowserDeviceRevokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_public_key: str = Field(min_length=43, max_length=43)
    # Which of the caller's devices is asking — display attribution only (the
    # removed screen names its remover, R4); ignored if it isn't a live device
    # of this account. Never an authorization input.
    revoked_by_device_id: str | None = Field(default=None, min_length=36, max_length=36)

    @field_validator("expected_public_key")
    @classmethod
    def validate_expected_public_key(cls, value: str) -> str:
        decode_ed25519_public_key(value)
        return value


class BrowserDeviceOut(BaseModel):
    # No fingerprint field on purpose (mesh B5): the key is right here, so a
    # display fingerprint must be derived locally from it — a served one is a
    # server-authored comparison label a lazy consumer could trust.
    id: str
    key_algorithm: Literal["ed25519"]
    public_key: str
    label: str | None = None
    created_at: datetime
    last_seen_at: datetime | None = None
    # When this device last actively asked to be approved (it tried to open an
    # agent session). Surfaces — and re-surfaces — the approval toast elsewhere.
    approval_requested_at: datetime | None = None
    revoked_at: datetime | None = None
    revoked_by_device_id: str | None = None
    # True for the account root (pk_R): clients filter it out of connect/ceremony
    # lists since it never connects — it only endorses and anchors.
    is_root: bool = False


class RevokedBrowserKeyOut(BaseModel):
    """One entry of the account's PERMANENT key deny-list (R10 tombstones).

    Served so a client can corroborate a roster row's revocation claim against
    the add-only tombstone table before acting on it destructively (hardening
    B2): a bare roster lie is then insufficient — the server must also commit
    the claim into permanent, add-only state.
    """

    public_key: str
    key_algorithm: str
    revoked_at: datetime


class BrowserDeviceRenameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, max_length=64)


class BrowserDeviceApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The caller proves it is talking about the key it actually holds, exactly
    # like revoke's expected_public_key: a consistency check, not authorization
    # (the stamp is advisory display data either way).
    public_key: str = Field(min_length=43, max_length=43)

    @field_validator("public_key")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        decode_ed25519_public_key(value)
        return value


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
    id: Literal["google", "microsoft", "github", "apple"]
    name: str


class OAuthExchangeRequest(BaseModel):
    """The one-time code a native app carries back from the provider callback."""

    code: str = Field(min_length=16, max_length=256)
    # The PKCE verifier for the flow this client started. Optional on the wire
    # so app builds that predate PKCE keep working; required by the server
    # whenever the code was minted from a challenge.
    code_verifier: str | None = Field(default=None, min_length=43, max_length=128)


class AppleNativeSignInRequest(BaseModel):
    """The identity token the iOS Sign in with Apple sheet hands back.

    There is no one-time code here because there was no browser and no
    callback: the sheet is part of the app, so the token it produces is the
    whole of the evidence and is verified against Apple's keys on arrival.
    """

    identity_token: str = Field(min_length=16, max_length=8192)
    invite: str | None = Field(default=None, max_length=256)


class PushDeviceRegisterRequest(BaseModel):
    """Where to reach one app install when it is not holding a socket."""

    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=8, max_length=255)
    platform: Literal["ios", "android"]
    # Recognition only, for a future signed-in-devices screen. Never trusted.
    label: str | None = Field(default=None, max_length=64)
    # This install's browser device id, so its own knock is not pushed back to
    # it. Optional: older apps register without it.
    browser_device_id: str | None = Field(default=None, min_length=36, max_length=36)


class PushDeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    platform: str
    label: str | None = None
    created_at: datetime
    last_seen_at: datetime


class WebPushKeyOut(BaseModel):
    """What a browser needs before it can subscribe at all.

    `public_key` is the VAPID application server key, base64url and unpadded,
    ready to be decoded into the `applicationServerKey` that
    `pushManager.subscribe` demands. A server with no VAPID key configured
    answers `enabled: false` and a null key rather than an error: no browser
    channel is a supported deployment, and the web app's job is then to not
    offer the toggle.
    """

    enabled: bool
    public_key: str | None = None


class WebPushSubscribeRequest(BaseModel):
    """One `PushSubscription`, as `PushSubscription.toJSON()` serializes it.

    Both keys are validated here rather than at send time. A subscription the
    server cannot encrypt to is not a delivery failure to retire in three
    days' time; it is a malformed request, and saying so at the door is the
    only place the browser can still do something about it.
    """

    model_config = ConfigDict(extra="forbid")

    # Push services are HTTPS, always. The cap is far above any endpoint any
    # vendor issues and exists so a request body cannot be used to write an
    # unbounded string into the table.
    endpoint: str = Field(min_length=8, max_length=2048)
    # The subscription's P-256 public key: 65 bytes, uncompressed point.
    p256dh: str = Field(min_length=8, max_length=255)
    # The subscription's auth secret: 16 bytes.
    auth: str = Field(min_length=8, max_length=64)
    # Recognition only, for a future signed-in-devices screen. Never trusted.
    label: str | None = Field(default=None, max_length=64)
    # This browser's device id, so its own knock is not pushed back to it.
    browser_device_id: str | None = Field(default=None, min_length=36, max_length=36)

    @field_validator("endpoint")
    @classmethod
    def _https_endpoint(cls, value: str) -> str:
        value = value.strip()
        if not value.startswith("https://") or len(value.split("/", 3)[2]) == 0:
            raise ValueError("endpoint must be an absolute https URL")
        return value

    @field_validator("p256dh")
    @classmethod
    def _p256dh_is_a_point(cls, value: str) -> str:
        if not valid_subscription_key(value, length=65):
            raise ValueError("p256dh must be a base64url P-256 point of 65 bytes")
        return value.strip()

    @field_validator("auth")
    @classmethod
    def _auth_is_a_secret(cls, value: str) -> str:
        if not valid_subscription_key(value, length=16):
            raise ValueError("auth must be a base64url secret of 16 bytes")
        return value.strip()


class WebPushSubscriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    label: str | None = None
    created_at: datetime
    last_seen_at: datetime


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
    # Committed-ephemeral SAS: the daemon's commitment Cd = H(domain ‖ H ‖ Nd),
    # opaque to the server. Absent from a pre-SAS daemon.
    sas_commit: str | None = Field(default=None, min_length=43, max_length=43)
    # Accepted and ignored for compatibility with older daemons.
    setup_token: str | None = None

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
    # Both keys are echoed below, so no fingerprints ride along (mesh B5): the
    # approving browser verifies the echoed keys byte-for-byte and derives any
    # fingerprint it displays locally.
    host_name: str
    approval_nonce: str
    host_key_algorithm: Literal["ed25519"]
    host_public_key: str
    browser_device_id: str
    browser_key_algorithm: Literal["ed25519"]
    browser_public_key: str
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


class DevicePairingIntroductionItem(BaseModel):
    """One host-key introduction (mesh R7), relayed verbatim. The signature is
    over the SPAWN-HOST-INTRO-V1 transcript and only the joiner can judge it —
    against the initiator key its ceremony pinned. Shape checks only here."""

    model_config = ConfigDict(extra="forbid")

    host_id: str = Field(min_length=1, max_length=36)
    host_name: str = Field(min_length=1, max_length=128)
    host_public_key: str = Field(min_length=43, max_length=43)
    signature: str = Field(min_length=86, max_length=86)

    @field_validator("host_public_key")
    @classmethod
    def _validate_host_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value


class DevicePairingDeviceIntroductionItem(BaseModel):
    """One device-key introduction (continuous gossip bootstrap), relayed
    verbatim. The signature is over the SPAWN-DEVICE-INTRO-V1 transcript and
    only the joiner can judge it — against the initiator key its ceremony
    pinned. Shape checks only here."""

    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=36, max_length=36)
    device_label: str = Field(min_length=1, max_length=128)
    device_public_key: str = Field(min_length=43, max_length=43)
    signature: str = Field(min_length=86, max_length=86)

    @field_validator("device_public_key")
    @classmethod
    def _validate_device_key(cls, value: str) -> str:
        decode_ed25519_public_key(value)
        return value


class DevicePairingIntroductions(BaseModel):
    """Initiator's move, after the reveal: the hosts it vouches to the joiner,
    plus (optionally) the peer device keys it learned firsthand so the joiner
    can honor those peers' broadcast introductions later."""

    model_config = ConfigDict(extra="forbid")

    introductions: list[DevicePairingIntroductionItem] = Field(default_factory=list, max_length=64)
    device_introductions: list[DevicePairingDeviceIntroductionItem] = Field(
        default_factory=list, max_length=32
    )

    @model_validator(mode="after")
    def _require_some_payload(self) -> DevicePairingIntroductions:
        if not self.introductions and not self.device_introductions:
            raise ValueError("introductions must carry at least one host or device entry")
        return self


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
    introductions: list[DevicePairingIntroductionItem] | None = None
    device_introductions: list[DevicePairingDeviceIntroductionItem] | None = None
    created_at: datetime
    expires_at: datetime


class HostIntroductionPublish(BaseModel):
    """One durable broadcast introduction (continuous gossip). The signature is
    over the SPAWN-HOST-INTRO-BCAST-V1 transcript; the server verifies it
    against the publisher's registered key as hygiene, recipients re-verify it
    against the key they learned firsthand."""

    model_config = ConfigDict(extra="forbid")

    publisher_device_id: str = Field(min_length=36, max_length=36)
    host_id: str = Field(min_length=1, max_length=36)
    host_name: str = Field(min_length=1, max_length=128)
    host_public_key: str = Field(min_length=43, max_length=43)
    signature: str = Field(min_length=86, max_length=86)

    @field_validator("host_public_key")
    @classmethod
    def _validate_host_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value


class HostIntroductionOut(BaseModel):
    id: str
    publisher_device_id: str
    # The publisher's registered key, echoed for the recipient's convenience;
    # display-adjacent — acceptance requires the FIRSTHAND copy to match.
    publisher_public_key: str
    host_id: str
    host_name: str
    host_public_key: str
    signature: str
    created_at: datetime


class RootIntroductionPublish(BaseModel):
    """One durable root-key introduction (mesh §4.1 provenance channel). The
    signature is over the SPAWN-ROOT-INTRO-V1 transcript; the server verifies
    it against the introducer's registered key as hygiene, recipients
    re-verify it against the introducer key they learned firsthand."""

    model_config = ConfigDict(extra="forbid")

    introducer_device_id: str = Field(min_length=36, max_length=36)
    root_public_key: str = Field(min_length=43, max_length=43)
    signature: str = Field(min_length=86, max_length=86)

    @field_validator("root_public_key")
    @classmethod
    def _validate_root_key(cls, value: str) -> str:
        decode_host_public_key("ed25519", value)
        return value


class RootIntroductionOut(BaseModel):
    id: str
    introducer_device_id: str
    # The introducer's registered key, echoed for the recipient's convenience;
    # display-adjacent — acceptance requires the FIRSTHAND copy to match.
    introducer_public_key: str
    root_public_key: str
    signature: str
    created_at: datetime
    updated_at: datetime


# ---------- hosts ----------


class HostUpdateOut(BaseModel):
    state: Literal["current", "available", "updating", "failed", "unsupported", "unknown"]
    latest_version: str | None = None
    error: str | None = None
    requested_at: datetime | None = None


class HostDisconnectOut(BaseModel):
    at: datetime | None = None
    reason: str | None = None


class HostOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    os: str | None = None
    arch: str | None = None
    version: str | None = None
    daemon_tree: str | None = None
    update: HostUpdateOut = Field(default_factory=lambda: HostUpdateOut(state="unknown"))
    host_key_algorithm: Literal["ed25519"] | None = None
    # The key travels alone (mesh B5): its display fingerprint is derived
    # locally by the client, never served next to the key it must vouch for.
    host_public_key: str | None = None
    status: str
    last_seen_at: datetime | None = None
    last_disconnect: HostDisconnectOut = Field(default_factory=HostDisconnectOut)
    session_count: int = 0
    # Mesh R9: true once this host's daemon validates account-scoped chains;
    # the legacy per-host device-endorsement path is refused for such hosts.
    supports_account_chains: bool = False
    # Capacity. Every field is optional and stays None for a daemon that
    # predates telemetry or runs with SPAWND_NO_TELEMETRY — the UI draws no
    # meter rather than an empty one, which is a different statement.
    cpu_cores: int | None = None
    cpu_physical_cores: int | None = None
    cpu_model: str | None = None
    memory_bytes: int | None = None
    gpu: str | None = None
    # Meter segment counts in 0..=5, never percentages. Exact figures exist and
    # travel browser-to-daemon over `spawn.host.ctl`; see daemon host_metrics.
    cpu_bucket: int | None = None
    mem_bucket: int | None = None
    capacity_at: datetime | None = None


class HostUpdateResponse(BaseModel):
    update: HostUpdateOut


class HostUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allow_downgrade: bool = Field(default=False, strict=True)


# ---------- release ----------


class ServerReleaseOut(BaseModel):
    commit: str | None = None
    dirty: bool


class WebReleaseOut(BaseModel):
    build_id: str | None = None


class DaemonTargetOut(BaseModel):
    spawnd_sha256: str
    spawn_worker_sha256: str


class DaemonVariantOut(BaseModel):
    """An alternative build of the same daemon release — the same tree and
    counter, its own version suffix and hashes — served from
    `/api/install/<kind>/<target>/<variant>`. A daemon follows the variant it
    was built as; see "The diagnostics variant" in docs/RELEASE.md."""

    version: str
    targets: dict[str, DaemonTargetOut]


class DaemonReleaseOut(BaseModel):
    version: str
    commit: str
    tree: str
    release_counter: int | None = None
    signed: bool = False
    targets: dict[str, DaemonTargetOut]
    variants: dict[str, DaemonVariantOut] = Field(default_factory=dict)


class MobileReleaseOut(BaseModel):
    tree: str | None = None
    runtime_version: str | None = None


class ReleaseDesktop(BaseModel):
    version: str
    # None when a publish gap falls back to the previously published build,
    # whose tree is unknowable from the static directory alone.
    tree: str | None = None
    platforms: list[str]


class ReleaseProtocolsOut(BaseModel):
    daemon: str
    browser: str
    alerts: str


class ReleaseOut(BaseModel):
    server: ServerReleaseOut
    web: WebReleaseOut
    daemon: DaemonReleaseOut | None = None
    mobile: MobileReleaseOut
    desktop: ReleaseDesktop | None = None
    protocols: ReleaseProtocolsOut


class LegionDayOut(BaseModel):
    """One UTC day of fleet activity. Sparse: unrecorded days are simply absent."""

    model_config = ConfigDict(from_attributes=True)
    day: str
    sessions_started: int = 0
    session_seconds: int = 0
    peak_sessions: int = 0
    peak_hosts_online: int = 0


class LegionAgentOut(BaseModel):
    """A foreground basename and how often it has been seen. Never a path."""

    command: str
    count: int


class LegionTotalsOut(BaseModel):
    hosts: int = 0
    hosts_online: int = 0
    # Summed across hosts that report them; a fleet with one silent daemon
    # under-reports rather than guessing.
    cores: int = 0
    memory_bytes: int = 0
    sessions_live: int = 0
    sessions_started: int = 0
    session_seconds: int = 0
    active_days: int = 0
    current_streak: int = 0
    longest_streak: int = 0
    peak_hosts_online: int = 0
    peak_sessions: int = 0
    first_day: str | None = None


class LegionHostOut(BaseModel):
    """A host as the profile lists it — identity and spec, no live buckets."""

    id: str
    name: str
    os: str | None = None
    status: str
    cpu_cores: int | None = None
    memory_bytes: int | None = None
    gpu: str | None = None
    session_count: int = 0
    created_at: datetime | None = None
    last_seen_at: datetime | None = None


class ProfileOut(BaseModel):
    """Everything the profile dialog draws, in one request."""

    id: str
    email: str
    created_at: datetime
    email_verified_at: datetime | None = None
    is_admin: bool = False
    totals: LegionTotalsOut
    agents: list[LegionAgentOut] = Field(default_factory=list)
    days: list[LegionDayOut] = Field(default_factory=list)
    hosts: list[LegionHostOut] = Field(default_factory=list)
    # The window `days` covers, so the client can densify it into a calendar
    # without having to agree with the server about "today" independently.
    history_days: int
    today: str


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
    yolo_args: str | None = Field(default=None, max_length=256)
    yolo_env: dict[str, str] = Field(default_factory=dict)


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    kind: str | None = Field(default=None, max_length=64)
    command: str | None = Field(default=None, max_length=1024)
    env: dict[str, str] | None = None
    install: str | None = Field(default=None, max_length=2048)
    yolo_args: str | None = Field(default=None, max_length=256)
    yolo_env: dict[str, str] | None = None


class AgentPreferencePatch(BaseModel):
    """Settings a user holds over an agent — built-ins included."""

    yolo: bool | None = None


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
    # How this CLI is told to skip its permission prompts. Both empty means it
    # has no such mode, and the client does not offer the toggle.
    yolo_args: str | None = None
    yolo_env: dict[str, str] = Field(default_factory=dict)
    # The reading user's own choice, not a property of the definition.
    yolo: bool = False


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
    # The agent this window is being opened as, when it is being opened as one.
    # The window still starts as a login shell — the client types the agent's
    # command into it — and this is what makes the window's type outlive the
    # process, so a duplicate can reproduce it.
    agent_id: str | None = None
    # Omitted -> all skills marked enabled_by_default.
    skill_ids: list[str] | None = None
    # Optional: transactionally append a tile for this session to a workspace.
    workspace_id: str | None = None
    # Only meaningful with workspace_id; omitted -> server auto-places.
    tile: TilePlacement | None = None


class SessionPatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    # Sent when an agent is launched into a running window, and sent as null
    # when the window is stopped back to a bare prompt. Omitted leaves it be.
    agent_id: str | None = None


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
    # What this window was opened as; `foreground_command` is what is running
    # in it now. See models.Session.agent_id.
    agent_id: str | None = None


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
    agent_id: str | None = None
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


class DeviceApprovalRequestCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    browser_device_id: str = Field(min_length=36, max_length=36)


class DeviceApprovalRequestOut(BaseModel):
    """One device waiting to be admitted, as shown to the account's others.

    `fingerprint` is derived server-side from the stored key, but the approving
    device re-derives it from the key it signs over — the operator compares
    what the two screens show, and that comparison, not this field, is what
    makes the ceremony safe.
    """

    id: str
    browser_device_id: str
    label: str | None
    fingerprint: str
    status: str
    created_at: datetime
    expires_at: datetime


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
    # No endorsed_key_fingerprint (mesh B5): the endorser just signed over the
    # endorsed key it verified on-screen, so a server-derived fingerprint here
    # is at best redundant and at worst a substituted comparison label.
    host_id: str
    endorsed_device_id: str
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
