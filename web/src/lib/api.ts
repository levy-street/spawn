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
const CSRF_COOKIE = "spawn_csrf";

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
  const csrfToken = csrfHeader(rest.method);
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfToken,
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

function csrfHeader(method: string | undefined): Record<string, string> {
  const normalized = (method ?? "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(normalized)) return {};
  const token = readCookie(CSRF_COOKIE);
  return token ? { "X-CSRF-Token": token } : {};
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) return decodeURIComponent(cookie.slice(prefix.length));
  }
  return null;
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
  status: z.enum(["online", "offline"]),
  last_seen_at: z.string().nullable(),
  agent_count: z.number().int(),
  home_dir: z.string().nullable().optional(),
});
export type Host = z.infer<typeof HostSchema>;

export const HostDirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
});
export type HostDirEntry = z.infer<typeof HostDirEntrySchema>;

export const HostDirListSchema = z.object({
  path: z.string(),
  home_dir: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
  entries: z.array(HostDirEntrySchema).default([]),
  error: z.string().nullable().optional(),
});
export type HostDirList = z.infer<typeof HostDirListSchema>;

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

export const HostDaemonStatusSchema = z.object({
  status: z.string().default("online"),
  agents: z
    .array(
      z.object({
        agent_id: z.string(),
        pid: z.string().nullable().optional(),
      }),
    )
    .default([]),
  update: z
    .object({
      ok: z.boolean().default(true),
      clean: z.boolean().nullable().optional(),
      changes: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type HostDaemonStatus = z.infer<typeof HostDaemonStatusSchema>;

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

export const AuthResponseSchema = z.object({
  access_token: z.string(),
  user: UserSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const DeviceStartResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  interval: z.number(),
  expires_in: z.number(),
});

export const DeviceApproveResponseSchema = z.object({
  host_name: z.string(),
});

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
  approveDevice: (body: { user_code: string }) =>
    api("/api/auth/device/approve", {
      method: "POST",
      body: JSON.stringify(body),
      schema: DeviceApproveResponseSchema,
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
  dirs: (id: string, path?: string) => {
    const search = new URLSearchParams();
    if (path) search.set("path", path);
    const qs = search.size ? `?${search.toString()}` : "";
    return api(`/api/hosts/${id}/dirs${qs}`, {
      method: "GET",
      schema: HostDirListSchema,
    });
  },
  tools: (id: string) =>
    api(`/api/hosts/${id}/tools`, {
      method: "GET",
      schema: HostToolListSchema,
    }),
  daemonStatus: (id: string) =>
    api(`/api/hosts/${id}/daemon`, {
      method: "GET",
      schema: HostDaemonStatusSchema,
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
    cols?: number;
    rows?: number;
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
  restart: (id: string, body?: { cols?: number; rows?: number; create_cwd?: boolean }) =>
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

export { API_URL };
