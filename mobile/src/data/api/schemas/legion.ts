import { z } from "zod";
import { IsoDateSchema, IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const LegionDayOutSchema = z.object({
  day: IsoDateSchema,
  sessions_started: z.number().int().nonnegative(),
  session_seconds: z.number().int().nonnegative(),
  peak_sessions: z.number().int().nonnegative(),
  peak_hosts_online: z.number().int().nonnegative(),
});
export const LegionAgentOutSchema = z.object({
  command: z.string(),
  count: z.number().int().nonnegative(),
});
export const LegionTotalsOutSchema = z.object({
  hosts: z.number().int().nonnegative(),
  hosts_online: z.number().int().nonnegative(),
  cores: z.number().int().nonnegative(),
  memory_bytes: z.number().int().nonnegative(),
  sessions_live: z.number().int().nonnegative(),
  sessions_started: z.number().int().nonnegative(),
  session_seconds: z.number().int().nonnegative(),
  active_days: z.number().int().nonnegative(),
  current_streak: z.number().int().nonnegative(),
  longest_streak: z.number().int().nonnegative(),
  peak_hosts_online: z.number().int().nonnegative(),
  peak_sessions: z.number().int().nonnegative(),
  first_day: IsoDateSchema.nullable(),
});
export const LegionHostOutSchema = z.object({
  id: UUIDSchema,
  name: z.string(),
  os: z.string().nullable(),
  status: z.string(),
  cpu_cores: z.number().int().nullable(),
  memory_bytes: z.number().int().nullable(),
  gpu: z.string().nullable(),
  session_count: z.number().int().nonnegative(),
  created_at: IsoDateTimeSchema.nullable(),
  last_seen_at: IsoDateTimeSchema.nullable(),
});
export const ProfileOutSchema = z.object({
  id: UUIDSchema,
  email: z.string(),
  created_at: IsoDateTimeSchema,
  email_verified_at: IsoDateTimeSchema.nullable(),
  is_admin: z.boolean(),
  totals: LegionTotalsOutSchema,
  agents: z.array(LegionAgentOutSchema),
  days: z.array(LegionDayOutSchema),
  hosts: z.array(LegionHostOutSchema),
  history_days: z.number().int().positive(),
  today: IsoDateSchema,
});

export type LegionDayOut = z.infer<typeof LegionDayOutSchema>;
export type LegionAgentOut = z.infer<typeof LegionAgentOutSchema>;
export type LegionTotalsOut = z.infer<typeof LegionTotalsOutSchema>;
export type LegionHostOut = z.infer<typeof LegionHostOutSchema>;
export type ProfileOut = z.infer<typeof ProfileOutSchema>;
