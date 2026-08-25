import { z } from "zod";
import { Ed25519AlgorithmSchema, IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const BrowserDeviceRegisterRequestSchema = z.object({
  label: z.string().max(64).nullable().optional(),
  key_algorithm: Ed25519AlgorithmSchema,
  public_key: z.string(),
  signature: z.string(),
});
export const BrowserDeviceRevokeRequestSchema = z.object({ expected_public_key: z.string() });
export const BrowserDeviceRenameRequestSchema = z.object({
  label: z.string().max(64).nullable().optional(),
});
export const BrowserDeviceOutSchema = z.object({
  id: UUIDSchema,
  key_algorithm: Ed25519AlgorithmSchema,
  public_key: z.string(),
  // No fingerprint field (mesh B5): the key is right here, so a display
  // fingerprint is derived locally with formatHostFingerprint. A
  // server-authored one would be a comparison label the server could forge,
  // which is the whole thing the fingerprint exists to defeat. Requiring it
  // here made zod reject every response the server sent.
  label: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  last_seen_at: IsoDateTimeSchema.nullable().optional(),
  approval_requested_at: IsoDateTimeSchema.nullable().optional(),
  revoked_at: IsoDateTimeSchema.nullable(),
  revoked_by_device_id: UUIDSchema.nullable().optional(),
  is_root: z.boolean().optional(),
});
export const BrowserDevicePruneResponseSchema = z.object({
  pruned: z.number().int().nonnegative(),
});

export const DeviceStartRequestSchema = z.object({
  host_name: z.string().max(128),
  os: z.string().nullable().optional(),
  arch: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  host_key_algorithm: Ed25519AlgorithmSchema,
  host_public_key: z.string(),
});
export const DeviceStartResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  approval_nonce: z.string(),
  verification_uri: z.string(),
  interval: z.number().int().positive(),
  expires_in: z.number().int().positive(),
});
export const DevicePossessionRequestSchema = z.object({
  device_code: z.string(),
  approval_nonce: z.string(),
  host_key_algorithm: Ed25519AlgorithmSchema,
  host_public_key: z.string(),
  signature: z.string(),
});
export const DevicePossessionResponseSchema = z.object({
  verified: z.literal(true),
  version: z.literal(1),
});
export const DevicePollRequestSchema = z.object({
  device_code: z.string(),
  host_key_algorithm: Ed25519AlgorithmSchema,
  host_public_key: z.string(),
});
export const DevicePollSuccessSchema = z.object({
  access_token: z.string(),
  host_id: UUIDSchema,
  host_key_algorithm: Ed25519AlgorithmSchema,
  host_public_key: z.string(),
  host_key_fingerprint: z.string(),
  browser_device_id: UUIDSchema,
  browser_key_algorithm: Ed25519AlgorithmSchema,
  browser_public_key: z.string(),
  browser_key_fingerprint: z.string(),
  account_id: UUIDSchema.nullable(),
  browser_approval_signature: z.string().nullable(),
});
export const DevicePollErrorSchema = z.enum([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "denied",
  "invalid_device_binding",
  "key_conflict",
  "pin_conflict",
  "pin_limit",
]);
export const DevicePollPendingSchema = z.object({ error: DevicePollErrorSchema });
export const DevicePollResponseSchema = z.union([DevicePollSuccessSchema, DevicePollPendingSchema]);
const DeviceApprovalIdentifierShape = {
  user_code: z.string().optional(),
  approval_ref: z.string().optional(),
};

function hasExactlyOneApprovalIdentifier(value: {
  user_code?: string | undefined;
  approval_ref?: string | undefined;
}): boolean {
  return (value.user_code === undefined) !== (value.approval_ref === undefined);
}

export const DevicePendingRequestSchema = z
  .object(DeviceApprovalIdentifierShape)
  .refine(hasExactlyOneApprovalIdentifier);
export const DevicePendingResponseSchema = z.object({
  host_name: z.string(),
  approval_nonce: z.string(),
  host_key_algorithm: Ed25519AlgorithmSchema,
  host_public_key: z.string(),
  host_key_fingerprint: z.string(),
});
export const DeviceApproveRequestSchema = z
  .object({
    ...DeviceApprovalIdentifierShape,
    approval_nonce: z.string(),
    host_key_algorithm: Ed25519AlgorithmSchema,
    host_public_key: z.string(),
    host_key_fingerprint: z.string(),
    browser_device_id: UUIDSchema,
    browser_key_algorithm: Ed25519AlgorithmSchema,
    browser_public_key: z.string(),
    browser_key_fingerprint: z.string(),
    signature: z.string(),
  })
  .refine(hasExactlyOneApprovalIdentifier);
export const DeviceApproveResponseSchema = DevicePendingResponseSchema.extend({
  browser_device_id: UUIDSchema,
  browser_key_algorithm: Ed25519AlgorithmSchema,
  browser_public_key: z.string(),
  browser_key_fingerprint: z.string(),
  host_id: UUIDSchema.nullable(),
});

export type BrowserDeviceRegisterRequest = z.infer<typeof BrowserDeviceRegisterRequestSchema>;
export type BrowserDeviceRevokeRequest = z.infer<typeof BrowserDeviceRevokeRequestSchema>;
export type BrowserDeviceRenameRequest = z.infer<typeof BrowserDeviceRenameRequestSchema>;
export type BrowserDeviceOut = z.infer<typeof BrowserDeviceOutSchema>;
export type BrowserDevicePruneResponse = z.infer<typeof BrowserDevicePruneResponseSchema>;
export type DeviceStartRequest = z.infer<typeof DeviceStartRequestSchema>;
export type DeviceStartResponse = z.infer<typeof DeviceStartResponseSchema>;
export type DevicePossessionRequest = z.infer<typeof DevicePossessionRequestSchema>;
export type DevicePossessionResponse = z.infer<typeof DevicePossessionResponseSchema>;
export type DevicePollRequest = z.infer<typeof DevicePollRequestSchema>;
export type DevicePollSuccess = z.infer<typeof DevicePollSuccessSchema>;
export type DevicePollError = z.infer<typeof DevicePollErrorSchema>;
export type DevicePollPending = z.infer<typeof DevicePollPendingSchema>;
export type DevicePollResponse = z.infer<typeof DevicePollResponseSchema>;
export type DevicePendingRequest = z.infer<typeof DevicePendingRequestSchema>;
export type DevicePendingResponse = z.infer<typeof DevicePendingResponseSchema>;
export type DeviceApproveRequest = z.infer<typeof DeviceApproveRequestSchema>;
export type DeviceApproveResponse = z.infer<typeof DeviceApproveResponseSchema>;
