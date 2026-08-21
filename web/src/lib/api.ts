import { z } from "zod";
import type { GridLayout, Tile, TileWidget } from "@/lib/grid";
import type { LayoutV3, WorkspaceTab } from "@/lib/tabs";

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
  host_public_key: z.string().nullable().optional(),
  host_key_fingerprint: z.string().nullable().optional(),
  status: z.enum(["online", "offline"]),
  last_seen_at: z.string().nullable(),
  session_count: z.number().int(),
  /* Capacity. Every field is nullable and stays null for a daemon that
   * predates telemetry or runs with SPAWND_NO_TELEMETRY — the strip draws no
   * meter at all rather than an empty one, which says something different.
   * `cpu_bucket`/`mem_bucket` are meter segment counts in 0..5, never
   * percentages: the exact figures come from the host over `spawn.host.ctl`
   * and deliberately have no server code path (docs/TRUST.md). */
  cpu_cores: z.number().int().nullable().default(null),
  cpu_physical_cores: z.number().int().nullable().default(null),
  cpu_model: z.string().nullable().default(null),
  memory_bytes: z.number().int().nullable().default(null),
  gpu: z.string().nullable().default(null),
  cpu_bucket: z.number().int().min(0).max(5).nullable().default(null),
  mem_bucket: z.number().int().min(0).max(5).nullable().default(null),
  capacity_at: z.string().nullable().default(null),
});
export type Host = z.infer<typeof HostSchema>;

/** One UTC day of fleet activity. Sparse — quiet days are simply absent. */
export const LegionDaySchema = z.object({
  day: z.string(),
  sessions_started: z.number().int().default(0),
  session_seconds: z.number().int().default(0),
  peak_sessions: z.number().int().default(0),
  peak_hosts_online: z.number().int().default(0),
});
export type LegionDay = z.infer<typeof LegionDaySchema>;

export const LegionTotalsSchema = z.object({
  hosts: z.number().int().default(0),
  hosts_online: z.number().int().default(0),
  cores: z.number().int().default(0),
  memory_bytes: z.number().int().default(0),
  sessions_live: z.number().int().default(0),
  sessions_started: z.number().int().default(0),
  session_seconds: z.number().int().default(0),
  active_days: z.number().int().default(0),
  current_streak: z.number().int().default(0),
  longest_streak: z.number().int().default(0),
  peak_hosts_online: z.number().int().default(0),
  peak_sessions: z.number().int().default(0),
  first_day: z.string().nullable().default(null),
});
export type LegionTotals = z.infer<typeof LegionTotalsSchema>;

/** A foreground executable basename and how often it has been seen. */
export const LegionAgentSchema = z.object({
  command: z.string(),
  count: z.number().int(),
});
export type LegionAgent = z.infer<typeof LegionAgentSchema>;

export const LegionHostSchema = z.object({
  id: z.string(),
  name: z.string(),
  os: z.string().nullable().default(null),
  status: z.string(),
  cpu_cores: z.number().int().nullable().default(null),
  memory_bytes: z.number().int().nullable().default(null),
  gpu: z.string().nullable().default(null),
  session_count: z.number().int().default(0),
  created_at: z.string().nullable().default(null),
  last_seen_at: z.string().nullable().default(null),
});
export type LegionHost = z.infer<typeof LegionHostSchema>;

/** Everything the profile dialog draws (`GET /api/profile`). */
export const ProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  created_at: z.string(),
  email_verified_at: z.string().nullable().default(null),
  is_admin: z.boolean().default(false),
  totals: LegionTotalsSchema,
  agents: z.array(LegionAgentSchema).default([]),
  days: z.array(LegionDaySchema).default([]),
  hosts: z.array(LegionHostSchema).default([]),
  history_days: z.number().int(),
  /* The server's UTC day. The calendar is densified against this rather than
   * the browser's clock, so a viewer in UTC+13 colours the squares the streak
   * counter actually counted. */
  today: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Availability of one agent definition on one host (`GET /api/hosts/{id}/agents`). */
export const HostAgentStatusSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
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
export type HostAgentStatus = z.infer<typeof HostAgentStatusSchema>;

export const HostAgentListSchema = z.object({
  agents: z.array(HostAgentStatusSchema).default([]),
});
export type HostAgentList = z.infer<typeof HostAgentListSchema>;

export const HostAgentInstallResultSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  agent_kind: z.string(),
  command: z.string(),
  install: z.string().nullable().optional(),
  success: z.boolean(),
  exit_code: z.number().int().nullable().optional(),
  output: z.string().default(""),
  error: z.string().nullable().optional(),
  status: HostAgentStatusSchema.nullable().optional(),
});
export type HostAgentInstallResult = z.infer<typeof HostAgentInstallResultSchema>;

export const HostAgentPolicySchema = z.object({
  agent_id: z.string(),
  auto_update: z.boolean().default(false),
  last_checked_at: z.string().nullable().optional(),
  last_auto_update_at: z.string().nullable().optional(),
  last_auto_update_error: z.string().nullable().optional(),
});
export type HostAgentPolicy = z.infer<typeof HostAgentPolicySchema>;

export const RecentDirSchema = z.object({
  path: z.string(),
  last_used_at: z.string(),
});
export type RecentDir = z.infer<typeof RecentDirSchema>;

export const RecentDirsSchema = z.object({
  dirs: z.array(RecentDirSchema).default([]),
});
export type RecentDirs = z.infer<typeof RecentDirsSchema>;

/** A PTY on a host. Always the user's login shell in a chosen directory. */
export const SessionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable().default(null),
  host_id: z.string().uuid(),
  host_name: z.string().nullable().default(null),
  cwd: z.string(),
  status: z.enum(["starting", "running", "exited", "killed"]),
  started_at: z.string(),
  exited_at: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  last_output_at: z.string().nullable().default(null),
  last_input_at: z.string().nullable().default(null),
  last_activity_at: z.string().nullable().default(null),
  activity_state: z
    .enum(["starting", "active", "quiet", "waiting", "input_sent", "exited", "killed", "unknown"])
    .default("unknown"),
  activity_label: z.string().default("Unknown"),
  /** Basename of the foreground process, reported by the daemon; null until
   * the worker reports one (old workers never do). */
  foreground_command: z.string().nullable().default(null),
});
export type Session = z.infer<typeof SessionSchema>;

/** A launchable CLI tool definition — a shortcut, not a process. */
export const AgentSchema = z.object({
  id: z.string().uuid(),
  /** null = built-in (immutable). */
  owner_user_id: z.string().uuid().nullable(),
  name: z.string(),
  kind: z.string(),
  command: z.string(),
  env: z.record(z.string(), z.string()).default({}),
  install: z.string().nullable().optional(),
  /* How this CLI is told to stop asking permission ("yolo mode"): arguments
   * appended to `command`, environment merged over `env`, or both. Every tool
   * spells it differently and one (opencode) has no flag at all, so the
   * definition carries the spelling. Both empty = no such mode. */
  yolo_args: z.string().nullable().default(null),
  yolo_env: z.record(z.string(), z.string()).default({}),
  /** The signed-in user's own choice, not a property of the definition —
   *  built-ins are shared rows, and one account's yolo is not another's. */
  yolo: z.boolean().default(false),
});
export type Agent = z.infer<typeof AgentSchema>;

export interface AgentCreateInput {
  name: string;
  kind: string;
  command: string;
  env?: Record<string, string>;
  install?: string | null;
  yolo_args?: string | null;
  yolo_env?: Record<string, string>;
}

export type AgentUpdateInput = Partial<AgentCreateInput>;

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

export const SessionAccessSchema = z.object({
  session_id: z.string().uuid(),
  skills: z.array(SkillSchema).default([]),
});
export type SessionAccess = z.infer<typeof SessionAccessSchema>;

/** Grid layout v2 (§4.4): a 12×12 canvas of non-overlapping session tiles. */
export const TileWidgetSchema: z.ZodType<TileWidget> = z.object({
  kind: z.literal("files"),
  host_id: z.string().uuid(),
  path: z.string(),
});

export const TileSchema: z.ZodType<Tile> = z.object({
  session_id: z.string().uuid(),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
  widget: TileWidgetSchema.optional(),
});

export const GridLayoutSchema: z.ZodType<GridLayout> = z.object({
  version: z.literal(3),
  tiles: z.array(TileSchema),
});

/** Layout v3 (§4.4-tabs): ordered named tabs, each wrapping one tile grid. */
export const WorkspaceTabSchema: z.ZodType<WorkspaceTab> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The tab's own home: where a window added to this tab opens. Null (the
   *  pair moves together) inherits the workspace's. */
  host_id: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
  layout: GridLayoutSchema,
});

export const LayoutV3Schema: z.ZodType<LayoutV3> = z.object({
  version: z.literal(3),
  active_tab: z.string().nullable().default(null),
  tabs: z.array(WorkspaceTabSchema).min(1),
});

export const WorkspaceIconSourceSchema = z
  .enum(["auto", "custom", "none"])
  .nullable()
  .default(null);
export type WorkspaceIconSource = z.infer<typeof WorkspaceIconSourceSchema>;

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** The workspace's home: host and folder chosen at creation; new sessions
   *  default here so the folder is picked once. */
  host_id: z.string().uuid().nullable().default(null),
  cwd: z.string().nullable().default(null),
  layout: LayoutV3Schema,
  position: z.number().int().default(0),
  /** The workspace's mark: a small square raster as a self-contained data URL,
   *  found in its folder or chosen by its owner. Null draws the initials. */
  icon: z.string().nullable().default(null),
  /** Whether the mark is settled. Null means nobody has looked yet, which is
   *  what makes the browser scan the folder when the workspace opens. */
  icon_source: WorkspaceIconSourceSchema,
  /** Set -> the workspace is put away: out of the sidebar's list, and every
   *  session in it stopped. The layout is untouched — an archived workspace
   *  still names the same windows, they are simply not running. */
  archived_at: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceCreateResultSchema = z.object({
  workspace: WorkspaceSchema,
  session: SessionSchema.nullable().default(null),
});
export type WorkspaceCreateResult = z.infer<typeof WorkspaceCreateResultSchema>;

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

/** `GET /api/auth/config` — everything the auth/onboarding UI must know. */
export const AuthConfigSchema = z.object({
  providers: z.array(AuthProviderSchema).default([]),
  /** True only when the server actually enforces verification (mailer ready). */
  email_verification_required: z.boolean().default(false),
  invite_only: z.boolean().default(false),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

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
  config: () =>
    api("/api/auth/config", {
      method: "GET",
      schema: AuthConfigSchema,
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
  /** Availability of every agent definition on this host. */
  agents: (id: string) =>
    api(`/api/hosts/${id}/agents`, {
      method: "GET",
      schema: HostAgentListSchema,
    }),
  installAgent: (id: string, agentId: string) =>
    api(`/api/hosts/${id}/agents/${agentId}/install`, {
      method: "POST",
      schema: HostAgentInstallResultSchema,
    }),
  updateAgentPolicy: (id: string, agentId: string, body: { auto_update?: boolean }) =>
    api(`/api/hosts/${id}/agents/${agentId}/policy`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: HostAgentPolicySchema,
    }),
  /** Recently used session directories on this host, newest first (max 8). */
  recentDirs: (id: string) =>
    api(`/api/hosts/${id}/recent-dirs`, {
      method: "GET",
      schema: RecentDirsSchema,
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

export const AdminUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  created_at: z.string(),
  email_verified_at: z.string().nullable().default(null),
  is_admin: z.boolean().default(false),
  host_count: z.number().int().default(0),
  session_count: z.number().int().default(0),
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

export const profile = {
  get: () => api("/api/profile", { method: "GET", schema: ProfileSchema }),
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

export const sessions = {
  list: (params?: { host_id?: string }) => {
    const search = new URLSearchParams();
    if (params?.host_id) search.set("host_id", params.host_id);
    const qs = search.size ? `?${search.toString()}` : "";
    return api(`/api/sessions${qs}`, {
      method: "GET",
      schema: z.array(SessionSchema),
    });
  },
  get: (id: string) =>
    api(`/api/sessions/${id}`, {
      method: "GET",
      schema: SessionSchema,
    }),
  /**
   * The daemon always spawns the login shell in `cwd` — no argv/env here.
   * `workspace_id` transactionally appends a tile to that workspace; omit
   * `tile` to let the server auto-place (§4.4).
   */
  create: (body: {
    host_id: string;
    cwd: string;
    name?: string;
    skill_ids?: string[];
    workspace_id?: string;
    tile?: { x: number; y: number; w: number; h: number };
  }) =>
    api("/api/sessions", {
      method: "POST",
      body: JSON.stringify(body),
      schema: SessionSchema,
    }),
  update: (id: string, body: { name?: string | null }) =>
    api(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: SessionSchema,
    }),
  rename: (id: string, name: string | null) => sessions.update(id, { name }),
  /** Respawns the shell in the session's cwd. */
  restart: (id: string) =>
    api(`/api/sessions/${id}/restart`, {
      method: "POST",
      body: JSON.stringify({}),
      schema: SessionSchema,
    }),
  /** Kill + hard delete. */
  remove: (id: string) => api<void>(`/api/sessions/${id}`, { method: "DELETE" }),
};

export const sessionAccess = {
  get: (sessionId: string) =>
    api(`/api/sessions/${sessionId}/access`, {
      method: "GET",
      schema: SessionAccessSchema,
    }),
  update: (sessionId: string, body: { skill_ids?: string[] }) =>
    api(`/api/sessions/${sessionId}/access`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: SessionAccessSchema,
    }),
};

/** A template tile's payload: what it launches when instantiated. */
export const TemplateRunSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell"), command: z.null().optional() }),
  z.object({ kind: z.literal("agent"), command: z.string().min(1) }),
  z.object({ kind: z.literal("files"), command: z.null().optional() }),
]);
export type TemplateRun = z.infer<typeof TemplateRunSchema>;

export const TemplateTileSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
  run: TemplateRunSchema,
});
export type TemplateTile = z.infer<typeof TemplateTileSchema>;

export const WorkspaceTemplateSpecSchema = z.object({
  version: z.literal(2),
  tabs: z
    .array(z.object({ name: z.string(), tiles: z.array(TemplateTileSchema).default([]) }))
    .min(1)
    .max(8),
});
export type WorkspaceTemplateSpec = z.infer<typeof WorkspaceTemplateSpecSchema>;

export const WorkspaceTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** The folder the template remembers; instantiation goes straight there. */
  host_id: z.string().uuid().nullable().default(null),
  cwd: z.string().nullable().default(null),
  spec: WorkspaceTemplateSpecSchema,
  /** The mark the saved workspace was wearing: a small square raster as a self-contained data URL,
   *  found in its folder or chosen by its owner. Null draws the initials. */
  icon: z.string().nullable().default(null),
  /** Whether the mark is settled. Null means nobody has looked yet, which is
   *  what makes the browser scan the folder when the workspace opens. */
  icon_source: WorkspaceIconSourceSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type WorkspaceTemplate = z.infer<typeof WorkspaceTemplateSchema>;

export const workspaces = {
  /** Active workspaces ordered by `position`; `{archived: true}` returns the
   *  archived ones instead, most recently archived first. The two never mix. */
  list: (params?: { archived?: boolean }) => {
    const qs = params?.archived ? "?archived=true" : "";
    return api(`/api/workspaces${qs}`, {
      method: "GET",
      schema: z.array(WorkspaceSchema),
    });
  },
  get: (id: string) =>
    api(`/api/workspaces/${id}`, {
      method: "GET",
      schema: WorkspaceSchema,
    }),
  /**
   * `first_session` atomically creates the workspace plus one full-canvas
   * shell. Pass `host_id`/`cwd` instead to create it empty but homed — the
   * tab opens on its empty state and panes added later start in that folder.
   */
  create: (body?: {
    name?: string;
    first_session?: { host_id: string; cwd: string; skill_ids?: string[] };
    host_id?: string;
    cwd?: string;
    icon?: string | null;
    icon_source?: WorkspaceIconSource;
  }) =>
    api("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      schema: WorkspaceCreateResultSchema,
    }),
  update: (
    id: string,
    body: {
      name?: string;
      layout?: LayoutV3;
      position?: number;
      host_id?: string;
      cwd?: string;
      /** Present clears or sets the mark; absent leaves it. */
      icon?: string | null;
      icon_source?: WorkspaceIconSource;
    },
  ) =>
    api(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: WorkspaceSchema,
    }),
  /**
   * Put the workspace away: its shape (tabs, tile geometry, each pane's
   * host/folder/skills) is captured, then its sessions are killed. Reversible
   * via `unarchive` — unlike `remove`, which keeps nothing.
   */
  archive: (id: string) =>
    api(`/api/workspaces/${id}/archive`, { method: "POST", schema: WorkspaceSchema }),
  /**
   * Bring it back: every window restarts where it stopped, under the same id,
   * and the workspace returns to the sidebar slot it left from. A window whose
   * host is offline stays stopped and can be started from its own window.
   */
  unarchive: (id: string) =>
    api(`/api/workspaces/${id}/unarchive`, { method: "POST", schema: WorkspaceSchema }),
  /** Kills and deletes every session referenced by its tiles. Confirm first. */
  remove: (id: string) => api<void>(`/api/workspaces/${id}`, { method: "DELETE" }),
};

export const workspaceTemplates = {
  /** Ordered by name. */
  list: () =>
    api("/api/workspace-templates", {
      method: "GET",
      schema: z.array(WorkspaceTemplateSchema),
    }),
  create: (body: {
    name: string;
    host_id?: string;
    cwd?: string;
    spec: WorkspaceTemplateSpec;
    icon?: string | null;
    icon_source?: WorkspaceIconSource;
  }) =>
    api("/api/workspace-templates", {
      method: "POST",
      body: JSON.stringify(body),
      schema: WorkspaceTemplateSchema,
    }),
  update: (
    id: string,
    body: {
      name?: string;
      host_id?: string;
      cwd?: string;
      spec?: WorkspaceTemplateSpec;
      icon?: string | null;
      icon_source?: WorkspaceIconSource;
    },
  ) =>
    api(`/api/workspace-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: WorkspaceTemplateSchema,
    }),
  remove: (id: string) => api<void>(`/api/workspace-templates/${id}`, { method: "DELETE" }),
};

export const agents = {
  list: () =>
    api("/api/agents", {
      method: "GET",
      schema: z.array(AgentSchema),
    }),
  create: (body: AgentCreateInput) =>
    api("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
      schema: AgentSchema,
    }),
  update: (id: string, body: AgentUpdateInput) =>
    api(`/api/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: AgentSchema,
    }),
  remove: (id: string) => api<void>(`/api/agents/${id}`, { method: "DELETE" }),
  /** The caller's own settings for an agent. Accepts built-ins, which the
   *  definition PATCH above refuses: the row written is this user's. */
  setPreferences: (id: string, body: { yolo?: boolean }) =>
    api(`/api/agents/${id}/preferences`, {
      method: "PATCH",
      body: JSON.stringify(body),
      schema: AgentSchema,
    }),
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

export { API_URL };
