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
/**
 * Account-scoped endorsement (device mesh §3): one device vouching for
 * another's key for the whole account, no host in the transcript. Carried by
 * the endorsed device on every offer and re-verified by the daemon against its
 * own anchors, so nothing here is trusted as served.
 */
export const AccountEndorsementCreateSchema = z.object({
  endorser_device_id: UUIDSchema,
  endorsed_device_id: UUIDSchema,
  signature: z.string(),
});
export const AccountEndorsementOutSchema = z.object({
  id: UUIDSchema,
  endorser_device_id: UUIDSchema,
  endorsed_device_id: UUIDSchema,
  created_at: IsoDateTimeSchema,
});
export const AccountEndorsementRecordSchema = z.object({
  endorser_device_id: UUIDSchema,
  endorser_public_key: z.string(),
  endorsed_device_id: UUIDSchema,
  endorsed_public_key: z.string(),
  signature: z.string(),
  created_at: IsoDateTimeSchema,
});

export const HostPinUndeliveredReasonSchema = z.enum(["pin_limit", "invalid_chain", "other"]);
export const HostPinCapacitySchema = z.object({
  used: z.number().int().nonnegative(),
  max: z.number().int().positive(),
});
const HostPinDeliveryWireSchema = z
  .object({
    browser_device_id: UUIDSchema.optional(),
    device_id: UUIDSchema.optional(),
    delivered: z.boolean().default(true),
    undelivered_reason: HostPinUndeliveredReasonSchema.nullable().default(null),
  })
  .refine((pin) => pin.browser_device_id !== undefined || pin.device_id !== undefined)
  .transform((pin) => ({
    browser_device_id: pin.browser_device_id ?? pin.device_id ?? "",
    delivered: pin.delivered,
    undelivered_reason: pin.undelivered_reason,
  }));
const HostPinDeliverySchema = z
  .union([UUIDSchema, HostPinDeliveryWireSchema])
  .transform((pin) =>
    typeof pin === "string"
      ? { browser_device_id: pin, delivered: true, undelivered_reason: null }
      : pin,
  );
export const HostPinsOutSchema = z
  .union([
    z.array(UUIDSchema),
    z.object({
      pins: z.array(HostPinDeliverySchema),
      capacity: HostPinCapacitySchema,
    }),
  ])
  .transform((response) =>
    Array.isArray(response)
      ? {
          pins: response.map((browserDeviceId) => ({
            browser_device_id: browserDeviceId,
            delivered: true,
            undelivered_reason: null,
          })),
          capacity: null,
        }
      : response,
  );

export type TrustBundleOut = z.infer<typeof TrustBundleOutSchema>;
export type TrustBundlePut = z.infer<typeof TrustBundlePutSchema>;
export type PasskeyCredentialOut = z.infer<typeof PasskeyCredentialOutSchema>;
export type PasskeyCredentialCreate = z.infer<typeof PasskeyCredentialCreateSchema>;
export type BrowserEndorsementCreate = z.infer<typeof BrowserEndorsementCreateSchema>;
export type BrowserEndorsementOut = z.infer<typeof BrowserEndorsementOutSchema>;
export type BrowserEndorsementRecord = z.infer<typeof BrowserEndorsementRecordSchema>;
export type AccountEndorsementCreate = z.infer<typeof AccountEndorsementCreateSchema>;
export type AccountEndorsementOut = z.infer<typeof AccountEndorsementOutSchema>;
export type AccountEndorsementRecord = z.infer<typeof AccountEndorsementRecordSchema>;
export type DeviceApprovalRequestCreate = z.infer<typeof DeviceApprovalRequestCreateSchema>;
export type DeviceApprovalRequestOut = z.infer<typeof DeviceApprovalRequestOutSchema>;
export type HostPinUndeliveredReason = z.infer<typeof HostPinUndeliveredReasonSchema>;
export type HostPinCapacity = z.infer<typeof HostPinCapacitySchema>;
export type HostPinsOut = z.infer<typeof HostPinsOutSchema>;
