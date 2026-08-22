import { z } from "zod";

/**
 * Typed REST helpers. Shapes mirror `/proto/README.md` exactly.
 *
 * All requests carry HTTP-only session cookies via `credentials: "include"`.
 * Errors are surfaced as `ApiError` so the caller (TanStack Query) can branch
 * on `status` / `code`.
 */

// Empty string means "use the current origin" — in deployed/tunnelled mode
// we go through Next.js rewrites, so /api/* is same-origin. In dev where the
// FastAPI server is on a different port, set NEXT_PUBLIC_SPAWN_API_URL.
const API_URL = process.env.NEXT_PUBLIC_SPAWN_API_URL ?? "";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { schema?: z.ZodType<T> } = {},
): Promise<T> {
  const { schema, headers, ...rest } = init;
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
    ...rest,
  });

  if (!res.ok) {
    let body: { code?: string; message?: string; detail?: unknown } | undefined;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    // FastAPI returns `{detail: "..."}` for HTTPException; surface that as the
    // human message so users don't just see a bare "Bad Request".
    const detailMsg = typeof body?.detail === "string" ? body.detail : undefined;
    throw new ApiError(
      res.status,
      body?.code ?? `http_${res.status}`,
      body?.message ?? detailMsg ?? res.statusText,
      body?.detail,
    );
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json();
  return schema ? schema.parse(data) : (data as T);
}

// ---------- Schemas ----------

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  created_at: z.string(),
  email_verified_at: z.string().nullable().default(null),
  is_admin: z.boolean().default(false),
});
export type User = z.infer<typeof UserSchema>;

export const HostSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  os: z.string().nullable().optional(),
  arch: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  host_key_algorithm: z.literal("ed25519").nullable().optional(),
  // The key travels alone (mesh B5): any fingerprint shown or compared is
  // derived locally from it, never read off a server response.
  host_public_key: z.string().nullable().optional(),
  status: z.enum(["online", "offline"]),
  last_seen_at: z.string().nullable(),
  agent_count: z.number().int(),
  /** Mesh R9: chain-capable hosts refuse the legacy per-host endorsement path. */
  supports_account_chains: z.boolean().default(false),
});
export type Host = z.infer<typeof HostSchema>;

export const HostToolStatusSchema = z.object({
  preset_id: z.string(),
  preset_name: z.string(),
  agent_kind: z.string(),
  command: z.string(),
  install: z.string().nullable().optional(),
  installed: z.boolean().default(false),
  path: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  latest_version: z.string().nullable().optional(),
  update_available: z.boolean().nullable().optional(),
  error: z.string().nullable().optional(),
  auto_update: z.boolean().default(false),
  last_checked_at: z.string().nullable().optional(),
  last_auto_update_at: z.string().nullable().optional(),
  last_auto_update_error: z.string().nullable().optional(),
});
export type HostToolStatus = z.infer<typeof HostToolStatusSchema>;

export const HostToolListSchema = z.object({
  tools: z.array(HostToolStatusSchema).default([]),
});
export type HostToolList = z.infer<typeof HostToolListSchema>;

export const HostToolInstallResultSchema = z.object({
  preset_id: z.string(),
  preset_name: z.string(),
  agent_kind: z.string(),
  command: z.string(),
  install: z.string().nullable().optional(),
  success: z.boolean(),
  exit_code: z.number().int().nullable().optional(),
  output: z.string().default(""),
  error: z.string().nullable().optional(),
  status: HostToolStatusSchema.nullable().optional(),
});
export type HostToolInstallResult = z.infer<typeof HostToolInstallResultSchema>;

export const HostToolPolicySchema = z.object({
  preset_id: z.string(),
  auto_update: z.boolean().default(false),
  last_checked_at: z.string().nullable().optional(),
  last_auto_update_at: z.string().nullable().optional(),
  last_auto_update_error: z.string().nullable().optional(),
});
export type HostToolPolicy = z.infer<typeof HostToolPolicySchema>;

export const AgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable().default(null),
  host_id: z.string().uuid(),
  host_name: z.string().nullable().default(null),
  preset_id: z.string().uuid().nullable(),
  cwd: z.string(),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()).default({}),
  status: z.enum(["starting", "running", "exited", "killed"]),
  started_at: z.string(),
  exited_at: z.string().nullable(),
  last_output_at: z.string().nullable().default(null),
  last_input_at: z.string().nullable().default(null),
  last_activity_at: z.string().nullable().default(null),
  activity_state: z
    .enum(["starting", "active", "quiet", "waiting", "input_sent", "exited", "killed", "unknown"])
    .default("unknown"),
  activity_label: z.string().default("Unknown"),
  exit_code: z.number().int().nullable(),
  pinned_at: z.string().nullable().default(null),
  archived_at: z.string().nullable().default(null),
});
export type Agent = z.infer<typeof AgentSchema>;

export const PresetSchema = z.object({
  id: z.string().uuid(),
  owner_user_id: z.string().uuid().nullable(),
  name: z.string(),
  agent_kind: z.string(),
  default_argv: z.array(z.string()),
  env_template: z.record(z.string(), z.string()).default({}),
  install: z.string().nullable().optional(),
});
export type Preset = z.infer<typeof PresetSchema>;

export interface PresetCreateInput {
  name: string;
  agent_kind: string;
  default_argv: string[];
  env_template?: Record<string, string>;
  install?: string | null;
}

export type PresetUpdateInput = Partial<PresetCreateInput>;

export const SkillSchema = z.object({
  id: z.string().uuid(),
  owner_user_id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  enabled_by_default: z.boolean().default(false),
  created_at: z.string(),
});
export type Skill = z.infer<typeof SkillSchema>;

export interface SkillCreateInput {
  name: string;
  description?: string;
  content: string;
  enabled_by_default?: boolean;
}

export type SkillUpdateInput = Partial<SkillCreateInput>;

export const AgentAccessSchema = z.object({
  agent_id: z.string().uuid(),
  skills: z.array(SkillSchema).default([]),
});
export type AgentAccess = z.infer<typeof AgentAccessSchema>;

export const LayoutNodeSchema: z.ZodType<import("@/lib/layout").LayoutNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("pane"), agent_id: z.string().uuid() }),
    z.object({
      type: z.literal("split"),
      direction: z.enum(["row", "column"]),
      ratio: z.number().min(0.05).max(0.95),
      a: LayoutNodeSchema,
      b: LayoutNodeSchema,
    }),
  ]),
) as z.ZodType<import("@/lib/layout").LayoutNode>;

export const ScreenLayoutSchema = z.object({
  root: LayoutNodeSchema.nullable().default(null),
});
export type ScreenLayout = z.infer<typeof ScreenLayoutSchema>;

export const ScreenSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  layout: ScreenLayoutSchema,
  ephemeral: z.boolean().default(false),
  pinned_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Screen = z.infer<typeof ScreenSchema>;

export const AuthResponseSchema = z.object({
  access_token: z.string(),
  user: UserSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const DeviceStartResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  approval_nonce: z.string().length(43),
  verification_uri: z.string(),
  interval: z.number(),
  expires_in: z.number(),
});

export const DevicePendingResponseSchema = z.object({
  host_name: z.string(),
  approval_nonce: z.string().length(43),
  host_key_algorithm: z.literal("ed25519"),
  host_public_key: z.string(),
  host_key_fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9_-]{16}$/u),
  // The server may still relay legacy possession-SAS fields (sas_commit,
  // sas_host_nonce) for pre-fragment daemons; this client ignores them — the
  // host key is verified against the out-of-band `#k=` URL fragment instead,
  // with the full-fingerprint compare as the only fallback.
});
export type DevicePendingApproval = z.infer<typeof DevicePendingResponseSchema>;

// Unlike the pending review (whose fingerprint the daemon prints for the
// out-of-band compare), the approve echo carries the keys alone (mesh B5):
// the client verifies the echoed keys byte-for-byte and derives any
// fingerprint it needs locally.
export const DeviceApproveResponseSchema = DevicePendingResponseSchema.omit({
  host_key_fingerprint: true,
}).extend({
  browser_device_id: z.string().uuid(),
  browser_key_algorithm: z.literal("ed25519"),
  browser_public_key: z.string().length(43),
  // Present only when this key was already paired (re-pair): the Host row's
  // UUID, used to bind the local pin immediately. First pairings get null and
  // seed from /api/hosts once the daemon's poll creates the row.
  host_id: z.string().uuid().nullish(),
});
export type DeviceApproval = z.infer<typeof DeviceApproveResponseSchema>;

export const AuthProviderSchema = z.object({
  id: z.enum(["google", "microsoft", "github"]),
  name: z.string(),
});
export type AuthProvider = z.infer<typeof AuthProviderSchema>;

export const AuthProviderListSchema = z.object({
  providers: z.array(AuthProviderSchema).default([]),
});
export type AuthProviderList = z.infer<typeof AuthProviderListSchema>;

export const BrowserDeviceSchema = z.object({
  id: z.string().uuid(),
  key_algorithm: z.literal("ed25519"),
  // No fingerprint field (mesh B5): the roster derives display fingerprints
  // from this key locally (ed25519PublicKeyFingerprint), never from a
  // server-authored label.
  public_key: z.string().length(43),
  /** Recognition only; never a trust input. See the server model. */
  label: z.string().nullable().default(null),
  created_at: z.string(),
  /** Stamped each time this device's registration reconciles (every app load). */
  last_seen_at: z.string().nullable().default(null),
  /** When this device last actively asked to be approved (it tried to open an
   * agent session). Surfaces — and re-surfaces — the approval toast elsewhere. */
  approval_requested_at: z.string().nullable().default(null),
  revoked_at: z.string().nullable(),
  /** Which of the account's devices asked for the removal (attribution, R4). */
  revoked_by_device_id: z.string().nullable().default(null),
  /** The account root (pk_R): endorses + anchors, never connects. Filtered out
   * of connect/ceremony lists. */
  is_root: z.boolean().default(false),
});
export type BrowserDevice = z.infer<typeof BrowserDeviceSchema>;

/** Opaque ciphertext: the server stores it and cannot read it. */
export const TrustBundleSchema = z.object({
  sealed: z.string().min(1),
  revision: z.number().int().min(1),
  updated_at: z.string(),
});
export type TrustBundle = z.infer<typeof TrustBundleSchema>;

export const PasskeyCredentialSchema = z.object({
  id: z.string().uuid(),
  credential_id: z.string().min(1),
  label: z.string().nullable(),
  created_at: z.string(),
});
export type PasskeyCredential = z.infer<typeof PasskeyCredentialSchema>;

// ---------- Endpoints ----------

export const auth = {
  signup: (body: { email: string; password: string; invite?: string | null }) =>
    api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify(body),
      schema: AuthResponseSchema,
    }),
  login: (body: { email: string; password: string }) =>
    api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
      schema: AuthResponseSchema,
    }),
  logout: () => api<void>("/api/auth/logout", { method: "POST" }),
  /** Always succeeds, whether or not the address has an account. */
  requestPasswordReset: (email: string) =>
    api<void>("/api/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  confirmPasswordReset: (body: { token: string; new_password: string }) =>
    api("/api/auth/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify(body),
      schema: AuthResponseSchema,
    }),
  requestEmailVerification: () => api<void>("/api/auth/verify-email/request", { method: "POST" }),
  confirmEmailVerification: (token: string) =>
    api("/api/auth/verify-email/confirm", {
      method: "POST",
      body: JSON.stringify({ token }),
      schema: z.object({ user: UserSchema }),
    }),
  me: () =>
    api("/api/me", {
      method: "GET",
      schema: z.object({ user: UserSchema }),
    }),
  providers: () =>
    api("/api/auth/providers", {
      method: "GET",
      schema: AuthProviderListSchema,
    }),
  approveDevice: (body: {
    user_code?: string;
    approval_ref?: string;
    approval_nonce: string;
    host_key_algorithm: "ed25519";
    host_public_key: string;
    host_key_fingerprint: string;
    browser_device_id: string;
    browser_key_algorithm: "ed25519";
    browser_public_key: string;
    browser_key_fingerprint: string;
    signature: string;
  }) =>
    api("/api/auth/device/approve", {
      method: "POST",
      body: JSON.stringify(body),
      schema: DeviceApproveResponseSchema,
    }),
  pendingDevice: (body: { user_code?: string; approval_ref?: string }) =>
    api("/api/auth/device/pending", {
      method: "POST",
      body: JSON.stringify(body),
      schema: DevicePendingResponseSchema,
    }),
};

export const hosts = {
  list: () =>
    api("/api/hosts", {
      method: "GET",
      schema: z.array(HostSchema),
    }),
  get: (id: string) =>
    api(`/api/hosts/${id}`, {
      method: "GET",
      schema: HostSchema,
    }),
  rename: (id: string, name: string) =>
    api(`/api/hosts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
      schema: HostSchema,
    }),
  remove: (id: string) => api<void>(`/api/hosts/${id}`, { method: "DELETE" }),
  tools: (id: string) =>
    api(`/api/hosts/${id}/tools`, {
      method: "GET",
      schema: HostToolListSchema,
    }),
  installTool: (id: string, presetId: string) =>
    api(`/api/hosts/${id}/tools/${presetId}/install`, {
      method: "POST",
      schema: HostToolInstallResultSchema,
    }),
  updateToolPolicy: (id: string, presetId: string, body: { auto_update?: boolean }) =>
    api(`/api/hosts/${id}/tools/${presetId}/policy`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: HostToolPolicySchema,
    }),
};

export const browserDevices = {
  register: (body: {
    key_algorithm: "ed25519";
    public_key: string;
    signature: string;
    label?: string | null;
    /** Registers the account ROOT (mesh stage 5): at most one per account. */
    is_root?: boolean;
  }) =>
    api("/api/browser-devices/register", {
      method: "POST",
      body: JSON.stringify(body),
      schema: BrowserDeviceSchema,
    }),
  list: () =>
    api("/api/browser-devices", {
      method: "GET",
      schema: z.array(BrowserDeviceSchema),
    }),
  /** The account's PERMANENT key deny-list (R10 tombstones). Corroboration
   * data for destructive revocation-claim handling (hardening B2): the roster
   * is mutable, this table is add-only, so a claim must appear in BOTH before
   * the client rotates the sealed root over it. */
  revokedKeys: () =>
    api("/api/browser-devices/revoked-keys", {
      method: "GET",
      schema: z.array(
        z.object({
          public_key: z.string().length(43),
          key_algorithm: z.string(),
          revoked_at: z.string(),
        }),
      ),
    }),
  rename: (deviceId: string, label: string | null) =>
    api(`/api/browser-devices/${deviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ label }),
      schema: BrowserDeviceSchema,
    }),
  revoke: (deviceId: string, expectedPublicKey: string, revokedByDeviceId?: string | null) =>
    api(`/api/browser-devices/${deviceId}/revoke`, {
      method: "POST",
      body: JSON.stringify({
        expected_public_key: expectedPublicKey,
        revoked_by_device_id: revokedByDeviceId ?? null,
      }),
      schema: BrowserDeviceSchema,
    }),
  /** Hard-deletes this account's revoked device tombstones. */
  prune: () =>
    api("/api/browser-devices/prune", {
      method: "POST",
      schema: z.object({ pruned: z.number().int() }),
    }),
  /** This (unapproved) device asks out loud to be approved — other devices'
   * roster poll surfaces, or re-surfaces, the approval toast. Advisory only. */
  requestApproval: (deviceId: string, publicKey: string) =>
    api(`/api/browser-devices/${deviceId}/request-approval`, {
      method: "POST",
      body: JSON.stringify({ public_key: publicKey }),
      schema: BrowserDeviceSchema,
    }),
};

export const AdminUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  created_at: z.string(),
  email_verified_at: z.string().nullable().default(null),
  is_admin: z.boolean().default(false),
  host_count: z.number().int().default(0),
  agent_count: z.number().int().default(0),
  browser_device_count: z.number().int().default(0),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminInviteSchema = z.object({
  id: z.string().uuid(),
  email: z.string().nullable().default(null),
  state: z.enum(["pending", "used", "expired", "revoked"]),
  expires_at: z.string(),
  created_at: z.string(),
  used_at: z.string().nullable().default(null),
  created_by_user_id: z.string().nullable().default(null),
  used_by_user_id: z.string().nullable().default(null),
  /** Present only in the response that created the invite — never on reload. */
  url: z.string().nullable().default(null),
});
export type AdminInvite = z.infer<typeof AdminInviteSchema>;

export const AdminMailStatusSchema = z.object({
  backend: z.string(),
  delivering: z.boolean(),
  from_address: z.string(),
  smtp_host: z.string().nullable().default(null),
});
export type AdminMailStatus = z.infer<typeof AdminMailStatusSchema>;

export const AdminEmailSchema = z.object({
  id: z.string().uuid(),
  to_email: z.string(),
  subject: z.string(),
  kind: z.string(),
  status: z.enum(["sent", "failed", "not_delivered"]),
  error: z.string().nullable().default(null),
  /** Stored with reset/invite credentials stripped — see mail.redact_credentials. */
  body_redacted: z.string().default(""),
  created_at: z.string(),
});
export type AdminEmail = z.infer<typeof AdminEmailSchema>;

export const admin = {
  mailStatus: () => api("/api/admin/mail", { method: "GET", schema: AdminMailStatusSchema }),
  emails: () => api("/api/admin/emails", { method: "GET", schema: z.array(AdminEmailSchema) }),
  sendTestEmail: (to?: string | null) =>
    api("/api/admin/emails/test", {
      method: "POST",
      body: JSON.stringify({ to: to || null }),
      schema: AdminEmailSchema,
    }),
  users: () => api("/api/admin/users", { method: "GET", schema: z.array(AdminUserSchema) }),
  invites: () => api("/api/admin/invites", { method: "GET", schema: z.array(AdminInviteSchema) }),
  createInvite: (body: { email?: string | null; ttl_hours?: number | null }) =>
    api("/api/admin/invites", {
      method: "POST",
      body: JSON.stringify(body),
      schema: AdminInviteSchema,
    }),
  revokeInvite: (id: string) =>
    api(`/api/admin/invites/${id}/revoke`, { method: "POST", schema: AdminInviteSchema }),
};

export const account = {
  /** Permanently deletes the signed-in account and everything it owns. */
  remove: (body: { confirm_email: string; password?: string }) =>
    api<void>("/api/account/delete", { method: "POST", body: JSON.stringify(body) }),
};

/** One relayed host-key introduction (mesh R7); untrusted until the joiner
 * verifies its signature against the ceremony-pinned initiator key. */
export const PairingIntroductionSchema = z.object({
  host_id: z.string(),
  host_name: z.string(),
  host_public_key: z.string().length(43),
  signature: z.string().length(86),
});
export type PairingIntroduction = z.infer<typeof PairingIntroductionSchema>;

/** One relayed device-key introduction (continuous gossip bootstrap); untrusted
 * until the joiner verifies it against the ceremony-pinned initiator key. */
export const PairingDeviceIntroductionSchema = z.object({
  device_id: z.string(),
  device_label: z.string(),
  device_public_key: z.string().length(43),
  signature: z.string().length(86),
});
export type PairingDeviceIntroduction = z.infer<typeof PairingDeviceIntroductionSchema>;

const PairingStateSchema = z.object({
  id: z.string(),
  initiator_device_id: z.string(),
  joiner_device_id: z.string(),
  initiator_public_key: z.string(),
  initiator_commit: z.string(),
  joiner_public_key: z.string().nullable().optional(),
  joiner_nonce: z.string().nullable().optional(),
  initiator_nonce: z.string().nullable().optional(),
  introductions: z.array(PairingIntroductionSchema).nullable().optional(),
  device_introductions: z.array(PairingDeviceIntroductionSchema).nullable().optional(),
  created_at: z.string(),
  expires_at: z.string(),
});
export type PairingState = z.infer<typeof PairingStateSchema>;

/** One durable broadcast introduction as served; untrusted until verified
 * against a FIRSTHAND copy of the publisher's key. */
export const HostIntroductionRowSchema = z.object({
  id: z.string(),
  publisher_device_id: z.string(),
  publisher_public_key: z.string().length(43),
  host_id: z.string(),
  host_name: z.string(),
  host_public_key: z.string().length(43),
  signature: z.string().length(86),
  created_at: z.string(),
});
export type HostIntroductionRow = z.infer<typeof HostIntroductionRowSchema>;

export const trust = {
  /** null when this account has never sealed a bundle. */
  getBundle: () =>
    api("/api/trust/bundle", {
      method: "GET",
      schema: TrustBundleSchema.nullable(),
    }),
  /**
   * `expectedRevision` must be the revision the bundle was read at, or omitted
   * when creating the first one. The server refuses a blind overwrite so a
   * stale device cannot drop host keys another device added.
   */
  putBundle: (sealed: string, expectedRevision?: number) =>
    api("/api/trust/bundle", {
      method: "PUT",
      body: JSON.stringify({ sealed, expected_revision: expectedRevision ?? null }),
      schema: TrustBundleSchema,
    }),
  /** Abandon the sealed bundle (removing the last passkey). Forgets recovery
   * material only — never grants or restores anything. */
  deleteBundle: () => api<void>("/api/trust/bundle", { method: "DELETE" }),
  listPasskeys: () =>
    api("/api/trust/passkeys", {
      method: "GET",
      schema: z.array(PasskeyCredentialSchema),
    }),
  addPasskey: (credentialId: string, label?: string) =>
    api("/api/trust/passkeys", {
      method: "POST",
      body: JSON.stringify({ credential_id: credentialId, label: label ?? null }),
      schema: PasskeyCredentialSchema,
    }),
  removePasskey: (id: string) =>
    api(`/api/trust/passkeys/${id}`, { method: "DELETE", schema: z.unknown() }),
  /** Browser device IDs a host already trusts. */
  hostPins: (hostId: string) =>
    api(`/api/trust/hosts/${hostId}/pins`, { method: "GET", schema: z.array(z.string()) }),
  /**
   * Pin records with provenance for the Access screen's host rows: `direct`
   * means the pin came from the possess ceremony itself. Display only —
   * admission stays daemon-side.
   */
  hostPinDetails: (hostId: string) =>
    api(`/api/trust/hosts/${hostId}/pin-details`, {
      method: "GET",
      schema: z.array(
        z.object({
          device_id: z.string(),
          direct: z.boolean(),
          created_at: z.string(),
        }),
      ),
    }),
  /**
   * Endorsements naming this device, so it can verify them locally and learn
   * its hosts' true keys. Every field is server-claimed; the caller verifies.
   */
  endorsementsFor: (endorsedDeviceId: string) =>
    api(`/api/trust/endorsements?endorsed_device_id=${encodeURIComponent(endorsedDeviceId)}`, {
      method: "GET",
      schema: z.array(
        z.object({
          host_id: z.string(),
          host_name: z.string(),
          host_public_key: z.string(),
          endorser_device_id: z.string(),
          endorser_public_key: z.string(),
          endorser_label: z.string().nullable().optional(),
          signature: z.string(),
        }),
      ),
    }),
  endorse: (body: {
    host_id: string;
    endorser_device_id: string;
    endorsed_device_id: string;
    signature: string;
  }) =>
    api("/api/trust/endorsements", {
      method: "POST",
      body: JSON.stringify(body),
      schema: z.object({
        host_id: z.string(),
        endorsed_device_id: z.string(),
        endorser_device_id: z.string(),
        created_at: z.string(),
      }),
    }),

  // ----- device mesh: account-scoped endorsements (§3) -----

  /**
   * Every account-scoped endorsement edge, for a device to assemble the carried
   * chain it presents on connect. Server-claimed; the daemon re-verifies each.
   */
  accountEndorsements: () =>
    api("/api/trust/account-endorsements", {
      method: "GET",
      schema: z.array(
        z.object({
          endorser_device_id: z.string(),
          endorser_public_key: z.string(),
          endorsed_device_id: z.string(),
          endorsed_public_key: z.string(),
          signature: z.string(),
          created_at: z.string(),
        }),
      ),
    }),
  createAccountEndorsement: (body: {
    endorser_device_id: string;
    endorsed_device_id: string;
    signature: string;
  }) =>
    api("/api/trust/account-endorsements", {
      method: "POST",
      body: JSON.stringify(body),
      schema: z.object({
        id: z.string(),
        endorser_device_id: z.string(),
        endorsed_device_id: z.string(),
        created_at: z.string(),
      }),
    }),

  // ----- device mesh: browser↔browser add-device SAS ceremony (§4) -----

  startPairing: (body: {
    initiator_device_id: string;
    joiner_device_id: string;
    initiator_public_key: string;
    initiator_commit: string;
  }) =>
    api("/api/trust/pairing", {
      method: "POST",
      body: JSON.stringify(body),
      schema: z.object({ id: z.string(), expires_at: z.string() }),
    }),
  listPairings: (deviceId: string) =>
    api(`/api/trust/pairing?device_id=${encodeURIComponent(deviceId)}`, {
      method: "GET",
      schema: z.array(PairingStateSchema),
    }),
  contributePairing: (id: string, body: { joiner_public_key: string; joiner_nonce: string }) =>
    api(`/api/trust/pairing/${id}/contribute`, {
      method: "POST",
      body: JSON.stringify(body),
      schema: PairingStateSchema,
    }),
  revealPairing: (id: string, body: { initiator_nonce: string }) =>
    api(`/api/trust/pairing/${id}/reveal`, {
      method: "POST",
      body: JSON.stringify(body),
      schema: PairingStateSchema,
    }),
  cancelPairing: (id: string) =>
    api(`/api/trust/pairing/${id}`, { method: "DELETE", schema: z.unknown() }),
  /** Initiator only in practice: the signatures bind ITS key; a joiner-posted
   * list would verify for no one. Set-once on the relay. */
  postPairingIntroductions: (
    id: string,
    introductions: PairingIntroduction[],
    deviceIntroductions: PairingDeviceIntroduction[] = [],
  ) =>
    api(`/api/trust/pairing/${id}/introductions`, {
      method: "POST",
      body: JSON.stringify({
        introductions,
        device_introductions: deviceIntroductions,
      }),
      schema: PairingStateSchema,
    }),
  /** The durable broadcast store (continuous gossip): every live introduction
   * for this account, minus rows from revoked publishers. */
  listHostIntroductions: () =>
    api("/api/trust/host-introductions", {
      method: "GET",
      schema: z.array(HostIntroductionRowSchema),
    }),
  /** Publish (or idempotently re-publish) one broadcast introduction. */
  publishHostIntroduction: (body: {
    publisher_device_id: string;
    host_id: string;
    host_name: string;
    host_public_key: string;
    signature: string;
  }) =>
    api("/api/trust/host-introductions", {
      method: "POST",
      body: JSON.stringify(body),
      schema: HostIntroductionRowSchema,
    }),
};

export const agents = {
  list: (params?: { host_id?: string; include_archived?: boolean }) => {
    const search = new URLSearchParams();
    if (params?.host_id) search.set("host_id", params.host_id);
    if (params?.include_archived) search.set("include_archived", "true");
    const qs = search.size ? `?${search.toString()}` : "";
    return api(`/api/agents${qs}`, {
      method: "GET",
      schema: z.array(AgentSchema),
    });
  },
  get: (id: string) =>
    api(`/api/agents/${id}`, {
      method: "GET",
      schema: AgentSchema,
    }),
  create: (body: {
    name?: string;
    host_id: string;
    preset_id?: string;
    cwd: string;
    argv?: string[];
    env?: Record<string, string>;
    skill_ids?: string[];
    create_cwd?: boolean;
  }) =>
    api("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
      schema: AgentSchema,
    }),
  update: (id: string, body: { name?: string | null; archived?: boolean; pinned?: boolean }) =>
    api(`/api/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: AgentSchema,
    }),
  restart: (id: string, body?: { create_cwd?: boolean }) =>
    api(`/api/agents/${id}/restart`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      schema: AgentSchema,
    }),
  rename: (id: string, name: string | null) => agents.update(id, { name }),
  pin: (id: string) => agents.update(id, { pinned: true }),
  unpin: (id: string) => agents.update(id, { pinned: false }),
  archive: (id: string) => agents.update(id, { archived: true }),
  unarchive: (id: string) => agents.update(id, { archived: false }),
  remove: (id: string) => api<void>(`/api/agents/${id}`, { method: "DELETE" }),
};

export const presets = {
  list: () =>
    api("/api/presets", {
      method: "GET",
      schema: z.array(PresetSchema),
    }),
  create: (body: PresetCreateInput) =>
    api("/api/presets", {
      method: "POST",
      body: JSON.stringify(body),
      schema: PresetSchema,
    }),
  update: (id: string, body: PresetUpdateInput) =>
    api(`/api/presets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: PresetSchema,
    }),
  remove: (id: string) => api<void>(`/api/presets/${id}`, { method: "DELETE" }),
};

export const skills = {
  list: () =>
    api("/api/skills", {
      method: "GET",
      schema: z.array(SkillSchema),
    }),
  create: (body: SkillCreateInput) =>
    api("/api/skills", {
      method: "POST",
      body: JSON.stringify(body),
      schema: SkillSchema,
    }),
  update: (id: string, body: SkillUpdateInput) =>
    api(`/api/skills/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: SkillSchema,
    }),
  remove: (id: string) => api<void>(`/api/skills/${id}`, { method: "DELETE" }),
};

export const screens = {
  list: () =>
    api("/api/screens", {
      method: "GET",
      schema: z.array(ScreenSchema),
    }),
  get: (id: string) =>
    api(`/api/screens/${id}`, {
      method: "GET",
      schema: ScreenSchema,
    }),
  create: (body: { name: string; layout?: ScreenLayout; ephemeral?: boolean }) =>
    api("/api/screens", {
      method: "POST",
      body: JSON.stringify(body),
      schema: ScreenSchema,
    }),
  update: (
    id: string,
    body: {
      name?: string;
      layout?: ScreenLayout;
      ephemeral?: boolean;
      pinned?: boolean;
    },
  ) =>
    api(`/api/screens/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: ScreenSchema,
    }),
  remove: (id: string) => api<void>(`/api/screens/${id}`, { method: "DELETE" }),
};

export const agentAccess = {
  get: (agentId: string) =>
    api(`/api/agents/${agentId}/access`, {
      method: "GET",
      schema: AgentAccessSchema,
    }),
  update: (agentId: string, body: { skill_ids?: string[] }) =>
    api(`/api/agents/${agentId}/access`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: AgentAccessSchema,
    }),
};

export { API_URL };
