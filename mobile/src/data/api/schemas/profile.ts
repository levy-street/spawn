import { z } from "zod";
import { IsoDateSchema, IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const ProfileDayOutSchema = z.object({
  day: IsoDateSchema,
  sessions_started: z.number().int().nonnegative(),
  session_seconds: z.number().int().nonnegative(),
  peak_sessions: z.number().int().nonnegative(),
  peak_hosts_online: z.number().int().nonnegative(),
});
export const ProfileAgentOutSchema = z.object({
  command: z.string(),
  count: z.number().int().nonnegative(),
});
export const ProfileTotalsOutSchema = z.object({
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
export const ProfileHostOutSchema = z.object({
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
  totals: ProfileTotalsOutSchema,
  agents: z.array(ProfileAgentOutSchema),
  days: z.array(ProfileDayOutSchema),
  hosts: z.array(ProfileHostOutSchema),
  history_days: z.number().int().positive(),
  today: IsoDateSchema,
});

export type ProfileDayOut = z.infer<typeof ProfileDayOutSchema>;
export type ProfileAgentOut = z.infer<typeof ProfileAgentOutSchema>;
export type ProfileTotalsOut = z.infer<typeof ProfileTotalsOutSchema>;
export type ProfileHostOut = z.infer<typeof ProfileHostOutSchema>;
export type ProfileOut = z.infer<typeof ProfileOutSchema>;
