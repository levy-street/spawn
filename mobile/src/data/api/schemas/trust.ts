import { z } from "zod";
import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const TrustBundleOutSchema = z.object({
  sealed: z.string(),
  revision: z.number().int().positive(),
  updated_at: IsoDateTimeSchema,
});
export const TrustBundlePutSchema = z.object({
  sealed: z.string(),
  expected_revision: z.number().int().nullable().optional(),
});
export const PasskeyCredentialOutSchema = z.object({
  id: UUIDSchema,
  credential_id: z.string(),
  label: z.string().nullable(),
  created_at: IsoDateTimeSchema,
});
export const PasskeyCredentialCreateSchema = z.object({
  credential_id: z.string().min(1).max(512),
  label: z.string().max(128).nullable().optional(),
});
export const DeviceApprovalRequestCreateSchema = z.object({
  browser_device_id: UUIDSchema,
});
export const DeviceApprovalRequestOutSchema = z.object({
  id: UUIDSchema,
  browser_device_id: UUIDSchema,
  label: z.string().nullable(),
  /** Re-derived from the key before anything is signed; shown for comparison. */
  fingerprint: z.string(),
  status: z.string(),
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
});
export const BrowserEndorsementCreateSchema = z.object({
  host_id: UUIDSchema,
  endorser_device_id: UUIDSchema,
  endorsed_device_id: UUIDSchema,
  signature: z.string(),
});
export const BrowserEndorsementOutSchema = z.object({
  host_id: UUIDSchema,
  endorsed_device_id: UUIDSchema,
  endorsed_key_fingerprint: z.string(),
  endorser_device_id: UUIDSchema,
  created_at: IsoDateTimeSchema,
});
export const BrowserEndorsementRecordSchema = z.object({
  host_id: UUIDSchema,
  host_name: z.string(),
  host_public_key: z.string(),
  endorser_device_id: UUIDSchema,
  endorser_public_key: z.string(),
  endorser_label: z.string().nullable(),
  signature: z.string(),
});

export type TrustBundleOut = z.infer<typeof TrustBundleOutSchema>;
export type TrustBundlePut = z.infer<typeof TrustBundlePutSchema>;
export type PasskeyCredentialOut = z.infer<typeof PasskeyCredentialOutSchema>;
export type PasskeyCredentialCreate = z.infer<typeof PasskeyCredentialCreateSchema>;
export type BrowserEndorsementCreate = z.infer<typeof BrowserEndorsementCreateSchema>;
export type BrowserEndorsementOut = z.infer<typeof BrowserEndorsementOutSchema>;
export type BrowserEndorsementRecord = z.infer<typeof BrowserEndorsementRecordSchema>;
export type DeviceApprovalRequestCreate = z.infer<typeof DeviceApprovalRequestCreateSchema>;
export type DeviceApprovalRequestOut = z.infer<typeof DeviceApprovalRequestOutSchema>;
