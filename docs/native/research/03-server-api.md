# R03 — Backend HTTP API surface and contracts

## TL;DR

1. The live server exposes 79 HTTP routes and four WebSockets; there are no REST routes for files, notifications, billing, tabs, or TURN credentials.
2. Every JSON field is `snake_case`; IDs are UUID strings and datetimes are RFC 3339 strings, while FastAPI errors are normally `{ "detail": ... }`.
3. Authenticated REST accepts `Authorization: Bearer`, the `spawn_session` cookie, or `?token=`; bearer is the correct native transport.
4. Password login/signup/reset returns only a 15-minute access JWT in JSON; the 30-day JWT exists only as an HttpOnly cookie and there is no refresh endpoint.
5. The native app therefore cannot sustain a session correctly without one additive backend refresh-token flow; do this before mobile authentication is considered complete.
6. Google/Microsoft/GitHub OAuth ends in a web-relative redirect plus cookie and cannot return to an app deep link; native OAuth needs an additive PKCE code handoff.
7. `/ws/browser`, `/ws/host`, and `/ws/alerts` accept the user JWT by header, cookie, or query; only the query path is guaranteed by the current cross-platform contract.
8. WebSocket signaling has no replay cursor or sequence number; reconnect means refetching REST state and creating fresh RTC signaling bindings.
9. TURN credentials are minted inside each `rtc.config`/`rtc.offer`, default to 24 hours, and have no standalone HTTP endpoint.
10. The only Expo dependency recommended here is `expo-secure-store ~57.0.1`; it is included in Expo Go, but Expo Go cannot use its Face ID-gated option.

## Scope, authority, and counting

This report describes the source at 2026-08-22. The route count is 79 HTTP operations: 78 router operations plus `GET /healthz`. It also covers four WebSockets. `main.py` is the final authority for what is mounted: every HTTP router and all four WS routers are included there (`server/spawn_server/main.py:68-104`). The implementation matrix correctly identifies REST as the registry/lifecycle plane and direct channels as the terminal/file plane (`docs/INTERFACE_MATRIX.md:16-42`).

Where older prose conflicts with source, this report follows source. Two notable stale statements are:

- The current workspace grid is 24×24, minimum tile 4×4, maximum 16 tiles (`server/spawn_server/grid.py:19-31`), even though a model docstring and an older interface paragraph still say 12×12 (`server/spawn_server/models.py:594-613`, `docs/INTERFACE_MATRIX.md:44-53`).
- Archive now retains session rows and layout, then restarts the same sessions on unarchive (`server/alembic/versions/0040_archive_is_suspend.py:1-15`); the old archived-shape contract has been removed.

The server is FastAPI/Pydantic v2/SQLAlchemy async. Dependency lower bounds—not exact lock versions—are FastAPI ≥0.115, Pydantic ≥2.9, SQLAlchemy ≥2.0.36, PyJWT ≥2.10, Redis ≥5.2, and cryptography ≥44 (`server/pyproject.toml:1-22`).

## Universal wire conventions

### JSON, identifiers, and optionality

- REST is JSON in/JSON out unless the endpoint explicitly returns `204`, a redirect, a binary, or shell text. The protocol contract states `Content-Type: application/json`, bearer support, UUID strings, and RFC 3339 timestamps (`proto/README.md:37-50`).
- Pydantic field names are emitted literally: all API JSON is `snake_case`; there is no alias generator (`server/spawn_server/schemas.py:1-18`).
- In the TypeScript definitions below, `field?: T` means a request key may be omitted. `field: T | null` means the response key is present but nullable. Pydantic defaults generally make omitted request keys legal; request models marked `extra="forbid"` reject unknown keys with 422. Models without that setting use Pydantic's default of ignoring unknown keys.
- JSON datetimes are represented below as `IsoDateTime = string`; JSON dates such as Legion day are `IsoDate = string`.

Representative real schemas:

```py
class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    invite: str | None = Field(default=None, max_length=256)

class TokenResponse(BaseModel):
    access_token: str
    user: UserOut

class SessionCreate(BaseModel):
    host_id: str
    cwd: str
    name: str | None = Field(default=None, max_length=128)
    skill_ids: list[str] | None = None
    workspace_id: str | None = None
    tile: TilePlacement | None = None
```

`server/spawn_server/schemas.py:34-57`, `server/spawn_server/schemas.py:685-705`.

### Success and error envelopes

There is no custom exception handler (`server/spawn_server/main.py:68-106`). Consequently:

```ts
type HttpErrorBody = { detail: string };
type ValidationErrorBody = {
  detail: Array<{
    type: string;
    loc: Array<string | number>;
    msg: string;
    input?: unknown;
    ctx?: Record<string, unknown>;
  }>;
};
```

- Explicit `HTTPException` failures are normally `{ "detail": "literal message" }`.
- Request/path/query validation is FastAPI's `422` detail array.
- Unhandled failures are plain `500 Internal Server Error` unless middleware/deployment changes them.
- `204` has no body. Redirects use `302` and a `Location` header. Installer binaries use `application/octet-stream`; `/install.sh` uses `text/x-shellscript` (`server/spawn_server/routes/install.py:87-143`).
- `POST /api/auth/device/poll` is the exception: device-flow conditions are **HTTP 200** bodies shaped `{ "error": DevicePollError }`, not HTTP errors (`server/spawn_server/routes/device.py:294-398`, `server/spawn_server/routes/device.py:595-625`).

Every JSON endpoint can also return 422. Every authenticated endpoint can return 401. The catalogue lists domain-specific statuses in addition to those universal cases.

### Authentication legend used below

| Mark | Requirement |
|---|---|
| Public | No authentication dependency. |
| User | Current user JWT via bearer, cookie, or query token. |
| Verified | User auth plus verified email only when `SPAWN_REQUIRE_EMAIL_VERIFICATION=true` **and** SMTP is actually ready. |
| Admin | Current user with `is_admin=true`; non-admin deliberately receives 404. |
| Daemon | Daemon JWT, used only on `/ws/daemon`; not a mobile client credential. |

`current_user` resolves bearer first, then `spawn_session`, then query `token`; it verifies `kind`, `sub`, existence, and `session_epoch` (`server/spawn_server/auth.py:135-171`). `verified_user` applies the conditional verification gate (`server/spawn_server/auth.py:174-198`). Admin hides the surface with 404 (`server/spawn_server/routes/admin.py:31-40`).

### Rate limiting

Rate limits are fixed-window, per first `X-Forwarded-For` hop or socket IP. Redis is preferred and a per-process counter is the fail-open fallback. A blocked request is `429`, body `{ "detail":"too many requests; slow down" }`, with integer `Retry-After` seconds (`server/spawn_server/rate_limit.py:38-109`). Only these routes are limited:

| Rule | Route | Limit |
|---|---|---:|
| `signup` | `POST /api/auth/signup` | 5 / 3600 s |
| `login` | `POST /api/auth/login` | 20 / 900 s |
| `password_reset` | `POST /api/auth/password-reset/request` | 5 / 3600 s |
| `verify_resend` | `POST /api/auth/verify-email/request` | 5 / 3600 s |
| `device_pairing` | `POST /api/auth/device/start` | 30 / 3600 s |

The literal rules are defined at `server/spawn_server/rate_limit.py:121-125`. `SPAWN_RATE_LIMIT_ENABLED=false` disables them (`server/spawn_server/config.py:76-78`). No other route has an application rate limit.

## Complete endpoint catalogue

Schema names in this catalogue refer to the full copy-ready TypeScript definitions in [Native API client shape](#native-api-client-shape). `—` means no request body. Unless noted, a success with a response schema is 200.

### Health, auth, and account

| Method and path | Auth | Input | Success | Domain errors | Rate |
|---|---|---|---|---|---|
| `GET /healthz` | Public | — | `200 HealthzResponse` | — | none |
| `GET /api/auth/config` | Public | — | `200 AuthConfigOut` | — | none |
| `POST /api/auth/signup` | Public | `SignupRequest` | `200 TokenResponse`; also sets 30-day cookie | `403` closed/no invite or invalid invite; `409` email exists | 5/hour |
| `POST /api/auth/login` | Public | `LoginRequest` | `200 TokenResponse`; also sets cookie | `401 invalid credentials` | 20/15 min |
| `POST /api/auth/logout` | Public | — | `204`; deletes cookie only | — | none |
| `GET /api/me` | User | — | `200 MeResponse` | — | none |
| `POST /api/account/delete` | User | `AccountDeleteRequest` | `204`; deletes account and cookie | `403 confirmation email does not match this account`; `403 password confirmation failed` | none |
| `POST /api/auth/password-reset/request` | Public | `PasswordResetRequest` | `204` whether account exists or mail fails | — | 5/hour |
| `POST /api/auth/password-reset/confirm` | Public | `PasswordResetConfirm` | `200 TokenResponse`; sets cookie | `400 this link is no longer valid`; `400 this link has expired` | none |
| `POST /api/auth/verify-email/request` | User | — | `204`, including already verified | mail send is best-effort | 5/hour |
| `POST /api/auth/verify-email/confirm` | Public | `EmailVerifyConfirm` | `200 MeResponse`; **does not issue a token/cookie** | same 400 link errors | none |
| `GET /api/auth/oauth/{provider}/start` | Optional user | path `provider: ProviderId`; query `return_to?: string` default `/` | `302` provider authorization URL | `404 unknown/disabled provider` | none |
| `GET /api/auth/oauth/{provider}/callback` | Public | path provider; query `state`, `code`, optional `error` read from request | `302` sanitized saved web-relative path; sets cookie | `400` provider/missing/used/expired state; `401 user gone`; `502` provider exchange/profile errors | none |

Routes and declared response models are at `server/spawn_server/routes/auth.py:27-149`, `server/spawn_server/routes/account_recovery.py:119-206`, `server/spawn_server/routes/auth_config.py:12-27`, and `server/spawn_server/routes/auth_providers.py:371-442`. Signup normalizes email, assigns first-account/bootstrap admin, and consumes one invite (`server/spawn_server/routes/auth.py:32-96`). Password reset marks email verified and increments `session_epoch`, invalidating both access and cookie JWTs minted under the old epoch (`server/spawn_server/routes/account_recovery.py:154-176`, `server/spawn_server/models.py:45-54`).

OAuth `return_to` is reduced to an internal path—absolute/external values become `/`—and provider IDs are exactly `google`, `microsoft`, `github` (`server/spawn_server/routes/auth_providers.py:53-76`, `server/spawn_server/routes/auth_providers.py:78-89`). Provider availability requires both client ID and secret (`server/spawn_server/routes/auth_providers.py:125-144`).

### Daemon device-code pairing

These are part of the public backend surface, but mobile only calls `pending` and `approve`; `start`, `possession`, and `poll` are daemon flows.

| Method and path | Auth | Input | Success | Domain errors | Rate |
|---|---|---|---|---|---|
| `POST /api/auth/device/start` | Public | `DeviceStartRequest` | `200 DeviceStartResponse` | `409 could not allocate device code; retry`; rare `500 could not allocate user_code` | 30/hour |
| `POST /api/auth/device/possession` | Public | `DevicePossessionRequest` | `200 {verified:true,version:1}`; exact retry is idempotent | `400 expired`; `404 unknown`; `409 binding changed/no longer provable`; invalid signature becomes validation/400 from proof helper | none |
| `POST /api/auth/device/poll` | Public | `DevicePollRequest` | `200 DevicePollSuccess | DevicePollPending` | Device errors remain 200 | none |
| `POST /api/auth/device/pending` | User | `DevicePendingRequest` | `200 DevicePendingResponse` | `400 expired/not pending/legacy`; `404 unknown code`; `409 possession proof pending` | none |
| `POST /api/auth/device/approve` | Verified | `DeviceApproveRequest` | `200 DeviceApproveResponse` | `400/404/409` from pending; `409` changed identity, retained/paired host key, changed/revoked browser, CAS conflict | none |

The ceremony lasts 1,800 seconds and advertises a five-second poll interval (`server/spawn_server/routes/device.py:23-30`, `server/spawn_server/routes/device.py:141-149`). Poll error literals are `authorization_pending`, `slow_down`, `expired_token`, `denied`, `invalid_device_binding`, `key_conflict`, `pin_conflict`, and `pin_limit` (`server/spawn_server/schemas.py:303-329`). A host allows at most 32 browser pins (`server/spawn_server/routes/device.py:25-30`).

The daemon success token is a 365-day `kind:"daemon"` JWT bound to `host:<id>` and `user_id`; it must never be stored as a mobile user token (`server/spawn_server/auth.py:91-100`).

### Browser devices

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `POST /api/browser-devices/register` | User | `BrowserDeviceRegisterRequest` | `200 BrowserDeviceOut`; exact active re-registration is idempotent | `409 browser public key is unavailable` or key owned elsewhere/proof conflict |
| `GET /api/browser-devices` | User | — | `200 BrowserDeviceOut[]`, newest first, active and revoked | — |
| `POST /api/browser-devices/prune` | User | — | `200 {pruned:number}`; hard-deletes this user's revoked tombstones | — |
| `POST /api/browser-devices/{device_id}/revoke` | User | path ID; `BrowserDeviceRevokeRequest` | `200 BrowserDeviceOut`; pushes new pin sets | `404 not found`; `409 expected key mismatch` or commit failure |
| `PATCH /api/browser-devices/{device_id}` | User | path ID; `BrowserDeviceRenameRequest` | `200 BrowserDeviceOut`; revoked rows can be renamed | `404 not found` |

Registration verifies an Ed25519 proof over the account and key; request shape forbids extras (`server/spawn_server/schemas.py:67-95`). Route behavior and ordering are at `server/spawn_server/routes/browser_devices.py:46-235`.

### Hosts and host agent availability

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `GET /api/hosts` | User | — | `200 HostOut[]` | — |
| `GET /api/hosts/{host_id}` | User | path ID | `200 HostOut` | `404 host not found` |
| `PATCH /api/hosts/{host_id}` | User | path ID; `HostPatch` | `200 HostOut` | `404 host not found` |
| `GET /api/hosts/{host_id}/agents` | User | path ID | `200 HostAgentList` | `404 host`; `409 daemon offline`; `504 check timed out` after 15 s |
| `GET /api/hosts/{host_id}/recent-dirs` | User | path ID | `200 RecentDirList`; newest first, maximum 8 | `404 host` |
| `POST /api/hosts/{host_id}/control/ping` | User | path ID | `204` | `404 host`; `409 daemon offline`; `504` after 3 s |
| `POST /api/hosts/{host_id}/agents/{agent_id}/install` | User | path IDs; — | `200 HostAgentInstallResult` (including `success:false`) | `400 no install command`; `404 host/agent`; `409 offline`; `504` after 180 s |
| `PATCH /api/hosts/{host_id}/agents/{agent_id}/policy` | User | path IDs; `HostAgentPolicyPatch` | `200 HostAgentPolicyOut` | `404 host/agent` |
| `DELETE /api/hosts/{host_id}` | User | path ID | `204`; closes daemon and cascades owned data, retains key claim | `404`; `409 host key ownership claim is invalid` |

`HostOut.status` is currently `online | offline`; list/get compute fingerprints, session counts, and suppress capacity buckets for offline hosts (`server/spawn_server/routes/hosts.py:385-451`). The agent check/install RPC timeouts and routes are implemented at `server/spawn_server/routes/hosts.py:479-612`. Recent directories are at most eight by both migration and route (`server/alembic/versions/0032_recent_dirs.py:1-24`, `server/spawn_server/routes/hosts.py:523-545`).

### Sessions and access grants

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `GET /api/sessions` | User | query `host_id?: string` | `200 SessionOut[]`, newest `started_at` first | — |
| `POST /api/sessions` | User | `SessionCreate` | `201 SessionOut` | `400 tile requires workspace_id`/invalid tile; `404 host/workspace/skill`; `409 workspace_archived`/`workspace_full` |
| `GET /api/sessions/{session_id}` | User | path ID | `200 SessionOut` | `404 session not found` |
| `PATCH /api/sessions/{session_id}` | User | path ID; `SessionPatch` | `200 SessionOut`; explicit null/blank clears name | `404` |
| `POST /api/sessions/{session_id}/restart` | User | path ID; — | `200 SessionOut` | `404 session/host`; `409 host daemon is offline` |
| `DELETE /api/sessions/{session_id}` | User | path ID | `204`; best-effort kill then hard-delete | `404` |
| `GET /api/sessions/{session_id}/access` | User | path ID | `200 SessionAccessOut` | `404 session` |
| `PATCH /api/sessions/{session_id}/access` | User | path ID; `SessionAccessPatch` | `200 SessionAccessOut` | `404 session/skill` |

List filtering is only `host_id`; there is no workspace/status/search filter (`server/spawn_server/routes/sessions.py:217-233`). Creation commits a durable `starting` row even if the daemon is offline, and dispatch is best effort (`server/spawn_server/routes/sessions.py:269-333`). Restart requires an online daemon (`server/spawn_server/routes/sessions.py:337-377`). Access patch semantics are important: omitted or JSON `null` `skill_ids` preserves current grants; `[]` clears them (`server/spawn_server/schemas.py:666-672`, `server/spawn_server/routes/capabilities.py:192-217`).

Derived activity is not stored as an enum. `SessionOut.activity_state`/`activity_label` are computed from status, foreground command, and activity timestamps; the server's waiting window is eight seconds, kept equal to alert quiet time (`server/spawn_server/routes/sessions.py:21-78`, `server/spawn_server/ws/alerts.py:47-63`).

### Skills

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `GET /api/skills` | User | — | `200 SkillOut[]` | — |
| `POST /api/skills` | User | `SkillCreate` | `201 SkillOut` | `400 name required`; `409 duplicate name` |
| `PATCH /api/skills/{skill_id}` | User | path ID; `SkillPatch` | `200 SkillOut` | `400 name required`; `404`; `409 duplicate name` |
| `DELETE /api/skills/{skill_id}` | User | path ID | `204` | `404` |

Routes are at `server/spawn_server/routes/capabilities.py:122-190`; the two session access operations are catalogued with sessions above.

### Agent definitions and preferences

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `GET /api/agents` | User | — | `200 AgentOut[]`; shared built-ins plus owned definitions | — |
| `POST /api/agents` | User | `AgentCreate` | `201 AgentOut` | `400 name/command required`; `409 duplicate name` |
| `PATCH /api/agents/{agent_id}` | User | path ID; `AgentPatch` | `200 AgentOut` | `400 required fields`; `404` also hides immutable built-ins; `409 duplicate` |
| `DELETE /api/agents/{agent_id}` | User | path ID | `204` | `404` also hides built-ins |
| `PATCH /api/agents/{agent_id}/preferences` | User | path ID; `AgentPreferencePatch` | `200 AgentOut` | `400 yolo missing/unsupported`; `404 agent` |

Agent `kind` is an unconstrained string up to 64 characters, not a server enum (`server/spawn_server/schemas.py:594-635`). Seeded kinds are `claude-code`, `codex`, `opencode`, and `aider`; built-ins have `owner_user_id:null` and cannot be mutated (`server/spawn_server/agents_builtin.py:29-71`, `server/spawn_server/routes/agents.py:70-184`).

### Workspaces and tabs

There is **no `/api/tabs` route**. Tabs are value objects inside `WorkspaceOut.layout.tabs`; every tab mutation is a whole `WorkspacePatch.layout` write. The envelope is version 3, one to eight tabs, each tab one 24×24 version-3 grid of up to 16 tiles (`server/spawn_server/schemas.py:814-866`, `server/spawn_server/grid.py:19-31`).

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `GET /api/workspaces` | User | query `archived: bool = false` | `200 WorkspaceOut[]`; active by position, archived newest first | — |
| `POST /api/workspaces` | User | `WorkspaceCreate` | `201 WorkspaceCreateResponse` | `404 home/first-session host or skill`; validation/layout errors |
| `GET /api/workspaces/{workspace_id}` | User | path ID | `200 WorkspaceOut` | `404` |
| `PATCH /api/workspaces/{workspace_id}` | User | path ID; `WorkspacePatch` | `200 WorkspaceOut` | `400 name/cwd/layout/tab invariants`; `404 workspace/host` |
| `POST /api/workspaces/{workspace_id}/archive` | User | path ID; — | `200 WorkspaceOut`; stops sessions, retains rows/layout | `404`; `409 workspace_archived` |
| `POST /api/workspaces/{workspace_id}/unarchive` | User | path ID; — | `200 WorkspaceOut`; restarts same sessions on online hosts | `404`; `409 workspace_not_archived` |
| `DELETE /api/workspaces/{workspace_id}` | User | path ID | `204`; best-effort kills and hard-deletes contained sessions | `404` |

Workspace routes and ordering are at `server/spawn_server/routes/workspaces.py:306-569`. Layout validation rejects duplicate tab IDs, a missing `active_tab`, and any grid invariant violation (`server/spawn_server/routes/workspaces.py:174-204`). Icons are only base64 `data:image/png` or `data:image/webp`, maximum 32 KiB characters; remote URLs and SVG are rejected (`server/spawn_server/schemas.py:733-756`). Patch distinguishes an absent `icon` from explicit `icon:null` using `model_fields_set` (`server/spawn_server/schemas.py:760-774`).

`WorkspacePatch.host_id` and `cwd` are typed nullable, but the current route applies these fields only when non-null; clients cannot clear them to null with PATCH. Treat null as “no change” for those two fields (`server/spawn_server/routes/workspaces.py:409-449`).

### Workspace templates

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `GET /api/workspace-templates` | User | — | `200 WorkspaceTemplateOut[]`, name ascending | — |
| `POST /api/workspace-templates` | User | `WorkspaceTemplateCreate` | `201 WorkspaceTemplateOut` | `400 name/home/spec/run/geometry`; `404 host` |
| `PATCH /api/workspace-templates/{template_id}` | User | path ID; `WorkspaceTemplatePatch` | `200 WorkspaceTemplateOut` | same 400/404 errors |
| `DELETE /api/workspace-templates/{template_id}` | User | path ID | `204` | `404` |

A spec is version 2, one to eight tabs, up to 16 tiles per tab. Run kind is `shell | agent | files`; `agent` requires a non-empty command and other kinds reject a command (`server/spawn_server/schemas.py:920-999`, `server/spawn_server/routes/workspace_templates.py:22-50`). Version-1 12×12 specs are accepted and doubled to version-2 24×24 geometry (`server/spawn_server/schemas.py:948-984`).

### Trust bundle, passkey metadata, and endorsements

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `GET /api/trust/bundle` | User | — | `200 TrustBundleOut | null` | — |
| `PUT /api/trust/bundle` | User | `TrustBundlePut` | `200 TrustBundleOut`, CAS revision increments | `409` expected revision conflict; `413` sealed UTF-8 >256 KiB |
| `GET /api/trust/passkeys` | User | — | `200 PasskeyCredentialOut[]`, oldest first | — |
| `POST /api/trust/passkeys` | User | `PasskeyCredentialCreate` | `200 PasskeyCredentialOut`; duplicate credential is idempotent | `409` 32-item capacity/storage conflict |
| `DELETE /api/trust/passkeys/{passkey_id}` | User | path ID | `204` | `404 passkey not found` |
| `GET /api/trust/endorsements` | User | required query `endorsed_device_id: string` | `200 BrowserEndorsementRecord[]` | — |
| `POST /api/trust/endorsements` | User | `BrowserEndorsementCreate` | `200 BrowserEndorsementOut`; exact existing pin is idempotent | `404 host/device`; `409 missing host key, revoked device, untrusted endorser, 32-pin capacity, storage conflict` |
| `GET /api/trust/hosts/{host_id}/pins` | User | path ID | `200 string[]` browser device IDs | `404 host` |

The opaque sealed bundle is compare-and-set protected and limited to 256 KiB; passkeys are capped at 32 (`server/spawn_server/routes/trust_bundle.py:31-76`, `server/spawn_server/routes/trust_bundle.py:124-170`). Passkey records are only credential-ID metadata. The server explicitly never verifies a WebAuthn assertion or receives the PRF secret (`server/spawn_server/models.py:175-183`). Endorsements add immutable host/browser pins after proof verification (`server/spawn_server/routes/trust_bundle.py:212-410`).

**Expo Go conflict:** native WebAuthn PRF is not supplied by these endpoints, and no server authentication assertion can substitute for it. A mobile client may list credential metadata but cannot unlock or reseal the web trust bundle unless its Expo-Go-compatible runtime can produce the same WebAuthn PRF output. **UNKNOWN:** whether the target Expo SDK's JS runtime/system auth session can obtain the existing relying-party PRF credential without a custom native module. Resolve with a physical-iPhone spike against the production RP ID. Until then, the Expo Go fallback is local device pins plus the existing signed device approval/endorsement flow; do not pretend a biometric SecureStore key is cross-device-compatible with the web bundle.

### Profile / Legion

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `GET /api/profile` | User | — | `200 ProfileOut` | — |

The response contains lifetime totals, top eight foreground basenames, sparse activity days over the latest 120 UTC days, and current hosts. The response explicitly includes `history_days` and server `today` so clients densify consistently (`server/spawn_server/routes/profile.py:31-154`, `server/spawn_server/legion.py:35-42`). There is no separate `/api/legion` endpoint.

### Admin

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `GET /api/admin/users` | Admin | — | `200 AdminUserOut[]`, oldest account first | non-admin `404 not found` |
| `GET /api/admin/invites` | Admin | — | `200 AdminInviteOut[]`, newest first; old rows never reveal URL/code | non-admin 404 |
| `POST /api/admin/invites` | Admin | `AdminInviteCreate` | `200 AdminInviteOut`; this response alone includes `url`; invite mail is best-effort | non-admin `404 not found` |
| `POST /api/admin/invites/{invite_id}/revoke` | Admin | path ID; — | `200 AdminInviteOut`; repeated revoke remains revoked | `404 invite not found` |
| `GET /api/admin/mail` | Admin | — | `200 AdminMailStatus` | non-admin 404 |
| `GET /api/admin/emails` | Admin | query `limit:int=100`, clamped to 1…500 | `200 AdminEmailOut[]`, newest first | non-admin 404 |
| `POST /api/admin/emails/test` | Admin | `AdminTestEmail` | `200 AdminEmailOut` for recorded attempt | `500` if mailer recorded nothing; delivery failure details recorded | none |

Admin schemas are defined at `server/spawn_server/schemas.py:144-199`; routes and sorting are at `server/spawn_server/routes/admin.py:31-238`. Invite state literals are `pending | used | expired | revoked` (`server/spawn_server/invites.py:54-67`).

### Installer / other public responses

| Method and path | Auth | Input | Success | Domain errors |
|---|---|---|---|---|
| `GET /api/install/spawnd/{target}` | Public | target literal set below | `200` binary attachment `spawnd`, `Cache-Control:no-store` | `404 unsupported` or unavailable binary |
| `GET /api/install/spawn-worker/{target}` | Public | target | `200` binary attachment `spawn-worker`, no-store | same 404 forms |
| `GET /install.sh` | Public | — | `200 text/x-shellscript`, no-store | — |

Targets are `darwin-aarch64`, `darwin-x86_64`, `linux-aarch64`, and `linux-x86_64` (`server/spawn_server/routes/install.py:18-25`). These are daemon-host utilities, not expected mobile UI downloads.

### Domains with no HTTP route

- **Files:** no REST route. Directory browsing, reads/previews, reveal/open, and file streams are `spawn.host.ctl` direct-channel operations (`docs/INTERFACE_MATRIX.md:25-28`).
- **Tabs:** nested in workspace layout; no tab router (`server/spawn_server/schemas.py:835-866`).
- **Signaling:** WS only; no offer/answer/ICE HTTP endpoint (`server/spawn_server/main.py:97-100`).
- **Notifications:** `/ws/alerts` only; there is no server persistence or HTTP notification preferences API (`docs/INTERFACE_MATRIX.md:40-42`). Web notification preferences are local client state, so mobile must define its own local preference store.
- **Billing:** no routes, schema, model, or settings exist in the mounted server.
- **TURN:** no credential endpoint; credentials ride signaling frames (`server/spawn_server/turn.py:25-40`).

## Authentication and authorization, exact behavior

### JWT claims and precedence

User JWTs have this exact logical payload:

```json
{
  "sub": "user:<uuid>",
  "kind": "access",
  "epoch": 0,
  "iat": 1787360000,
  "exp": 1787360900
}
```

Both the 15-minute JSON token and 30-day cookie token use `kind:"access"`; only TTL differs (`server/spawn_server/auth.py:64-88`). Default signing is `HS256` with `SPAWN_JWT_SECRET` (`server/spawn_server/config.py:25-31`). REST precedence is:

1. `Authorization: Bearer <jwt>`
2. Cookie `spawn_session=<jwt>`
3. Query `?token=<jwt>`

`server/spawn_server/auth.py:126-155`.

The OAuth-start route is the one exception: its optional-user dependency accepts bearer or cookie, not query `token`, and treats any invalid/evicted token as anonymous (`server/spawn_server/auth.py:199-223`). This matters for account linking.

Every user-token REST request reads the user row and checks `epoch`. Password reset increments the row's epoch; absent legacy claims are treated as epoch 0 (`server/spawn_server/auth.py:158-171`). Account deletion removes the user. Ordinary logout does **not** revoke bearer or server-side state; it only expires the cookie (`server/spawn_server/routes/auth.py:128-134`).

### Cookie details and CSRF

The server sets:

```py
response.set_cookie(
    "spawn_session",
    token,
    max_age=60 * 60 * 24 * settings.jwt_refresh_ttl_days,
    httponly=True,
    samesite="lax",
    secure=settings.public_url.startswith("https://"),
)
```

`server/spawn_server/auth.py:114-123`. Starlette's default path is `/`; no Domain is supplied. The repository explicitly records that there is no separate CSRF token and warns to add CSRF before exposing cookies to untrusted web origins (`README.md:226-228`).

Native bearer calls are not ambient-cookie requests and therefore do not need browser CSRF tokens. They must not depend on a browser cookie jar. They should omit `credentials:"include"`, inject `Authorization`, and store secrets in OS secure storage. The web wrapper does the opposite—always `credentials:"include"` and never uses the returned access token (`web/src/lib/api.ts:5-16`, `web/src/lib/api.ts:30-66`, `web/src/lib/auth.ts:7-24`).

### Password account lifecycle

1. `GET /api/auth/config` tells the client whether invites and email verification are active and which OAuth providers are enabled (`server/spawn_server/routes/auth_config.py:15-27`).
2. Signup allows the first account even on a closed install, otherwise requires a live invite when invite-only is true. Password minimum is eight. The first account or configured admin email becomes admin. A verification message is attempted. Response contains the short access token and a long cookie (`server/spawn_server/routes/auth.py:32-96`, `server/spawn_server/invites.py:88-110`).
3. Login accepts an email/password and returns the same token/cookie pair (`server/spawn_server/routes/auth.py:99-125`). Login is allowed before email verification so the user can request a new verification message.
4. Verification request requires auth; confirmation consumes a newest-only token with two-day TTL and returns the user but does not sign them in (`server/spawn_server/routes/account_recovery.py:33-37`, `server/spawn_server/routes/account_recovery.py:179-206`).
5. Only device approval uses `verified_user`, and only when SMTP is genuinely deliverable; ordinary session/workspace calls use `current_user` (`server/spawn_server/auth.py:174-198`, `server/spawn_server/routes/device.py:670-675`).
6. Password reset request is enumeration-resistant 204. The one-hour confirmation token sets a minimum-12 password, marks email verified, increments epoch, and signs in with short token + long cookie (`server/spawn_server/routes/account_recovery.py:33-37`, `server/spawn_server/routes/account_recovery.py:119-176`).
7. Account deletion requires exact normalized email; password is optional only for a provider-backed account with an identity. It cascades account-owned data and clears the cookie (`server/spawn_server/routes/auth.py:142-211`).

### Critical native session gap

The server setting named `jwt_refresh_ttl_days` is misleading at the public API boundary: `issue_session_token` creates another `kind:"access"` JWT and sends it only as HttpOnly `Set-Cookie`; there is **no** `/refresh`, token exchange, or JSON refresh credential (`server/spawn_server/auth.py:69-88`, `server/spawn_server/routes/auth.py:88-95`). OAuth refresh-token tables briefly existed in migration 0008 and were explicitly dropped by migration 0010 (`server/alembic/versions/0008_oauth.py:54-76`, `server/alembic/versions/0010_drop_mcp.py:16-22`).

The returned bearer expires after 15 minutes. React Native cookie behavior/persistence is not the product's explicit auth contract, and an HttpOnly cookie cannot be copied into SecureStore by application code. Re-prompting for a password every 15 minutes is not acceptable feature parity.

**RECOMMEND:** add a small, additive native OAuth-style token flow before implementing mobile login:

```http
POST /api/auth/native/login       LoginRequest -> NativeTokenResponse
POST /api/auth/native/signup      SignupRequest -> NativeTokenResponse
POST /api/auth/native/refresh     {refresh_token:string} -> NativeTokenResponse
POST /api/auth/native/logout      {refresh_token:string} -> 204

type NativeTokenResponse = {
  access_token: string;       // existing 15-minute kind:access JWT
  refresh_token: string;      // opaque, random, rotating, stored hashed server-side
  expires_in: 900;
  refresh_expires_in: 2592000;
  user: UserOut;
};
```

Use a separate hashed refresh-token table with rotation/reuse revocation, owner ID, expiry, and `session_epoch`; leave all existing browser routes/cookies unchanged. This is slightly more work than returning the current 30-day JWT in JSON, but avoids turning a long-lived stateless bearer into an unrevocable access token. It is additive and does not fork browser behavior.

**UNKNOWN:** the product owner must decide whether mobile ships password-only until that endpoint exists or whether native auth is a backend prerequisite. The current server has no secure durable token path to copy.

### OAuth provider flow and native gap

Provider start stores only a state hash, provider, web-relative `return_to`, optional linking user, expiry, and used timestamp (`server/spawn_server/models.py:126-142`). Callback exchanges provider code, creates/links an identity, sets the cookie, and 302s to that relative path (`server/spawn_server/routes/auth_providers.py:371-442`). It returns no token JSON, no app code, and external/custom-scheme `return_to` is sanitized away (`server/spawn_server/routes/auth_providers.py:78-89`).

Linking is inferred solely from the optional current user on the initial `/start` request. Opening that URL in a native system auth browser does not inject the app's bearer header, so it reaches the server anonymously unless that browser happens to hold the server cookie; the current flow is therefore not a reliable native account-linking API (`server/spawn_server/routes/auth_providers.py:371-405`, `server/spawn_server/auth.py:199-223`).

Provider-created users take a separate path from password signup: `_user_for_profile` can insert a new `User` directly, without the signup route's `invite_only` check, invite consumption, first-user/bootstrap-admin handling, or assignment of `User.email_verified_at`. The provider's `email_verified` flag is stored on `AuthIdentity` only (`server/spawn_server/routes/auth_providers.py:314-368`, `server/spawn_server/routes/auth.py:44-73`, `server/spawn_server/models.py:108-124`). Thus an enabled OAuth provider currently bypasses closed-registration policy, while a newly created provider user can still fail `verified_user` gates such as device approval when SMTP verification is active.

**RECOMMEND:** before exposing provider login in native, decide whether provider signup must honor `invite_only`. The minimal consistent change is to reuse the signup admission/bootstrap policy for new provider users and copy a verified provider email to `User.email_verified_at`; existing account linking remains unchanged.

**RECOMMEND:** extend provider start with a registered native client ID, exact allowlisted app redirect URI, PKCE challenge, and one-time authorization-code handoff. Callback should redirect to the app with a short one-use code; the app exchanges it for the same `NativeTokenResponse`. Never put access/refresh JWTs directly in the redirect URL. Browser flow remains untouched.

### Passkeys are trust metadata, not login

There are no passkey/WebAuthn signup, challenge, assertion, or authentication endpoints. `/api/trust/passkeys` stores credential IDs used by browser-side PRF encryption only and deliberately performs no server assertion verification (`server/spawn_server/models.py:175-200`). Do not expose those endpoints as “Sign in with passkey” in mobile.

## WebSocket control plane

### Shared handshake, framing, and security

All four endpoints are JSON-text control/signaling sockets. Binary frames are forbidden on browser, host, and daemon signaling sockets; browser/daemon close with application code 4002 and host with 4002. Text signaling frames are capped at `MAX_RTC_ROUTING_FRAME_BYTES` (1,100 KiB); SDP is capped at 1 MiB, a signed envelope at 512 KiB, and an ICE candidate string at 64 KiB (`server/spawn_server/ws/browser.py:32-39`, `server/spawn_server/ws/browser.py:60-83`, `daemon/src/proto.rs:10-30`). Terminal bytes never belong on these sockets (`server/spawn_server/ws/browser.py:344-390`).

User socket authentication order is bearer header, `spawn_session` cookie, then query `token`. Invalid auth closes with 1008. The resolver verifies signature/expiry, `kind:"access"`, user subject, and user existence (`server/spawn_server/ws/browser.py:123-156`).

**Security defect:** unlike REST, the shared WS resolver does **not** compare JWT `epoch` with `User.session_epoch`. A password-reset-evicted JWT remains usable on `/ws/browser`, `/ws/host`, and `/ws/alerts` until its own `exp`. For an access token that is at most 15 minutes; a captured 30-day cookie JWT can remain valid on WS for up to 30 days. **RECOMMEND:** call the same epoch check used by `current_user` before returning the WS user. This is a minimal server-only fix (`server/spawn_server/auth.py:158-171`, `server/spawn_server/ws/browser.py:137-156`).

No endpoint checks `Origin`, `User-Agent`, or `Sec-Fetch-*`. CORS middleware does not authenticate or reject a native socket. Browser/daemon/alerts explicitly verify offered WS subprotocol and, if absent, accept once, send `protocol.required`, then close 4003 (`server/spawn_server/ws/browser.py:159-173`, `server/spawn_server/ws/alerts.py:228-238`, `server/spawn_server/ws/daemon.py:1255-1265`). `/ws/host` currently accepts `spawn.host.v1` unconditionally without checking what the client offered (`server/spawn_server/ws/host.py:381-388`).

Those three handshake-only server frames are literal:

```json
{"type":"protocol.required","protocol":"spawn.v3","version":3}
{"type":"protocol.required","protocol":"spawn.alerts.v1","version":1}
{"type":"protocol.required","protocol":"spawn.control.v3","version":3}
```

They indicate client misconfiguration, not a negotiation mechanism: reconnect offering the named subprotocol.

**RECOMMEND:** mobile should offer the exact subprotocol and authenticate with a bearer header if the target Expo/RN WebSocket implementation demonstrably preserves custom headers; otherwise use the server's existing `?token=` fallback. Query tokens can appear in reverse-proxy logs, so configure URL-query redaction and never log the constructed WS URL.

**UNKNOWN:** the exact `WebSocket(url, protocols, options.headers)` support in the selected Expo SDK must be verified on a physical iPhone. The cross-runtime source contract only guarantees `?token=`. This does not require a native module and therefore does not block Expo Go.

### Common RTC frame vocabulary

An RTC signaling `session_id` is a browser-generated string (1…128 characters), **not** the durable PTY session UUID. `scope_id` names the durable target. Session terminal signaling uses this exact tuple:

```json
{
  "session_id": "2c7e0ba0-rtc-attempt-1",
  "scope_type": "session",
  "scope_id": "53b0f1b8-4a21-4ce3-b2ba-ccfe27e66e75",
  "protocol": "spawn.pty",
  "protocol_version": 2
}
```

Host control signaling uses `scope_type:"host"`, durable host UUID, `protocol:"spawn.host.ctl"`, version 1 (`server/spawn_server/ws/browser.py:43-45`, `server/spawn_server/ws/browser.py:86-93`, `server/spawn_server/ws/host_signal.py:20-24`). The protocol document explains the two meanings of session ID (`proto/README.md:37-44`).

Offer/answer chooses exactly one signaling mode:

```json
{"type":"rtc.offer", "...tuple":"...", "sdp":"v=0\r\n..."}
```

or:

```json
{"type":"rtc.offer", "...tuple":"...", "signed_envelope":"{opaque canonical envelope JSON}"}
```

If `signed_envelope` is present, raw `sdp` is rejected. The server validates signed envelope metadata but treats its SDP content as opaque relay material (`server/spawn_server/ws/signed_signal_relay.py:1-208`). Candidate is an RTCIceCandidateInit-compatible object:

```json
{
  "type": "rtc.candidate",
  "session_id": "rtc-attempt-1",
  "scope_type": "session",
  "scope_id": "<pty-session-uuid>",
  "protocol": "spawn.pty",
  "protocol_version": 2,
  "binding_nonce": "0123456789abcdef0123456789abcdef",
  "candidate": {
    "candidate": "candidate:...",
    "sdpMid": "0",
    "sdpMLineIndex": 0,
    "usernameFragment": null
  }
}
```

### `/ws/browser` — PTY-session signaling

Connect:

```text
wss://<api>/ws/browser?session_id=<owned PTY session UUID>&token=<user access JWT>
Sec-WebSocket-Protocol: spawn.v3
```

The server authenticates, verifies session ownership, captures its host and current status, then sends config and status (`server/spawn_server/ws/browser.py:159-197`).

Server → mobile frames:

```json
{
  "type": "rtc.config",
  "enabled": true,
  "ice_servers": [
    {"urls":["stun:stun.l.google.com:19302"]},
    {"urls":["turn:turn.example:3478?transport=udp"],"username":"1787446400:<user-uuid>","credential":"<base64-hmac>"}
  ],
  "binding_nonce_required": true
}
```

```json
{"type":"session.status","status":"starting"}
{"type":"session.status","status":"running"}
{"type":"session.exit","exit_code":0,"signal":null}
```

```json
{
  "type":"rtc.answer",
  "session_id":"rtc-attempt-1",
  "binding_nonce":"0123456789abcdef0123456789abcdef",
  "binding_generation":42,
  "scope_type":"session",
  "scope_id":"<pty-session-uuid>",
  "protocol":"spawn.pty",
  "protocol_version":2,
  "sdp":"v=0\r\n..."
}
```

```json
{
  "type":"rtc.candidate",
  "session_id":"rtc-attempt-1",
  "binding_nonce":"0123456789abcdef0123456789abcdef",
  "binding_generation":42,
  "scope_type":"session",
  "scope_id":"<pty-session-uuid>",
  "protocol":"spawn.pty",
  "protocol_version":2,
  "candidate":{"candidate":"candidate:...","sdpMid":"0","sdpMLineIndex":0}
}
```

```json
{
  "type":"rtc.status",
  "session_id":"rtc-attempt-1",
  "binding_nonce":"0123456789abcdef0123456789abcdef",
  "binding_generation":42,
  "scope_type":"session",
  "scope_id":"<pty-session-uuid>",
  "protocol":"spawn.pty",
  "protocol_version":2,
  "status":"connected",
  "message":"optional daemon message"
}
```

Local/server statuses can be `disabled`, `unavailable`, `failed`, or `negotiating`; daemon-provided session statuses accept any string ≤64 characters. Some local status frames omit binding generation/nonce because no binding was established (`server/spawn_server/ws/browser.py:391-550`, `server/spawn_server/ws/daemon.py:1909-1947`).

Mobile → server frames:

```json
{
  "type":"rtc.offer",
  "session_id":"rtc-attempt-1",
  "binding_nonce":"0123456789abcdef0123456789abcdef",
  "scope_type":"session",
  "scope_id":"<pty-session-uuid>",
  "protocol":"spawn.pty",
  "protocol_version":2,
  "sdp":"v=0\r\n..."
}
```

```json
{
  "type":"rtc.candidate",
  "session_id":"rtc-attempt-1",
  "binding_nonce":"0123456789abcdef0123456789abcdef",
  "scope_type":"session",
  "scope_id":"<pty-session-uuid>",
  "protocol":"spawn.pty",
  "protocol_version":2,
  "candidate":{"candidate":"candidate:...","sdpMid":"0","sdpMLineIndex":0}
}
```

```json
{
  "type":"rtc.close",
  "session_id":"rtc-attempt-1",
  "binding_nonce":"0123456789abcdef0123456789abcdef",
  "scope_type":"session",
  "scope_id":"<pty-session-uuid>",
  "protocol":"spawn.pty",
  "protocol_version":2
}
```

The browser generates and supplies the exactly 32-lowercase-hex binding nonce for session signaling. The server rejects a duplicate active RTC ID and routes it only to the daemon generation owning the host (`server/spawn_server/ws/browser.py:391-526`). The negotiating binding TTL is 60 seconds, connected TTL 24 hours, and retired binding tombstone TTL five minutes (`server/spawn_server/ws/host_signal.py:20-26`).

There is no application ping on this socket, no client acknowledgement, no sequence number, and no resume cursor. REST session state plus new negotiation is the reconnect mechanism. Lifecycle pubsub is not replayed. The actual terminal replay/resume belongs to `spawn.ctl`, outside this server API.

### `/ws/host` — host-control signaling

Connect:

```text
wss://<api>/ws/host?host_id=<owned host UUID>&token=<user access JWT>
Sec-WebSocket-Protocol: spawn.host.v1
```

Initial server frame:

```json
{
  "type":"rtc.config",
  "enabled":true,
  "ice_servers":[{"urls":["stun:stun.l.google.com:19302"]}],
  "ice_transport_policy":"all",
  "scope_type":"host",
  "scope_id":"<host-uuid>",
  "protocol":"spawn.host.ctl",
  "protocol_version":1
}
```

If every configured ICE URL is `turn:`/`turns:`, `ice_transport_policy` is `relay`; otherwise it is `all` (`server/spawn_server/ws/host.py:70-78`, `server/spawn_server/ws/host.py:407-444`).

Mobile → server offer/candidate/close use the same JSON shapes as `/ws/browser` with the host tuple. The initial **mobile offer does not carry a binding nonce**; the server generates one and adds it when forwarding. Example:

```json
{
  "type":"rtc.offer",
  "session_id":"host-rtc-attempt-1",
  "scope_type":"host",
  "scope_id":"<host-uuid>",
  "protocol":"spawn.host.ctl",
  "protocol_version":1,
  "sdp":"v=0\r\n..."
}
```

Candidate/close sent later identify only `session_id` plus the host tuple; the handler looks up and forwards the server-held nonce (`server/spawn_server/ws/host.py:465-626`).

Server → mobile answer/candidate/status include `binding_nonce` and `binding_generation`, plus the host tuple. Host status is allowlisted to `connected | failed | unavailable` (`server/spawn_server/ws/host.py:281-342`, `server/spawn_server/ws/host_signal.py:20-24`). Maximum concurrent host RTC bindings are eight per browser and 64 per host/daemon; identity/tombstone bookkeeping is bounded at 256 (`server/spawn_server/ws/host_signal.py:25-28`, `server/spawn_server/ws/host.py:54-57`). TTL/reconnect semantics match the session socket. There is no heartbeat or replay.

### `/ws/alerts` — owner attention events

Connect once per app process/session:

```text
wss://<api>/ws/alerts?token=<user access JWT>
Sec-WebSocket-Protocol: spawn.alerts.v1
```

Server → mobile:

```json
{"type":"alerts.ping"}
```

every 25 seconds (`server/spawn_server/ws/alerts.py:35-45`, `server/spawn_server/ws/alerts.py:272-277`). Event frames are exactly:

```json
{
  "type":"alert",
  "event":"agent.finished",
  "session_id":"<pty-session-uuid>",
  "command":"claude",
  "at":"2026-08-22T03:12:01.123456+00:00"
}
```

```json
{
  "type":"alert",
  "event":"agent.awaiting_input",
  "session_id":"<pty-session-uuid>",
  "command":"codex",
  "at":"2026-08-22T03:12:09.123456+00:00"
}
```

```json
{
  "type":"alert",
  "event":"session.died",
  "session_id":"<pty-session-uuid>",
  "command":"codex",
  "exit_code":137,
  "signal":"KILL",
  "at":"2026-08-22T03:12:10.123456+00:00"
}
```

Payload constructors are at `server/spawn_server/ws/alerts.py:107-124` and `server/spawn_server/ws/alerts.py:193-208`. `command` is only a basename, maximum 64 chars. Mobile sends nothing; inbound text and binary are ignored (`server/spawn_server/ws/alerts.py:211-225`, `server/spawn_server/ws/alerts.py:288-298`). Alerts are ephemeral Redis pubsub. There is no history, delivery acknowledgement, sequence, or replay; after reconnect, missed alerts are irretrievable.

### `/ws/daemon` — daemon control and signaling

Mobile does not connect to this endpoint, but its complete catalogue explains REST side effects and RTC signaling.

```text
wss://<api>/ws/daemon?token=<daemon JWT>
Sec-WebSocket-Protocol: spawn.control.v3
```

Authorization header or query token is accepted; cookies are not. JWT must be `kind:"daemon"`, `sub:"host:<uuid>"`, and `user_id` must still own that host (`server/spawn_server/ws/daemon.py:89-124`). The first accepted application frame must be `register`; other frames are ignored until registration (`server/spawn_server/ws/daemon.py:1281-1325`).

Daemon → server frame catalogue, with literal shapes:

```json
{
  "type":"register",
  "host_name":"macbook",
  "os":"macos",
  "arch":"aarch64",
  "version":"0.1.0",
  "existing_sessions":["<pty-session-uuid>"],
  "spec":{
    "cpu_cores":10,
    "cpu_physical_cores":10,
    "cpu_model":"Apple M4",
    "memory_bytes":25769803776,
    "gpu":"Apple M4"
  }
}
{"type":"host.heartbeat","cpu_bucket":2,"mem_bucket":3}
{"type":"host.pong","request_id":"<uuid>"}
{"type":"session.started","session_id":"<uuid>","pid":4312}
{"type":"session.activity","session_id":"<uuid>"}
{"type":"session.input_activity","session_id":"<uuid>"}
{"type":"session.foreground","session_id":"<uuid>","command":"codex"}
{"type":"session.exit","session_id":"<uuid>","exit_code":0,"signal":null}
```

```json
{
  "type":"host.agents.check_result",
  "request_id":"<uuid>",
  "agents":[{
    "agent_id":"<uuid>","agent_name":"codex","agent_kind":"codex",
    "command":"codex","install":"curl ...","installed":true,
    "path":"/opt/homebrew/bin/codex","version":"1.2.3",
    "latest_version":"1.2.4","update_available":true,"error":null
  }]
}
```

```json
{
  "type":"host.agents.install_result",
  "request_id":"<uuid>",
  "result":{
    "agent_id":"<uuid>","agent_name":"codex","agent_kind":"codex",
    "command":"codex","install":"curl ...","success":true,
    "exit_code":0,"output":"installed","error":null,"status":null
  }
}
```

```json
{
  "type":"rtc.answer",
  "session_id":"rtc-attempt-1","binding_nonce":"<32-lower-hex>",
  "scope_type":"session","scope_id":"<uuid>","protocol":"spawn.pty",
  "protocol_version":2,"sdp":"v=0\r\n..."
}
```

`rtc.candidate` has the same metadata plus `candidate`; `rtc.status` has metadata plus `status` and optional `message`. `error` is:

```json
{
  "type":"error",
  "session_id":"<uuid-or-null>",
  "code":"literal_code",
  "message":"diagnostic",
  "request_id":"<optional>",
  "client_id":"<optional>"
}
```

The Rust serde contract is authoritative for these fields (`daemon/src/proto.rs:51-187`). The server truncates stored foreground to a 64-character basename and never stores path/arguments (`server/spawn_server/ws/daemon.py:1644-1657`). Heartbeat buckets are individually validated into 0…5 (`server/spawn_server/host_capacity.py:80-103`).

Server → daemon frames:

```json
{
  "type":"registered",
  "host_id":"<uuid>",
  "account_id":"<user-uuid>",
  "browser_device_ids":["<uuid>"],
  "browser_pins":[{
    "browser_device_id":"<uuid>",
    "browser_key_algorithm":"ed25519",
    "browser_public_key":"<43-char-base64url>",
    "browser_key_fingerprint":"SHA256:<16-char-base64url>",
    "endorser_public_key":null,
    "endorsement_signature":null
  }]
}
```

```json
{"type":"host.browser_pins","account_id":"<uuid>","browser_device_ids":[],"browser_pins":[]}
{"type":"host.heartbeat"}
{"type":"host.ping","request_id":"<uuid>"}
```

```json
{
  "type":"host.agents.check",
  "request_id":"<uuid>",
  "targets":[{
    "agent_id":"<uuid>","agent_name":"codex","agent_kind":"codex",
    "command":"codex","install":"curl ..."
  }]
}
```

```json
{
  "type":"host.agents.install",
  "request_id":"<uuid>",
  "target":{
    "agent_id":"<uuid>","agent_name":"codex","agent_kind":"codex",
    "command":"codex","install":"curl ..."
  }
}
```

```json
{
  "type":"session.create",
  "session_id":"<uuid>",
  "cwd":"/Users/me/project",
  "skills":[{"id":"<uuid>","name":"review","description":"...","content":"..."}],
  "create_cwd":true
}
```

`session.restart` has the identical body. Kill is:

```json
{"type":"session.kill","session_id":"<uuid>","signal":"TERM"}
```

Launch frame construction is at `server/spawn_server/routes/sessions.py:128-152`; kill is at `server/spawn_server/routes/sessions.py:379-422`. The daemon wire intentionally contains no argv, environment, or install command for a session (`daemon/src/proto.rs:336-355`).

`rtc.offer`, `rtc.candidate`, and `rtc.close` have the common metadata, server binding nonce/generation, and offer additionally carries current `ice_servers` and optional `ice_transport_policy` (`daemon/src/proto.rs:263-324`).

The daemon initiates `host.heartbeat`; the server replies with the same type. Presence expires after 90 seconds without refresh (`server/spawn_server/ws/host_signal.py:20-26`, `server/spawn_server/ws/daemon.py:1482-1495`). Reconnect begins with `register.existing_sessions`; valid durable session IDs are reattached to the new daemon generation (`server/spawn_server/ws/daemon.py:1326-1444`). A newer generation fences/supersedes the old socket. There is no general message sequence or missed-frame replay. `request_id` correlates only ping and agent check/install RPCs; `binding_generation` plus nonce fences RTC routing.

## Signaling and TURN surface

There is no HTTP signaling API and no standalone TURN credential endpoint. The flow is:

1. Mobile opens `/ws/browser` or `/ws/host` with user auth and correct subprotocol.
2. Server sends `rtc.config` containing all current ICE servers.
3. Mobile creates an RTC offer and sends `rtc.offer` over that socket.
4. Server binds it to the current daemon generation and forwards an offer containing binding nonce/generation and the same ICE configuration.
5. Daemon answer and both sides' candidates route back over server WS/Redis. Media/DataChannel traffic then goes peer-to-peer or through TURN ciphertext, never through FastAPI (`README.md:42-47`).

Static ICE is parsed from `SPAWN_WEBRTC_ICE_SERVERS`. Default is Google STUN only. If both `SPAWN_TURN_URLS` and `SPAWN_TURN_SECRET` are set, the server appends an ephemeral coturn REST credential (`server/spawn_server/config.py:90-107`, `server/spawn_server/config.py:114-142`).

TURN username/password are exact:

```py
expiry = int(time.time()) + ttl_seconds
username = f"{expiry}:{label}"
password = base64.b64encode(HMAC_SHA1(secret, username)).decode("ascii")
```

`server/spawn_server/turn.py:25-40`. `label` is the user UUID. Default TTL is 86,400 seconds. The browser and daemon receive identical time-limited credentials during negotiation. The config omits TURN if either URLs or secret is absent.

**RECOMMEND:** production mobile testing must use TURN, because the README explicitly calls it important for off-LAN/mobile/restrictive networks (`README.md:145-148`). No mobile-specific backend change is needed.

## Server-side domain model

The ORM contains 23 live entities. There are no SQL/Python enum columns; string vocabularies are enforced by code, Pydantic Literals, or checks. UUID primary keys are strings. The concise field inventory below includes persisted fields, nullability (`?`), and meaningful uniqueness/ownership (`server/spawn_server/models.py:36-815`).

### Identity, authentication, and trust entities

| Table/entity | Persisted fields |
|---|---|
| `users` / `User` | `id UUID PK`; `email varchar(255) unique`; `password_hash varchar(255)`; `created_at`; `session_epoch int=0`; `email_verified_at?`; `is_admin bool=false` |
| `auth_identities` / `AuthIdentity` | `id`; `user_id FK cascade`; `provider varchar(32)`; `provider_user_id varchar(255)`; `email`; `email_verified bool`; `created_at`; `last_login_at?`; unique `(provider,provider_user_id)` |
| `auth_provider_states` / `AuthProviderState` | `id`; `state_hash sha256 unique`; `provider`; `return_to`; `user_id? FK cascade`; `expires_at`; `used_at?`; `created_at` |
| `email_tokens` / `EmailToken` | `id`; `user_id FK cascade`; `purpose`; `token_hash sha256 unique`; `expires_at`; `used_at?`; `created_at` |
| `invites` / `Invite` | `id`; `code_hash sha256 unique`; `email?`; `created_by_user_id? FK set-null`; `expires_at`; `used_at?`; `used_by_user_id? FK set-null`; `revoked_at?`; `created_at` |
| `browser_devices` / `BrowserDevice` | `id`; `owner_user_id FK cascade`; `key_algorithm`; `public_key`; `label?`; `created_at`; `revoked_at?`; globally unique `(key_algorithm,public_key)` |
| `trust_bundles` / `TrustBundle` | `owner_user_id PK/FK cascade`; `sealed text`; `revision int>=1`; `updated_at` |
| `passkey_credentials` / `PasskeyCredential` | `id`; `owner_user_id FK cascade`; `credential_id<=512`; `label?`; `created_at`; unique `(owner,credential_id)` |

The first three model shapes are at `server/spawn_server/models.py:36-142`; trust/passkey shapes at `server/spawn_server/models.py:145-200`; emailed secrets and invites at `server/spawn_server/models.py:702-751`. Only hashes of email/invite bearer secrets are stored (`server/alembic/versions/0026_email_tokens_and_session_epoch.py:17-49`, `server/alembic/versions/0027_admin_and_invites.py:17-50`).

### Hosts, pairing, and daemon fencing

| Table/entity | Persisted fields |
|---|---|
| `host_key_claims` / `HostKeyClaim` | composite PK `(host_key_algorithm,host_public_key)`; `owner_user_id FK RESTRICT`; `created_at`; retained even after Host deletion |
| `hosts` / `Host` | `id`; `owner_user_id FK cascade`; `name`; `os?`; `arch?`; `version?`; immutable `host_key_algorithm?`; `host_public_key?` unique pair; `status`; `daemon_connection_id?`; `daemon_generation`; `daemon_generation_counter`; `daemon_pending_connection_id?`; `daemon_pending_generation?`; `last_seen_at?`; `cpu_cores?`; `cpu_physical_cores?`; `cpu_model?`; `memory_bytes?`; `gpu?`; `cpu_bucket? 0..5`; `mem_bucket? 0..5`; `capacity_at?`; `created_at` |
| `host_browser_pins` / `HostBrowserPin` | composite PK `(host_id,browser_device_id)`, both cascade; immutable browser algorithm/key/fingerprint; `endorser_device_id?`; `endorsement_signature?`; `created_at` |
| `device_codes` / `DeviceCode` | `device_code PK`; `user_code unique`; `host_name?`; `os?`; `arch?`; `version?`; `host_key_algorithm?`; `host_public_key?`; `approval_nonce?`; `host_possession_version?`; `host_possession_verified_at?`; `browser_device_id? FK cascade`; `browser_key_algorithm?`; `browser_public_key?`; `browser_key_fingerprint?`; `browser_approval_signature?`; `status`; `user_id? FK set-null`; `expires_at`; `created_at`; `last_polled_at?` |

Host fields and fencing checks are at `server/spawn_server/models.py:230-323`; pin fields at `server/spawn_server/models.py:326-358`; the ceremony row is `server/spawn_server/models.py:515-591`. Durable host-key ownership was introduced specifically to prevent deleted stable keys being captured by another account (`server/alembic/versions/0020_host_key_claims.py:17-51`).

### Sessions, capabilities, agents, and workspaces

| Table/entity | Persisted fields |
|---|---|
| `sessions` / `Session` | `id`; owner FK cascade; host FK cascade; `cwd<=1024`; `name?<=128`; `status`; `started_at`; `exited_at?`; `last_output_at?`; `last_input_at?`; `exit_code?`; `foreground_command?` |
| `skills` / `Skill` | `id`; owner FK cascade; `name<=128`; `description<=512`; `content<=65535`; `enabled_by_default`; `created_at`; unique `(owner,name)` |
| `session_skill_grants` / `SessionSkillGrant` | `id`; owner/session/skill FKs cascade; `created_at`; unique `(session_id,skill_id)` |
| `agents` / `Agent` | `id`; `owner_user_id?` (null=built-in); `name`; `kind`; `command`; `env JSON`; `install?`; `yolo_args?`; `yolo_env JSON`; unique `(owner,name)` |
| `agent_preferences` / `AgentPreference` | `id`; owner and agent FKs cascade; `yolo bool`; unique `(owner,agent)` |
| `host_agent_policies` / `HostAgentPolicy` | `id`; owner/host/agent FKs cascade; `auto_update`; `last_checked_at?`; `last_auto_update_at?`; `last_auto_update_error?`; unique `(owner,host,agent)` |
| `workspaces` / `Workspace` | `id`; owner FK cascade; `name`; home `host_id?` FK set-null; `cwd?`; `layout JSON`; `position`; `icon?`; `icon_source?`; `archived_at?`; `created_at`; `updated_at` |
| `workspace_templates` / `WorkspaceTemplate` | `id`; owner FK cascade; `name`; `host_id?` set-null; `cwd?`; `spec JSON`; `icon?`; `icon_source?`; `created_at`; `updated_at` |
| `recent_dirs` / `RecentDir` | `id`; owner/host FKs cascade; `path`; `last_used_at`; unique `(owner,host,path)` |

Session/skill/grant models are `server/spawn_server/models.py:444-512`; agents and policies are `server/spawn_server/models.py:361-441`; workspace/template/recent directory fields are `server/spawn_server/models.py:594-699`. `Session` means one PTY/login shell; `Agent` means a reusable CLI shortcut, not a running process (`docs/INTERFACE_MATRIX.md:8-14`).

### Analytics and mail audit

| Table/entity | Persisted fields |
|---|---|
| `legion_days` / `LegionDay` | composite PK `(owner_user_id,day YYYY-MM-DD)`; `sessions_started`; `session_seconds`; `peak_sessions`; `peak_hosts_online`; bounded agent-basename tally as JSON text; `updated_at` |
| `email_log` / `EmailLog` | `id`; `to_email`; `subject`; `kind`; `status`; `error?`; `body_redacted`; `created_at` |

These are at `server/spawn_server/models.py:754-815`. Legion stores daily counters rather than session IDs or terminal content (`server/alembic/versions/0042_legion_capacity.py:20-30`, `server/alembic/versions/0042_legion_capacity.py:68-89`). Email bodies have bearer query credentials redacted before persistence (`server/spawn_server/mail.py:25-41`, `server/spawn_server/mail.py:44-69`).

### Literal state/value catalogue

| Domain | Literal values |
|---|---|
| User role | no role enum; `is_admin: false | true` only |
| User JWT kind | `access` |
| Daemon JWT kind | `daemon` |
| OAuth provider | `google | microsoft | github` |
| Host status | `online | offline` |
| Session status | `starting | running | exited | killed` |
| Derived activity state | `running | awaiting_input | input_sent | active | idle | unknown` (client must tolerate future strings because schema says `str`) |
| DeviceCode persisted status | `pending | approved | consuming | expired | denied | pin_conflict | pin_limit` |
| Device poll error | `authorization_pending | slow_down | expired_token | denied | invalid_device_binding | key_conflict | pin_conflict | pin_limit` |
| Key algorithm | `ed25519` |
| Workspace icon source | `auto | custom | none | null` |
| Template run kind | `shell | agent | files` |
| Tile widget kind | `files` |
| Invite state | `pending | used | expired | revoked` |
| Email token purpose | `password_reset | email_verify` |
| Mail delivery status | `sent | failed | not_delivered` |
| Known mail kind | `password_reset | email_verify | invite | test` (column accepts other strings) |
| Alert event | `agent.finished | agent.awaiting_input | session.died` |
| Host RTC status | `connected | failed | unavailable` |
| Common session RTC status | `negotiating | connected | failed | unavailable | disabled` (daemon field remains forward-compatible string) |

JWT values are defined at `server/spawn_server/auth.py:22-24`; status writes at `server/spawn_server/routes/device.py:121-133`, `server/spawn_server/routes/device.py:257-277`, `server/spawn_server/ws/daemon.py:1497-1547`, and `server/spawn_server/ws/daemon.py:1724-1769`. Invite states are computed at `server/spawn_server/invites.py:54-67`; mail status values are written at `server/spawn_server/mail.py:101-182`. Agent `kind` is deliberately **not** an enum.

## Environment, origins, and native-client gates

### Base URLs and ports

- Manual API development URL is `http://localhost:8000`; the integrated dev runner uses a private API on 8010 behind the web origin on 3000 (`README.md:68-74`, `README.md:97-112`).
- `SPAWN_PUBLIC_URL` defaults to `http://localhost:8000`; it generates device verification URI, OAuth callbacks, and install script server URL. `SPAWN_WEB_URL` defaults empty and falls back to public URL for email/invite links (`server/spawn_server/config.py:40-45`, `server/spawn_server/routes/account_recovery.py:44-46`).
- The mobile app must have an explicit environment base URL, for example `EXPO_PUBLIC_SPAWN_API_URL=https://spawn.example.com`, and turn `http(s)` into `ws(s)` for sockets. It must never use the phone's `localhost` for a desktop server.
- Production should expose one HTTPS/WSS origin. The browser setup uses the same external public/web URL and proxy; mobile may call the API origin directly (`README.md:89-105`).

### Complete `SPAWN_` settings relevant to the client/control plane

| Environment variable | Default | Effect |
|---|---|---|
| `SPAWN_DATABASE_URL` | `sqlite+aiosqlite:///./spawn.db` | async DB URL |
| `SPAWN_REDIS_URL` | `redis://localhost:6379/0` | pubsub, presence, shared rate limits |
| `SPAWN_JWT_SECRET` | `change-me-in-prod` | JWT signing secret |
| `SPAWN_JWT_ALGORITHM` | `HS256` | JWT algorithm |
| `SPAWN_JWT_ACCESS_TTL_MINUTES` | `15` | JSON access bearer life |
| `SPAWN_JWT_REFRESH_TTL_DAYS` | `30` | cookie JWT/max-age; not an API refresh token |
| `SPAWN_JWT_DAEMON_TTL_DAYS` | `365` | paired daemon token life |
| `SPAWN_OAUTH_PROVIDER_STATE_TTL_MINUTES` | `10` | provider state life |
| `SPAWN_<PROVIDER>_CLIENT_ID/SECRET` | unset | enables provider only as a pair |
| `SPAWN_PUBLIC_URL` | `http://localhost:8000` | public callback/verification/install base |
| `SPAWN_WEB_URL` | empty | email/invite web base; falls back to public URL |
| `SPAWN_EMAIL_BACKEND` | `console` | `smtp | console | disabled` convention |
| `SPAWN_EMAIL_FROM` | `spawn <no-reply@localhost>` | From header |
| `SPAWN_EMAIL_REPLY_TO` | empty | optional Reply-To |
| `SPAWN_SMTP_HOST/PORT` | empty / `587` | SMTP target |
| `SPAWN_SMTP_USERNAME/PASSWORD` | empty | SMTP credentials |
| `SPAWN_SMTP_USE_STARTTLS` | `true` | STARTTLS |
| `SPAWN_SMTP_USE_SSL` | `false` | implicit TLS |
| `SPAWN_ADMIN_EMAILS` | empty | comma list promoted on sign-in; DB remains source of truth |
| `SPAWN_INVITE_ONLY` | `true` | closed signup except first account |
| `SPAWN_INVITE_DEFAULT_TTL_HOURS` | `72` | default invite TTL |
| `SPAWN_REQUIRE_EMAIL_VERIFICATION` | `true` | pairing gate, inert without ready SMTP |
| `SPAWN_RATE_LIMIT_ENABLED` | `true` | fixed-window limiter switch |
| `SPAWN_CORS_ORIGINS` | `http://localhost:3000` | comma-separated browser origins |
| `SPAWN_USE_INPROCESS_PUBSUB` | `false` | test/single-process Redis substitute |
| `SPAWN_WEBRTC_ENABLED` | `true` | signaling enable switch |
| `SPAWN_WEBRTC_ICE_SERVERS` | Google STUN JSON | static RTCIceServer array |
| `SPAWN_TURN_URLS` | empty | comma-separated TURN URIs |
| `SPAWN_TURN_SECRET` | unset | coturn auth secret |
| `SPAWN_TURN_TTL_SECONDS` | `86400` | credential lifetime |

Defaults and parsing are at `server/spawn_server/config.py:13-142`.

### CORS, cookies, and native acceptance

FastAPI installs `CORSMiddleware` with the configured origin list, credentials true, all methods, and all headers (`server/spawn_server/main.py:71-78`). This is a browser response-header/preflight policy, not native fetch authorization. A native app does not need to add its custom URL scheme to CORS and is not rejected for omitting `Origin`. If an embedded WebView is later used, that WebView's actual origin must be allowlisted.

The server has no `User-Agent`, `Origin`, `Referer`, `Sec-Fetch-Site`, device attestation, API key, or browser-only middleware checks. A physical Expo Go client using bearer auth is accepted by all User routes. `SameSite=Lax`, Secure, and HttpOnly affect cookies, not bearer requests (`server/spawn_server/auth.py:114-123`).

Current native blockers and minimal additive changes:

| Current behavior | Native consequence | Minimal backend change |
|---|---|---|
| Access bearer is 15 minutes; durable JWT only cookie; no refresh | session expires with no silent renewal | add rotating native refresh flow described above |
| Provider callback only web-relative redirect/cookie | OAuth cannot hand auth back to app | add allowlisted native PKCE code redirect/exchange |
| Provider-created users bypass invite/first-admin/verified-email handling | native provider signup can violate closed-registration policy or create an ownerless install | reuse the password-signup admission/bootstrap policy and propagate verified provider email |
| Verification/reset links always `${WEB_URL}/verify-email` or `/reset-password` | email opens web, not app | keep web links working and add Universal Link/App Link handling to mobile; no API change if the app can claim the HTTPS route, otherwise add an explicit allowlisted mobile link base |
| User WS ignores `session_epoch` | reset does not immediately evict sockets | reuse REST epoch check in `_resolve_user` |
| WS query token accepted | works in Expo Go but may leak in access logs | prefer verified header support; redact `token` in proxy logs; optionally add a one-use short WS ticket endpoint later |
| Trust bundle relies on browser WebAuthn PRF | Expo Go parity uncertain | no server-side cryptographic substitute; physical-device capability spike, fallback to local pins/endorsements |

Email link construction is literal at `server/spawn_server/routes/account_recovery.py:99-104` and `server/spawn_server/routes/account_recovery.py:124-149`. No native request is otherwise rejected by current server code.

## Pagination, filtering, sorting, and streaming conventions

There is no shared pagination envelope, cursor, offset, `page`, `limit`, `sort`, search, ETag, or conditional-request convention.

| Collection | Filter | Order/cap |
|---|---|---|
| Hosts | none | DB/result order; do not assume stable sort |
| Sessions | optional `host_id` | `started_at DESC` |
| Workspaces | `archived=false` | active `position ASC`; archived `archived_at DESC` |
| Templates | none | `name ASC` |
| Browser devices | none | `created_at DESC`, includes revoked |
| Recent dirs | host path | `last_used_at DESC`, max 8 |
| Agents | none | built-ins + owned; source query/name behavior should not be treated as API sorting guarantee |
| Skills | none | `name ASC` |
| Trust passkeys | none | `created_at ASC` |
| Endorsements | required `endorsed_device_id` | host-created ordering from route |
| Admin users | none | `created_at ASC` |
| Admin invites | none | `created_at DESC` |
| Admin emails | `limit`, default 100, clamp 1…500 | `created_at DESC` |
| Profile days | built-in 120-day window | sparse ascending UTC day |

Session and workspace filters/order are implemented at `server/spawn_server/routes/sessions.py:217-233` and `server/spawn_server/routes/workspaces.py:306-317`; skill ordering is `server/spawn_server/routes/capabilities.py:122-130`; admin ordering/cap is `server/spawn_server/routes/admin.py:59-191`; profile window/order is `server/spawn_server/routes/profile.py:31-89`.

There is no HTTP long-poll, Server-Sent Events, NDJSON, multipart stream, or chunked JSON API. Device poll is repeated ordinary POST at the advertised interval; too-fast polls return HTTP-200 `slow_down` (`server/spawn_server/routes/device.py:235-398`). Realtime state is ephemeral WebSocket/pubsub. File and terminal streams are WebRTC DataChannels and are not part of the HTTP client.

**RECOMMEND:** the native data layer should refetch finite collections on app foreground, reconnect, and relevant mutations; do not invent cursor machinery. For session/host liveness, merge WS events into cached REST entities, then refetch after any socket gap because no sequence/replay can prove continuity.

## Native API client shape

### Dependency and storage decision

**RECOMMEND:** use `expo-secure-store ~57.0.1` for access tokens now and the future refresh token. It is the current verified registry/recommended Expo version as of 2026-08-22, uses iOS Keychain/Android Keystore-backed storage, and is [included in Expo Go](https://docs.expo.dev/versions/latest/sdk/securestore/). It beats AsyncStorage because bearer credentials must not be stored as ordinary app data. Use `requireAuthentication:false` in Expo Go: Expo documents that Face ID-gated SecureStore values are unavailable there because Expo Go lacks the app-specific usage description. The package's normal async read/write/delete path works in Expo Go.

No HTTP library is needed. React Native exposes global [`fetch`](https://reactnative.dev/docs/global-fetch), [`AbortController`](https://reactnative.dev/docs/global-AbortController), and [`WebSocket`](https://reactnative.dev/docs/global-WebSocket); these are sufficient. Avoid Axios here: it adds an adapter/interceptor layer without solving the missing server refresh endpoint.

### Canonical TypeScript contracts

These definitions preserve server wire names and response nullability. Constraints in comments come directly from Pydantic (`server/spawn_server/schemas.py:31-419`, `server/spawn_server/schemas.py:420-730`, `server/spawn_server/schemas.py:731-1080`). They should live in `mobile/src/api/server.ts` or be generated into an adjacent `types.ts` without renaming fields.

```ts
import * as SecureStore from "expo-secure-store";

export type UUID = string;
export type IsoDateTime = string;
export type IsoDate = string; // YYYY-MM-DD
export type Ed25519Algorithm = "ed25519";
export type ProviderId = "google" | "microsoft" | "github";

export type HealthzResponse = { status: "ok" };

export type UserOut = {
  id: UUID;
  email: string;
  created_at: IsoDateTime;
  email_verified_at: IsoDateTime | null;
  is_admin: boolean;
};

export type SignupRequest = {
  email: string;
  password: string; // 8..256
  invite?: string | null; // <=256
};

export type LoginRequest = { email: string; password: string };
export type TokenResponse = { access_token: string; user: UserOut };
export type MeResponse = { user: UserOut };
export type PasswordResetRequest = { email: string };
export type PasswordResetConfirm = {
  token: string; // 16..256
  new_password: string; // 12..256
};
export type EmailVerifyConfirm = { token: string }; // 16..256
export type AccountDeleteRequest = {
  confirm_email: string;
  password?: string | null;
};

export type AuthProviderOut = { id: ProviderId; name: string };
export type AuthConfigOut = {
  providers: AuthProviderOut[];
  email_verification_required: boolean;
  invite_only: boolean;
};

export type BrowserDeviceRegisterRequest = {
  label?: string | null; // <=64, recognition only
  key_algorithm: Ed25519Algorithm;
  public_key: string; // canonical 43-char unpadded base64url
  signature: string; // 86-char unpadded base64url
};
export type BrowserDeviceRevokeRequest = {
  expected_public_key: string; // 43 chars
};
export type BrowserDeviceRenameRequest = { label?: string | null };
export type BrowserDeviceOut = {
  id: UUID;
  key_algorithm: Ed25519Algorithm;
  public_key: string;
  fingerprint: string;
  label: string | null;
  created_at: IsoDateTime;
  revoked_at: IsoDateTime | null;
};
export type BrowserDevicePruneResponse = { pruned: number };

export type AdminUserOut = {
  id: UUID;
  email: string;
  created_at: IsoDateTime;
  email_verified_at: IsoDateTime | null;
  is_admin: boolean;
  host_count: number;
  session_count: number;
  browser_device_count: number;
};
export type AdminInviteCreate = {
  email?: string | null;
  ttl_hours?: number | null; // 1..720
};
export type InviteState = "pending" | "used" | "expired" | "revoked";
export type AdminInviteOut = {
  id: UUID;
  email: string | null;
  state: InviteState;
  expires_at: IsoDateTime;
  created_at: IsoDateTime;
  used_at: IsoDateTime | null;
  created_by_user_id: UUID | null;
  used_by_user_id: UUID | null;
  url: string | null; // non-null only on create response
};
export type AdminMailStatus = {
  backend: string;
  delivering: boolean;
  from_address: string;
  smtp_host: string | null;
};
export type AdminEmailStatus = "sent" | "failed" | "not_delivered";
export type AdminEmailOut = {
  id: UUID;
  to_email: string;
  subject: string;
  kind: string;
  status: AdminEmailStatus;
  error: string | null;
  body_redacted: string;
  created_at: IsoDateTime;
};
export type AdminTestEmail = { to?: string | null };

export type DeviceStartRequest = {
  host_name: string; // <=128
  os?: string | null;
  arch?: string | null;
  version?: string | null;
  host_key_algorithm: Ed25519Algorithm;
  host_public_key: string; // 43 chars
};
export type DeviceStartResponse = {
  device_code: string;
  user_code: string;
  approval_nonce: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
};
export type DevicePossessionRequest = {
  device_code: string; // 43 chars
  approval_nonce: string; // 43 chars
  host_key_algorithm: Ed25519Algorithm;
  host_public_key: string; // 43 chars
  signature: string; // 86 chars
};
export type DevicePossessionResponse = { verified: true; version: 1 };
export type DevicePollRequest = {
  device_code: string;
  host_key_algorithm: Ed25519Algorithm;
  host_public_key: string;
};
export type DevicePollSuccess = {
  access_token: string; // daemon token, not user token
  host_id: UUID;
  host_key_algorithm: Ed25519Algorithm;
  host_public_key: string;
  host_key_fingerprint: string;
  browser_device_id: UUID;
  browser_key_algorithm: Ed25519Algorithm;
  browser_public_key: string;
  browser_key_fingerprint: string;
  account_id: UUID | null;
  browser_approval_signature: string | null;
};
export type DevicePollError =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "denied"
  | "invalid_device_binding"
  | "key_conflict"
  | "pin_conflict"
  | "pin_limit";
export type DevicePollPending = { error: DevicePollError };
export type DevicePollResponse = DevicePollSuccess | DevicePollPending;
export type DevicePendingRequest = { user_code: string };
export type DevicePendingResponse = {
  host_name: string;
  approval_nonce: string;
  host_key_algorithm: Ed25519Algorithm;
  host_public_key: string;
  host_key_fingerprint: string;
};
export type DeviceApproveRequest = DevicePendingRequest & {
  approval_nonce: string; // 43 chars
  host_key_algorithm: Ed25519Algorithm;
  host_public_key: string; // 43 chars
  host_key_fingerprint: string; // 23 chars
  browser_device_id: UUID; // canonical lowercase UUID
  browser_key_algorithm: Ed25519Algorithm;
  browser_public_key: string; // 43 chars
  browser_key_fingerprint: string; // 23 chars
  signature: string; // 86 chars
};
export type DeviceApproveResponse = DevicePendingResponse & {
  browser_device_id: UUID;
  browser_key_algorithm: Ed25519Algorithm;
  browser_public_key: string;
  browser_key_fingerprint: string;
  host_id: UUID | null;
};

export type KnownHostStatus = "online" | "offline";
export type HostOut = {
  id: UUID;
  name: string;
  os: string | null;
  arch: string | null;
  version: string | null;
  host_key_algorithm: Ed25519Algorithm | null;
  host_public_key: string | null;
  host_key_fingerprint: string | null;
  status: string; // Pydantic declares str; current emitted values are KnownHostStatus
  last_seen_at: IsoDateTime | null;
  session_count: number;
  cpu_cores: number | null;
  cpu_physical_cores: number | null;
  cpu_model: string | null;
  memory_bytes: number | null;
  gpu: string | null;
  cpu_bucket: number | null; // 0..5, null offline/unreported
  mem_bucket: number | null; // 0..5
  capacity_at: IsoDateTime | null;
};
export type HostPatch = { name?: string | null }; // <=128
export type HostAgentTarget = {
  agent_id: UUID;
  agent_name: string;
  agent_kind: string;
  command: string;
  install: string | null;
};
export type HostAgentStatus = HostAgentTarget & {
  installed: boolean;
  path: string | null;
  version: string | null;
  latest_version: string | null;
  update_available: boolean | null;
  error: string | null;
  auto_update: boolean;
  last_checked_at: IsoDateTime | null;
  last_auto_update_at: IsoDateTime | null;
  last_auto_update_error: string | null;
};
export type HostAgentList = { agents: HostAgentStatus[] };
export type HostAgentInstallResult = HostAgentTarget & {
  success: boolean;
  exit_code: number | null;
  output: string;
  error: string | null;
  status: HostAgentStatus | null;
};
export type HostAgentPolicyPatch = { auto_update?: boolean | null };
export type HostAgentPolicyOut = {
  agent_id: UUID;
  auto_update: boolean;
  last_checked_at: IsoDateTime | null;
  last_auto_update_at: IsoDateTime | null;
  last_auto_update_error: string | null;
};
export type RecentDirOut = { path: string; last_used_at: IsoDateTime };
export type RecentDirList = { dirs: RecentDirOut[] };

export type LegionDayOut = {
  day: IsoDate;
  sessions_started: number;
  session_seconds: number;
  peak_sessions: number;
  peak_hosts_online: number;
};
export type LegionAgentOut = { command: string; count: number };
export type LegionTotalsOut = {
  hosts: number;
  hosts_online: number;
  cores: number;
  memory_bytes: number;
  sessions_live: number;
  sessions_started: number;
  session_seconds: number;
  active_days: number;
  current_streak: number;
  longest_streak: number;
  peak_hosts_online: number;
  peak_sessions: number;
  first_day: IsoDate | null;
};
export type LegionHostOut = {
  id: UUID;
  name: string;
  os: string | null;
  status: string;
  cpu_cores: number | null;
  memory_bytes: number | null;
  gpu: string | null;
  session_count: number;
  created_at: IsoDateTime | null;
  last_seen_at: IsoDateTime | null;
};
export type ProfileOut = {
  id: UUID;
  email: string;
  created_at: IsoDateTime;
  email_verified_at: IsoDateTime | null;
  is_admin: boolean;
  totals: LegionTotalsOut;
  agents: LegionAgentOut[];
  days: LegionDayOut[];
  hosts: LegionHostOut[];
  history_days: number;
  today: IsoDate;
};

export type AgentCreate = {
  name: string; // <=128, nonblank after trim
  kind: string; // <=64, nonblank
  command: string; // <=1024, nonblank
  env?: Record<string, string>;
  install?: string | null; // <=2048
  yolo_args?: string | null; // <=256
  yolo_env?: Record<string, string>;
};
export type AgentPatch = {
  name?: string | null;
  kind?: string | null;
  command?: string | null;
  env?: Record<string, string> | null;
  install?: string | null;
  yolo_args?: string | null;
  yolo_env?: Record<string, string> | null;
};
export type AgentPreferencePatch = { yolo?: boolean | null };
export type AgentOut = {
  id: UUID;
  owner_user_id: UUID | null; // null is immutable built-in
  name: string;
  kind: string;
  command: string;
  env: Record<string, string>;
  install: string | null;
  yolo_args: string | null;
  yolo_env: Record<string, string>;
  yolo: boolean;
};

export type SkillCreate = {
  name: string; // <=128
  description?: string; // <=512, default ""
  content: string; // <=65535
  enabled_by_default?: boolean;
};
export type SkillPatch = {
  name?: string | null;
  description?: string | null;
  content?: string | null;
  enabled_by_default?: boolean | null;
};
export type SkillOut = {
  id: UUID;
  owner_user_id: UUID;
  name: string;
  description: string;
  content: string;
  enabled_by_default: boolean;
  created_at: IsoDateTime;
};
export type SessionAccessPatch = { skill_ids?: UUID[] | null };
export type SessionAccessOut = { session_id: UUID; skills: SkillOut[] };
export type SkillLaunchConfig = {
  id: UUID;
  name: string;
  description: string;
  content: string;
};

export type TilePlacement = { x: number; y: number; w: number; h: number };
export type SessionCreate = {
  host_id: UUID;
  cwd: string;
  name?: string | null; // <=128
  skill_ids?: UUID[] | null; // omitted/null -> enabled-by-default skills
  workspace_id?: UUID | null;
  tile?: TilePlacement | null; // requires workspace_id
};
export type SessionPatch = { name?: string | null };
export type KnownSessionStatus = "starting" | "running" | "exited" | "killed";
export type SessionOut = {
  id: UUID;
  name: string | null;
  host_id: UUID;
  host_name: string | null;
  cwd: string;
  status: string; // Pydantic declares str; current emitted values are KnownSessionStatus
  started_at: IsoDateTime;
  exited_at: IsoDateTime | null;
  exit_code: number | null;
  last_output_at: IsoDateTime | null;
  last_input_at: IsoDateTime | null;
  last_activity_at: IsoDateTime | null;
  activity_state: string;
  activity_label: string;
  foreground_command: string | null;
};

export type WorkspaceIconSource = "auto" | "custom" | "none";
export type WorkspaceIconFields = {
  icon: string | null;
  icon_source: WorkspaceIconSource | null;
};
export type WorkspaceIconPatch = {
  icon?: string | null;
  icon_source?: WorkspaceIconSource | null;
};
export type TileWidget = { kind: "files"; host_id: UUID; path: string };
export type WorkspaceTile = {
  session_id: string; // session UUID, or widget tile's own ID
  x: number;
  y: number;
  w: number;
  h: number;
  widget?: TileWidget | null; // requests accept null; responses omit it when null
};
export type WorkspaceLayout = { version: 3; tiles: WorkspaceTile[] };
export type WorkspaceTab = {
  id: string; // 1..64
  name: string; // 1..64
  layout: WorkspaceLayout;
  host_id: UUID | null;
  cwd: string | null;
};
export type WorkspaceLayoutV3 = {
  version: 3;
  active_tab: string | null;
  tabs: WorkspaceTab[]; // 1..8
};
export type WorkspaceFirstSession = {
  host_id: UUID;
  cwd: string;
  skill_ids?: UUID[] | null;
};
export type WorkspaceCreate = WorkspaceIconPatch & {
  name?: string | null;
  first_session?: WorkspaceFirstSession | null;
  host_id?: UUID | null;
  cwd?: string | null;
};
export type WorkspacePatch = WorkspaceIconPatch & {
  name?: string | null;
  layout?: WorkspaceLayoutV3 | null;
  position?: number | null;
  host_id?: UUID | null;
  cwd?: string | null;
};
export type WorkspaceOut = WorkspaceIconFields & {
  id: UUID;
  name: string;
  host_id: UUID | null;
  cwd: string | null;
  layout: WorkspaceLayoutV3;
  position: number;
  archived_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
};
export type WorkspaceCreateResponse = {
  workspace: WorkspaceOut;
  session: SessionOut | null;
};

export type TemplateRun = {
  kind: "shell" | "agent" | "files";
  command?: string | null; // required/nonblank only for agent
};
export type TemplateTile = TilePlacement & { run: TemplateRun };
export type TemplateTab = { name: string; tiles?: TemplateTile[] };
export type WorkspaceTemplateSpec = { version: 2; tabs: TemplateTab[] };
export type WorkspaceTemplateCreate = WorkspaceIconPatch & {
  name: string;
  host_id?: UUID | null;
  cwd?: string | null;
  spec: WorkspaceTemplateSpec;
};
export type WorkspaceTemplatePatch = WorkspaceIconPatch & {
  name?: string | null;
  host_id?: UUID | null;
  cwd?: string | null;
  spec?: WorkspaceTemplateSpec | null;
};
export type WorkspaceTemplateOut = WorkspaceIconFields & {
  id: UUID;
  name: string;
  host_id: UUID | null;
  cwd: string | null;
  spec: WorkspaceTemplateSpec;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
};

export type TrustBundleOut = {
  sealed: string;
  revision: number;
  updated_at: IsoDateTime;
};
export type TrustBundlePut = {
  sealed: string;
  expected_revision?: number | null;
};
export type PasskeyCredentialOut = {
  id: UUID;
  credential_id: string;
  label: string | null;
  created_at: IsoDateTime;
};
export type PasskeyCredentialCreate = {
  credential_id: string; // 1..512
  label?: string | null; // <=128
};
export type BrowserEndorsementCreate = {
  host_id: UUID;
  endorser_device_id: UUID;
  endorsed_device_id: UUID;
  signature: string; // 86 chars
};
export type BrowserEndorsementOut = {
  host_id: UUID;
  endorsed_device_id: UUID;
  endorsed_key_fingerprint: string;
  endorser_device_id: UUID;
  created_at: IsoDateTime;
};
export type BrowserEndorsementRecord = {
  host_id: UUID;
  host_name: string;
  host_public_key: string;
  endorser_device_id: UUID;
  endorser_public_key: string;
  endorser_label: string | null;
  signature: string;
};

export type InstallerTarget =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64";
```

### Mobile-facing WebSocket TypeScript contracts

These cover all frames the RN app itself sends or receives. Signaling bounds and required tuples come from the live browser/host handlers (`server/spawn_server/ws/browser.py:50-93`, `server/spawn_server/ws/browser.py:344-646`, `server/spawn_server/ws/host.py:381-635`).

```ts
export type RtcIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};
export type IceCandidateWire = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
  [key: string]: unknown;
};
export type SessionRtcTuple = {
  session_id: string; // RTC attempt ID, not durable session UUID
  scope_type: "session";
  scope_id: UUID; // durable PTY session
  protocol: "spawn.pty";
  protocol_version: 2;
};
export type HostRtcTuple = {
  session_id: string; // RTC attempt ID
  scope_type: "host";
  scope_id: UUID;
  protocol: "spawn.host.ctl";
  protocol_version: 1;
};
export type RawOffer<T> = T & {
  type: "rtc.offer";
  sdp: string;
  signed_envelope?: never;
};
export type SignedOffer<T> = T & {
  type: "rtc.offer";
  signed_envelope: string;
  sdp?: never;
};
export type RtcCandidate<T> = T & {
  type: "rtc.candidate";
  candidate: IceCandidateWire;
  binding_nonce?: string;
  binding_generation?: number;
};
export type RtcClose<T> = T & {
  type: "rtc.close";
  binding_nonce?: string;
  binding_generation?: number;
};
export type RtcAnswer<T> = T & {
  type: "rtc.answer";
  binding_nonce: string;
  binding_generation: number;
} & ({ sdp: string; signed_envelope?: never } |
     { signed_envelope: string; sdp?: never });
export type RtcStatus<T> = Partial<T> & {
  type: "rtc.status";
  session_id: string;
  binding_nonce?: string;
  binding_generation?: number;
  status: string;
  message?: string;
};
export type ProtocolRequired =
  | { type: "protocol.required"; protocol: "spawn.v3"; version: 3 }
  | { type: "protocol.required"; protocol: "spawn.alerts.v1"; version: 1 };

export type SessionSocketOutbound =
  | ((RawOffer<SessionRtcTuple> | SignedOffer<SessionRtcTuple>) & {
      binding_nonce: string; // 32 lowercase hex
    })
  | (RtcCandidate<SessionRtcTuple> & { binding_nonce: string })
  | (RtcClose<SessionRtcTuple> & { binding_nonce: string });
export type SessionSocketInbound =
  | {
      type: "rtc.config";
      enabled: boolean;
      ice_servers: RtcIceServer[];
      binding_nonce_required: true;
    }
  | { type: "session.status"; status: string }
  | { type: "session.exit"; exit_code: number | null; signal: string | null }
  | RtcAnswer<SessionRtcTuple>
  | RtcCandidate<SessionRtcTuple>
  | RtcStatus<SessionRtcTuple>
  | ProtocolRequired;

export type HostSocketOutbound =
  | RawOffer<HostRtcTuple>
  | SignedOffer<HostRtcTuple>
  | RtcCandidate<HostRtcTuple>
  | RtcClose<HostRtcTuple>;
export type HostSocketInbound =
  | {
      type: "rtc.config";
      enabled: boolean;
      ice_servers: RtcIceServer[];
      ice_transport_policy: "all" | "relay";
      scope_type: "host";
      scope_id: UUID;
      protocol: "spawn.host.ctl";
      protocol_version: 1;
    }
  | RtcAnswer<HostRtcTuple>
  | RtcCandidate<HostRtcTuple>
  | RtcStatus<HostRtcTuple>;

export type AlertsPing = { type: "alerts.ping" };
export type AgentAlert = {
  type: "alert";
  event: "agent.finished" | "agent.awaiting_input";
  session_id: UUID;
  command: string;
  at: IsoDateTime;
};
export type SessionDiedAlert = {
  type: "alert";
  event: "session.died";
  session_id: UUID;
  command: string | null;
  exit_code: number | null;
  signal: string | null;
  at: IsoDateTime;
};
export type AlertSocketInbound = AlertsPing | AgentAlert | SessionDiedAlert | ProtocolRequired;
```

### Base fetch client

This wrapper normalizes FastAPI errors, injects bearer auth, handles 204, applies timeouts, and retries only safe GETs once on a network error or 502/503/504. It deliberately does **not** retry POST/PATCH/PUT/DELETE, 401, 409, 422, or 429. `Retry-After` is exposed for the caller. The web client establishes the same core error normalization from FastAPI `detail` (`web/src/lib/api.ts:18-65`).

```ts
export type ValidationIssue = {
  type: string;
  loc: Array<string | number>;
  msg: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AccessTokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

const ACCESS_TOKEN_KEY = "spawn.access_token.v1";

export class SecureAccessTokenStore implements AccessTokenStore {
  async get(): Promise<string | null> {
    return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
  }
  async set(token: string): Promise<void> {
    await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token, {
      // Works in Expo Go; do not enable requireAuthentication there.
      requireAuthentication: false,
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
  retrySafeGet?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

function queryString(values: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: { code?: string; message?: string; detail?: unknown } | undefined;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const detailMessage = typeof body?.detail === "string" ? body.detail : undefined;
  const retryHeader = response.headers.get("Retry-After");
  const retryAfter = retryHeader === null ? undefined : Number.parseInt(retryHeader, 10);
  return new ApiError(
    response.status,
    body?.code ?? `http_${response.status}`,
    body?.message ?? detailMessage ?? response.statusText ?? `HTTP ${response.status}`,
    body?.detail,
    Number.isFinite(retryAfter) ? retryAfter : undefined,
  );
}

export class SpawnApi {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly tokens: AccessTokenStore = new SecureAccessTokenStore(),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(this.baseUrl)) {
      throw new Error("SpawnApi baseUrl must be an absolute http(s) URL");
    }
  }

  private async fetchResponse(path: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? 15_000;
    const attempts = method === "GET" && options.retrySafeGet !== false ? 2 : 1;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const onCallerAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });
      try {
        const token = options.auth === false ? null : await this.tokens.get();
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...options.headers,
          },
          body,
        });
        if (attempt + 1 < attempts && [502, 503, 504].includes(response.status)) {
          continue;
        }
        return response;
      } catch (error) {
        if (attempt + 1 < attempts && !options.signal?.aborted) continue;
        if (options.signal?.aborted) throw error;
        if (controller.signal.aborted) {
          throw new ApiError(0, "timeout", `Request timed out after ${timeoutMs}ms`, error);
        }
        throw new ApiError(
          0,
          "network_error",
          error instanceof Error ? error.message : "Network request failed",
          error,
        );
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onCallerAbort);
      }
    }
    throw new Error("unreachable");
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.fetchResponse(path, options);
    if (!response.ok) {
      const error = await errorFromResponse(response);
      if (error.status === 401 && options.auth !== false) await this.tokens.clear();
      throw error;
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async requestText(path: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.fetchResponse(path, options);
    if (!response.ok) throw await errorFromResponse(response);
    return response.text();
  }

  private async requestBytes(path: string, options: RequestOptions = {}): Promise<ArrayBuffer> {
    const response = await this.fetchResponse(path, options);
    if (!response.ok) throw await errorFromResponse(response);
    return response.arrayBuffer();
  }

  async setAccessToken(token: string): Promise<void> { await this.tokens.set(token); }
  async clearAccessToken(): Promise<void> { await this.tokens.clear(); }
  async getAccessToken(): Promise<string | null> { return this.tokens.get(); }

  // Health/auth/account
  health(): Promise<HealthzResponse> {
    return this.request("/healthz", { auth: false });
  }
  authConfig(): Promise<AuthConfigOut> {
    return this.request("/api/auth/config", { auth: false });
  }
  async signup(body: SignupRequest): Promise<TokenResponse> {
    const result = await this.request<TokenResponse>("/api/auth/signup", {
      method: "POST", body, auth: false,
    });
    await this.tokens.set(result.access_token);
    return result;
  }
  async login(body: LoginRequest): Promise<TokenResponse> {
    const result = await this.request<TokenResponse>("/api/auth/login", {
      method: "POST", body, auth: false,
    });
    await this.tokens.set(result.access_token);
    return result;
  }
  async logout(): Promise<void> {
    try {
      await this.request<void>("/api/auth/logout", { method: "POST" });
    } finally {
      await this.tokens.clear();
    }
  }
  me(): Promise<MeResponse> { return this.request("/api/me"); }
  async deleteAccount(body: AccountDeleteRequest): Promise<void> {
    await this.request<void>("/api/account/delete", { method: "POST", body });
    await this.tokens.clear();
  }
  requestPasswordReset(body: PasswordResetRequest): Promise<void> {
    return this.request("/api/auth/password-reset/request", {
      method: "POST", body, auth: false,
    });
  }
  async confirmPasswordReset(body: PasswordResetConfirm): Promise<TokenResponse> {
    const result = await this.request<TokenResponse>("/api/auth/password-reset/confirm", {
      method: "POST", body, auth: false,
    });
    await this.tokens.set(result.access_token);
    return result;
  }
  requestEmailVerification(): Promise<void> {
    return this.request("/api/auth/verify-email/request", { method: "POST" });
  }
  confirmEmailVerification(body: EmailVerifyConfirm): Promise<MeResponse> {
    return this.request("/api/auth/verify-email/confirm", {
      method: "POST", body, auth: false,
    });
  }
  oauthStartUrl(provider: ProviderId, returnTo = "/"): string {
    return `${this.baseUrl}/api/auth/oauth/${provider}/start${queryString({ return_to: returnTo })}`;
  }
  oauthCallbackUrl(
    provider: ProviderId,
    values: { state?: string; code?: string; error?: string },
  ): string {
    return `${this.baseUrl}/api/auth/oauth/${provider}/callback${queryString(values)}`;
  }

  // Device-code flow
  startDevice(body: DeviceStartRequest): Promise<DeviceStartResponse> {
    return this.request("/api/auth/device/start", { method: "POST", body, auth: false });
  }
  proveDevicePossession(body: DevicePossessionRequest): Promise<DevicePossessionResponse> {
    return this.request("/api/auth/device/possession", { method: "POST", body, auth: false });
  }
  pollDevice(body: DevicePollRequest): Promise<DevicePollResponse> {
    return this.request("/api/auth/device/poll", { method: "POST", body, auth: false });
  }
  pendingDevice(body: DevicePendingRequest): Promise<DevicePendingResponse> {
    return this.request("/api/auth/device/pending", { method: "POST", body });
  }
  approveDevice(body: DeviceApproveRequest): Promise<DeviceApproveResponse> {
    return this.request("/api/auth/device/approve", { method: "POST", body });
  }

  // Browser devices
  registerBrowserDevice(body: BrowserDeviceRegisterRequest): Promise<BrowserDeviceOut> {
    return this.request("/api/browser-devices/register", { method: "POST", body });
  }
  listBrowserDevices(): Promise<BrowserDeviceOut[]> {
    return this.request("/api/browser-devices");
  }
  pruneBrowserDevices(): Promise<BrowserDevicePruneResponse> {
    return this.request("/api/browser-devices/prune", { method: "POST" });
  }
  revokeBrowserDevice(id: UUID, body: BrowserDeviceRevokeRequest): Promise<BrowserDeviceOut> {
    return this.request(`/api/browser-devices/${pathPart(id)}/revoke`, { method: "POST", body });
  }
  renameBrowserDevice(id: UUID, body: BrowserDeviceRenameRequest): Promise<BrowserDeviceOut> {
    return this.request(`/api/browser-devices/${pathPart(id)}`, { method: "PATCH", body });
  }

  // Hosts
  listHosts(): Promise<HostOut[]> { return this.request("/api/hosts"); }
  getHost(id: UUID): Promise<HostOut> {
    return this.request(`/api/hosts/${pathPart(id)}`);
  }
  updateHost(id: UUID, body: HostPatch): Promise<HostOut> {
    return this.request(`/api/hosts/${pathPart(id)}`, { method: "PATCH", body });
  }
  getHostAgents(id: UUID): Promise<HostAgentList> {
    return this.request(`/api/hosts/${pathPart(id)}/agents`, { timeoutMs: 20_000 });
  }
  getRecentDirs(id: UUID): Promise<RecentDirList> {
    return this.request(`/api/hosts/${pathPart(id)}/recent-dirs`);
  }
  pingHost(id: UUID): Promise<void> {
    return this.request(`/api/hosts/${pathPart(id)}/control/ping`, {
      method: "POST", timeoutMs: 5_000,
    });
  }
  installHostAgent(hostId: UUID, agentId: UUID): Promise<HostAgentInstallResult> {
    return this.request(
      `/api/hosts/${pathPart(hostId)}/agents/${pathPart(agentId)}/install`,
      { method: "POST", timeoutMs: 190_000 },
    );
  }
  updateHostAgentPolicy(
    hostId: UUID, agentId: UUID, body: HostAgentPolicyPatch,
  ): Promise<HostAgentPolicyOut> {
    return this.request(
      `/api/hosts/${pathPart(hostId)}/agents/${pathPart(agentId)}/policy`,
      { method: "PATCH", body },
    );
  }
  deleteHost(id: UUID): Promise<void> {
    return this.request(`/api/hosts/${pathPart(id)}`, { method: "DELETE" });
  }

  // Sessions and skills/access
  listSessions(hostId?: UUID): Promise<SessionOut[]> {
    return this.request(`/api/sessions${queryString({ host_id: hostId })}`);
  }
  createSession(body: SessionCreate): Promise<SessionOut> {
    return this.request("/api/sessions", { method: "POST", body });
  }
  getSession(id: UUID): Promise<SessionOut> {
    return this.request(`/api/sessions/${pathPart(id)}`);
  }
  updateSession(id: UUID, body: SessionPatch): Promise<SessionOut> {
    return this.request(`/api/sessions/${pathPart(id)}`, { method: "PATCH", body });
  }
  restartSession(id: UUID): Promise<SessionOut> {
    return this.request(`/api/sessions/${pathPart(id)}/restart`, { method: "POST" });
  }
  deleteSession(id: UUID): Promise<void> {
    return this.request(`/api/sessions/${pathPart(id)}`, { method: "DELETE" });
  }
  getSessionAccess(id: UUID): Promise<SessionAccessOut> {
    return this.request(`/api/sessions/${pathPart(id)}/access`);
  }
  updateSessionAccess(id: UUID, body: SessionAccessPatch): Promise<SessionAccessOut> {
    return this.request(`/api/sessions/${pathPart(id)}/access`, { method: "PATCH", body });
  }
  listSkills(): Promise<SkillOut[]> { return this.request("/api/skills"); }
  createSkill(body: SkillCreate): Promise<SkillOut> {
    return this.request("/api/skills", { method: "POST", body });
  }
  updateSkill(id: UUID, body: SkillPatch): Promise<SkillOut> {
    return this.request(`/api/skills/${pathPart(id)}`, { method: "PATCH", body });
  }
  deleteSkill(id: UUID): Promise<void> {
    return this.request(`/api/skills/${pathPart(id)}`, { method: "DELETE" });
  }

  // Agent definitions/preferences
  listAgents(): Promise<AgentOut[]> { return this.request("/api/agents"); }
  createAgent(body: AgentCreate): Promise<AgentOut> {
    return this.request("/api/agents", { method: "POST", body });
  }
  updateAgent(id: UUID, body: AgentPatch): Promise<AgentOut> {
    return this.request(`/api/agents/${pathPart(id)}`, { method: "PATCH", body });
  }
  deleteAgent(id: UUID): Promise<void> {
    return this.request(`/api/agents/${pathPart(id)}`, { method: "DELETE" });
  }
  updateAgentPreferences(id: UUID, body: AgentPreferencePatch): Promise<AgentOut> {
    return this.request(`/api/agents/${pathPart(id)}/preferences`, { method: "PATCH", body });
  }

  // Workspaces/tabs
  listWorkspaces(archived = false): Promise<WorkspaceOut[]> {
    return this.request(`/api/workspaces${queryString({ archived })}`);
  }
  createWorkspace(body: WorkspaceCreate): Promise<WorkspaceCreateResponse> {
    return this.request("/api/workspaces", { method: "POST", body });
  }
  getWorkspace(id: UUID): Promise<WorkspaceOut> {
    return this.request(`/api/workspaces/${pathPart(id)}`);
  }
  updateWorkspace(id: UUID, body: WorkspacePatch): Promise<WorkspaceOut> {
    return this.request(`/api/workspaces/${pathPart(id)}`, { method: "PATCH", body });
  }
  archiveWorkspace(id: UUID): Promise<WorkspaceOut> {
    return this.request(`/api/workspaces/${pathPart(id)}/archive`, { method: "POST" });
  }
  unarchiveWorkspace(id: UUID): Promise<WorkspaceOut> {
    return this.request(`/api/workspaces/${pathPart(id)}/unarchive`, { method: "POST" });
  }
  deleteWorkspace(id: UUID): Promise<void> {
    return this.request(`/api/workspaces/${pathPart(id)}`, { method: "DELETE" });
  }

  // Workspace templates
  listWorkspaceTemplates(): Promise<WorkspaceTemplateOut[]> {
    return this.request("/api/workspace-templates");
  }
  createWorkspaceTemplate(body: WorkspaceTemplateCreate): Promise<WorkspaceTemplateOut> {
    return this.request("/api/workspace-templates", { method: "POST", body });
  }
  updateWorkspaceTemplate(
    id: UUID, body: WorkspaceTemplatePatch,
  ): Promise<WorkspaceTemplateOut> {
    return this.request(`/api/workspace-templates/${pathPart(id)}`, { method: "PATCH", body });
  }
  deleteWorkspaceTemplate(id: UUID): Promise<void> {
    return this.request(`/api/workspace-templates/${pathPart(id)}`, { method: "DELETE" });
  }

  // Trust
  getTrustBundle(): Promise<TrustBundleOut | null> {
    return this.request("/api/trust/bundle");
  }
  putTrustBundle(body: TrustBundlePut): Promise<TrustBundleOut> {
    return this.request("/api/trust/bundle", { method: "PUT", body });
  }
  listPasskeys(): Promise<PasskeyCredentialOut[]> {
    return this.request("/api/trust/passkeys");
  }
  createPasskey(body: PasskeyCredentialCreate): Promise<PasskeyCredentialOut> {
    return this.request("/api/trust/passkeys", { method: "POST", body });
  }
  deletePasskey(id: UUID): Promise<void> {
    return this.request(`/api/trust/passkeys/${pathPart(id)}`, { method: "DELETE" });
  }
  listEndorsements(endorsedDeviceId: UUID): Promise<BrowserEndorsementRecord[]> {
    return this.request(
      `/api/trust/endorsements${queryString({ endorsed_device_id: endorsedDeviceId })}`,
    );
  }
  createEndorsement(body: BrowserEndorsementCreate): Promise<BrowserEndorsementOut> {
    return this.request("/api/trust/endorsements", { method: "POST", body });
  }
  listHostPins(hostId: UUID): Promise<UUID[]> {
    return this.request(`/api/trust/hosts/${pathPart(hostId)}/pins`);
  }

  // Profile/admin
  getProfile(): Promise<ProfileOut> { return this.request("/api/profile"); }
  listAdminUsers(): Promise<AdminUserOut[]> {
    return this.request("/api/admin/users");
  }
  listAdminInvites(): Promise<AdminInviteOut[]> {
    return this.request("/api/admin/invites");
  }
  createAdminInvite(body: AdminInviteCreate): Promise<AdminInviteOut> {
    return this.request("/api/admin/invites", { method: "POST", body });
  }
  revokeAdminInvite(id: UUID): Promise<AdminInviteOut> {
    return this.request(`/api/admin/invites/${pathPart(id)}/revoke`, { method: "POST" });
  }
  getAdminMailStatus(): Promise<AdminMailStatus> {
    return this.request("/api/admin/mail");
  }
  listAdminEmails(limit = 100): Promise<AdminEmailOut[]> {
    return this.request(`/api/admin/emails${queryString({ limit })}`);
  }
  sendAdminTestEmail(body: AdminTestEmail): Promise<AdminEmailOut> {
    return this.request("/api/admin/emails/test", { method: "POST", body });
  }

  // Public daemon installer endpoints
  downloadSpawnd(target: InstallerTarget): Promise<ArrayBuffer> {
    return this.requestBytes(`/api/install/spawnd/${target}`, { auth: false });
  }
  downloadSpawnWorker(target: InstallerTarget): Promise<ArrayBuffer> {
    return this.requestBytes(`/api/install/spawn-worker/${target}`, { auth: false });
  }
  getInstallScript(): Promise<string> {
    return this.requestText("/install.sh", { auth: false });
  }

  // Current Expo-Go-compatible WS construction: token query fallback.
  private async socketUrl(path: string, query: Record<string, string>): Promise<string> {
    const token = await this.tokens.get();
    if (!token) throw new ApiError(401, "not_authenticated", "No access token");
    const url = new URL(`${this.baseUrl}${path}`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    for (const [key, value] of Object.entries({ ...query, token })) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
  async openSessionSocket(sessionId: UUID): Promise<WebSocket> {
    return new WebSocket(
      await this.socketUrl("/ws/browser", { session_id: sessionId }),
      "spawn.v3",
    );
  }
  async openHostSocket(hostId: UUID): Promise<WebSocket> {
    return new WebSocket(
      await this.socketUrl("/ws/host", { host_id: hostId }),
      "spawn.host.v1",
    );
  }
  async openAlertSocket(): Promise<WebSocket> {
    return new WebSocket(await this.socketUrl("/ws/alerts", {}), "spawn.alerts.v1");
  }
}
```

### Required client behavior around that module

- Instantiate exactly one `SpawnApi` per configured server. Changing server URL must clear the token or namespace SecureStore keys by server; otherwise a token for server A will be sent to server B.
- Validate the base URL at setup and require HTTPS outside local development. Never follow a user-supplied base to plain HTTP over public networks.
- On app startup call `me()`. A 401 means signed out because the current access token is expired; there is no refresh to attempt yet.
- Do not schedule retries for 429 automatically. Show a countdown from `retryAfterSeconds` and let the user retry.
- Treat mutations as non-idempotent even where the current implementation happens to be idempotent. The wrapper intentionally does not retry them after a lost response.
- `installHostAgent` needs a timeout above the server's 180-second RPC timeout; `getHostAgents` needs above 15 seconds; `pingHost` needs above three seconds (`server/spawn_server/routes/hosts.py:479-588`).
- A socket close or background/foreground gap invalidates continuity. Reopen the relevant sockets and refetch hosts/sessions/workspace because no sequence number exists.
- Parse inbound WS text with `JSON.parse`, validate `type`, tuple, and target IDs before mutating shared state. Ignore unknown frame types for forward compatibility.
- Generate a fresh cryptographically random RTC attempt ID and, for `/ws/browser`, a fresh 16-byte/32-lowercase-hex binding nonce for every negotiation. Never reuse after close/failure.
- Do not send PTY bytes, keyboard input, resize, replay, or file content through these WebSockets. Those belong to the authenticated WebRTC DataChannels (`server/spawn_server/ws/browser.py:344-390`).

### What cannot be copied yet

The module intentionally has no `refresh()` or native OAuth exchange because those endpoints do not exist. Add them only when the backend contract is implemented. Until then, `401` clears the 15-minute token and returns to sign-in. Hiding that gap behind cookie behavior would make Expo Go testing pass intermittently while leaving production session persistence undefined.

The module also does not implement WebAuthn PRF trust-bundle encryption. That is not an HTTP-client concern and remains the physical-device capability decision identified above.
