import { z } from "zod";
import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const HostUpdateStateSchema = z.enum([
  "current",
  "available",
  "updating",
  "failed",
  "unsupported",
  "unknown",
]);
export const HostUpdateOutSchema = z.object({
  state: HostUpdateStateSchema,
  latest_version: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  requested_at: IsoDateTimeSchema.nullable().default(null),
});
export const HostUpdateResponseSchema = z.object({ update: HostUpdateOutSchema });
export const HostDisconnectSchema = z.object({
  at: IsoDateTimeSchema.nullable(),
  reason: z
    .enum([
      "socket_closed",
      "superseded",
      "keepalive_timeout",
      "auth_rejected",
      "server_restart",
      "stale",
    ])
    .nullable(),
});

export const HostOutSchema = z.object({
  id: UUIDSchema,
  name: z.string(),
  os: z.string().nullable(),
  arch: z.string().nullable(),
  version: z.string().nullable(),
  daemon_tree: z.string().nullable().default(null),
  update: HostUpdateOutSchema.nullable().default(null),
  host_key_algorithm: z.literal("ed25519").nullable(),
  // The key travels alone (mesh B5): any fingerprint shown or compared is
  // derived locally from it, never read off a server response.
  host_public_key: z.string().nullable(),
  status: z.string(),
  last_seen_at: IsoDateTimeSchema.nullable(),
  last_disconnect: HostDisconnectSchema.optional(),
  session_count: z.number().int().nonnegative(),
  // Mesh R9: chain-capable hosts refuse the legacy per-host endorsement path,
  // and this app cannot join an account chain yet — so for these hosts the
  // possessing the host from this phone is the only admission, and the UI must say so.
  supports_account_chains: z.boolean().default(false),
  cpu_cores: z.number().int().nullable(),
  cpu_physical_cores: z.number().int().nullable(),
  cpu_model: z.string().nullable(),
  memory_bytes: z.number().int().nullable(),
  gpu: z.string().nullable(),
  cpu_bucket: z.number().int().min(0).max(5).nullable(),
  mem_bucket: z.number().int().min(0).max(5).nullable(),
  capacity_at: IsoDateTimeSchema.nullable(),
});
export const HostPatchSchema = z.object({ name: z.string().max(128).nullable().optional() });
export const HostAgentTargetSchema = z.object({
  agent_id: UUIDSchema,
  agent_name: z.string(),
  agent_kind: z.string(),
  command: z.string(),
  install: z.string().nullable(),
});
export const HostAgentStatusSchema = HostAgentTargetSchema.extend({
  installed: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  latest_version: z.string().nullable(),
  update_available: z.boolean().nullable(),
  error: z.string().nullable(),
  auto_update: z.boolean(),
  last_checked_at: IsoDateTimeSchema.nullable(),
  last_auto_update_at: IsoDateTimeSchema.nullable(),
  last_auto_update_error: z.string().nullable(),
});
export const HostAgentListSchema = z.object({ agents: z.array(HostAgentStatusSchema) });
export const HostAgentInstallResultSchema = HostAgentTargetSchema.extend({
  success: z.boolean(),
  exit_code: z.number().int().nullable(),
  output: z.string(),
  error: z.string().nullable(),
  status: HostAgentStatusSchema.nullable(),
});
export const HostAgentPolicyPatchSchema = z.object({
  auto_update: z.boolean().nullable().optional(),
});
export const HostAgentPolicyOutSchema = z.object({
  agent_id: UUIDSchema,
  auto_update: z.boolean(),
  last_checked_at: IsoDateTimeSchema.nullable(),
  last_auto_update_at: IsoDateTimeSchema.nullable(),
  last_auto_update_error: z.string().nullable(),
});
export const RecentDirOutSchema = z.object({
  path: z.string(),
  last_used_at: IsoDateTimeSchema,
});
export const RecentDirListSchema = z.object({ dirs: z.array(RecentDirOutSchema) });

export type HostOut = z.infer<typeof HostOutSchema>;
export type HostUpdateOut = z.infer<typeof HostUpdateOutSchema>;
export type HostUpdateResponse = z.infer<typeof HostUpdateResponseSchema>;
export type HostPatch = z.infer<typeof HostPatchSchema>;
export type HostAgentTarget = z.infer<typeof HostAgentTargetSchema>;
export type HostAgentStatus = z.infer<typeof HostAgentStatusSchema>;
export type HostAgentList = z.infer<typeof HostAgentListSchema>;
export type HostAgentInstallResult = z.infer<typeof HostAgentInstallResultSchema>;
export type HostAgentPolicyPatch = z.infer<typeof HostAgentPolicyPatchSchema>;
export type HostAgentPolicyOut = z.infer<typeof HostAgentPolicyOutSchema>;
export type RecentDirOut = z.infer<typeof RecentDirOutSchema>;
export type RecentDirList = z.infer<typeof RecentDirListSchema>;
