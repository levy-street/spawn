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
});
export type User = z.infer<typeof UserSchema>;

export const HostSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  os: z.string().nullable().optional(),
  arch: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  host_key_algorithm: z.literal("ed25519").nullable().optional(),
  host_public_key: z.string().nullable().optional(),
  host_key_fingerprint: z.string().nullable().optional(),
  status: z.enum(["online", "offline"]),
  last_seen_at: z.string().nullable(),
  agent_count: z.number().int(),
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
});
export type DevicePendingApproval = z.infer<typeof DevicePendingResponseSchema>;

export const DeviceApproveResponseSchema = DevicePendingResponseSchema.extend({
  browser_device_id: z.string().uuid(),
  browser_key_algorithm: z.literal("ed25519"),
  browser_public_key: z.string().length(43),
  browser_key_fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9_-]{16}$/u),
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
  public_key: z.string().length(43),
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9_-]{16}$/u),
  /** Recognition only; never a trust input. See the server model. */
  label: z.string().nullable().default(null),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
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
  signup: (body: { email: string; password: string }) =>
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
    user_code: string;
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
  pendingDevice: (body: { user_code: string }) =>
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
  rename: (deviceId: string, label: string | null) =>
    api(`/api/browser-devices/${deviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ label }),
      schema: BrowserDeviceSchema,
    }),
  revoke: (deviceId: string, expectedPublicKey: string) =>
    api(`/api/browser-devices/${deviceId}/revoke`, {
      method: "POST",
      body: JSON.stringify({ expected_public_key: expectedPublicKey }),
      schema: BrowserDeviceSchema,
    }),
  /** Hard-deletes this account's revoked device tombstones. */
  prune: () =>
    api("/api/browser-devices/prune", {
      method: "POST",
      schema: z.object({ pruned: z.number().int() }),
    }),
};

export const account = {
  /** Permanently deletes the signed-in account and everything it owns. */
  remove: (body: { confirm_email: string; password?: string }) =>
    api<void>("/api/account/delete", { method: "POST", body: JSON.stringify(body) }),
};

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
        endorsed_key_fingerprint: z.string(),
        endorser_device_id: z.string(),
        created_at: z.string(),
      }),
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
