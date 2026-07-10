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

export const AgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable().default(null),
  tmux_session: z.string().nullable().default(null),
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

export const AgentInputResultSchema = z.object({
  agent_id: z.string().uuid(),
  bytes: z.number().int(),
});
export type AgentInputResult = z.infer<typeof AgentInputResultSchema>;

export const AgentResizeResultSchema = z.object({
  agent_id: z.string().uuid(),
  cols: z.number().int(),
  rows: z.number().int(),
});
export type AgentResizeResult = z.infer<typeof AgentResizeResultSchema>;

export const AgentScrollResultSchema = z.object({
  agent_id: z.string().uuid(),
  lines: z.number().int(),
});
export type AgentScrollResult = z.infer<typeof AgentScrollResultSchema>;

export const AgentRedrawResultSchema = z.object({
  agent_id: z.string().uuid(),
  redraw: z.boolean(),
});
export type AgentRedrawResult = z.infer<typeof AgentRedrawResultSchema>;

export const AgentSnapshotSchema = z.object({
  agent_id: z.string().uuid(),
  bytes_b64: z.string(),
  plain: z.boolean(),
  lines: z.number().int(),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;

export const AgentUploadResultSchema = z.object({
  agent_id: z.string().uuid(),
  path: z.string(),
  client_id: z.string(),
  pasted: z.boolean(),
});
export type AgentUploadResult = z.infer<typeof AgentUploadResultSchema>;

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
  verification_uri: z.string(),
  interval: z.number(),
  expires_in: z.number(),
});

export const DeviceApproveResponseSchema = z.object({
  host_name: z.string(),
});

export const AuthProviderSchema = z.object({
  id: z.enum(["google", "microsoft", "github"]),
  name: z.string(),
});
export type AuthProvider = z.infer<typeof AuthProviderSchema>;

export const AuthProviderListSchema = z.object({
  providers: z.array(AuthProviderSchema).default([]),
});
export type AuthProviderList = z.infer<typeof AuthProviderListSchema>;

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
    skill_ids?: string[];
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
  input: (id: string, body: { text?: string; bytes_b64?: string }) =>
    api(`/api/agents/${id}/input`, {
      method: "POST",
      body: JSON.stringify(body),
      schema: AgentInputResultSchema,
    }),
  resize: (id: string, body: { cols: number; rows: number }) =>
    api(`/api/agents/${id}/resize`, {
      method: "POST",
      body: JSON.stringify(body),
      schema: AgentResizeResultSchema,
    }),
  scroll: (id: string, body: { lines: number }) =>
    api(`/api/agents/${id}/scroll`, {
      method: "POST",
      body: JSON.stringify(body),
      schema: AgentScrollResultSchema,
    }),
  redraw: (id: string) =>
    api(`/api/agents/${id}/redraw`, {
      method: "POST",
      schema: AgentRedrawResultSchema,
    }),
  snapshot: (id: string, body?: { lines?: number; plain?: boolean }) =>
    api(`/api/agents/${id}/snapshot`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      schema: AgentSnapshotSchema,
    }),
  upload: (
    id: string,
    body: {
      name?: string;
      mime_type?: string;
      bytes_b64: string;
      paste?: boolean;
      destination?: "cwd" | null;
      client_id?: string;
    },
  ) =>
    api(`/api/agents/${id}/upload`, {
      method: "POST",
      body: JSON.stringify(body),
      schema: AgentUploadResultSchema,
    }),
  uploadFile: async (
    id: string,
    file: File,
    options?: { paste?: boolean; destination?: "cwd"; client_id?: string },
  ) => {
    const body = new FormData();
    body.set("file", file);
    if (options?.paste !== undefined) body.set("paste", String(options.paste));
    if (options?.destination) body.set("destination", options.destination);
    if (options?.client_id) body.set("client_id", options.client_id);
    const res = await fetch(`${API_URL}/api/agents/${id}/upload-file`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
      body,
    });
    if (!res.ok) {
      let payload: { detail?: unknown; message?: string; code?: string } | undefined;
      try {
        payload = await res.json();
      } catch {
        // ignore
      }
      const detailMsg = typeof payload?.detail === "string" ? payload.detail : undefined;
      throw new ApiError(
        res.status,
        payload?.code ?? `http_${res.status}`,
        payload?.message ?? detailMsg ?? res.statusText,
        payload?.detail,
      );
    }
    return AgentUploadResultSchema.parse(await res.json());
  },
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
  create: (body: { name: string; layout?: ScreenLayout }) =>
    api("/api/screens", {
      method: "POST",
      body: JSON.stringify(body),
      schema: ScreenSchema,
    }),
  update: (id: string, body: { name?: string; layout?: ScreenLayout }) =>
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
