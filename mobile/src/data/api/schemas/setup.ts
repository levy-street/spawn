import { z } from "zod";

import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const SetupClaimErrorSchema = z.enum([
  "expired",
  "denied",
  "key_conflict",
  "pin_conflict",
  "pin_limit",
]);

export const SetupClaimCreateResponseSchema = z.object({
  token: z.string().length(43),
  expires_in: z.number().int().positive(),
  expires_at: IsoDateTimeSchema,
});

export const SetupClaimStatusSchema = z.object({
  status: z.enum(["pending", "ready", "approved", "failed"]),
  approval_ref: z.string().nullable(),
  host_name: z.string().nullable(),
  os: z.string().nullable(),
  host_key_fingerprint: z.string().nullable(),
  host_id: UUIDSchema.nullable(),
  error: SetupClaimErrorSchema.nullable(),
  expires_at: IsoDateTimeSchema,
});

export type SetupClaimError = z.infer<typeof SetupClaimErrorSchema>;
export type SetupClaimCreateResponse = z.infer<typeof SetupClaimCreateResponseSchema>;
export type SetupClaimStatus = z.infer<typeof SetupClaimStatusSchema>;
