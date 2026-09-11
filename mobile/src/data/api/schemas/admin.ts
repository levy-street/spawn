import { z } from "zod";
import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const AdminUserOutSchema = z.object({
  id: UUIDSchema,
  email: z.string(),
  created_at: IsoDateTimeSchema,
  email_verified_at: IsoDateTimeSchema.nullable(),
  is_admin: z.boolean(),
  host_count: z.number().int().nonnegative(),
  session_count: z.number().int().nonnegative(),
  browser_device_count: z.number().int().nonnegative(),
});
export const AdminInviteCreateSchema = z.object({
  email: z.string().email().nullable().optional(),
  ttl_hours: z.number().int().min(1).max(720).nullable().optional(),
});
export const InviteStateSchema = z.enum(["pending", "used", "expired", "revoked"]);
export const AdminInviteOutSchema = z.object({
  id: UUIDSchema,
  email: z.string().nullable(),
  state: InviteStateSchema,
  expires_at: IsoDateTimeSchema,
  created_at: IsoDateTimeSchema,
  used_at: IsoDateTimeSchema.nullable(),
  created_by_user_id: UUIDSchema.nullable(),
  used_by_user_id: UUIDSchema.nullable(),
  url: z.string().nullable(),
});
export const AdminWaitlistInviteSchema = z.object({
  ttl_hours: z.number().int().min(1).max(720).nullable().optional(),
});
export const AdminWaitlistEntryOutSchema = z.object({
  id: UUIDSchema,
  email: z.string(),
  source: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  invited_at: IsoDateTimeSchema.nullable(),
  invite_id: UUIDSchema.nullable(),
  // The state of the invite minted for this entry, when there is one.
  invite_state: InviteStateSchema.nullable(),
  // Whether an account now exists for the address, however it got in.
  has_account: z.boolean(),
});
export const AdminMailStatusSchema = z.object({
  backend: z.string(),
  delivering: z.boolean(),
  from_address: z.string(),
  smtp_host: z.string().nullable(),
});
export const AdminEmailStatusSchema = z.enum(["sent", "failed", "not_delivered"]);
export const AdminEmailOutSchema = z.object({
  id: UUIDSchema,
  to_email: z.string(),
  subject: z.string(),
  kind: z.string(),
  status: AdminEmailStatusSchema,
  error: z.string().nullable(),
  body_redacted: z.string(),
  created_at: IsoDateTimeSchema,
});
export const AdminTestEmailSchema = z.object({
  to: z.string().email().nullable().optional(),
});

export type AdminUserOut = z.infer<typeof AdminUserOutSchema>;
export type AdminInviteCreate = z.infer<typeof AdminInviteCreateSchema>;
export type InviteState = z.infer<typeof InviteStateSchema>;
export type AdminInviteOut = z.infer<typeof AdminInviteOutSchema>;
export type AdminWaitlistInvite = z.infer<typeof AdminWaitlistInviteSchema>;
export type AdminWaitlistEntryOut = z.infer<typeof AdminWaitlistEntryOutSchema>;
export type AdminMailStatus = z.infer<typeof AdminMailStatusSchema>;
export type AdminEmailStatus = z.infer<typeof AdminEmailStatusSchema>;
export type AdminEmailOut = z.infer<typeof AdminEmailOutSchema>;
export type AdminTestEmail = z.infer<typeof AdminTestEmailSchema>;
