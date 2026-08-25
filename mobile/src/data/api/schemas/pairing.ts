import { z } from "zod";

import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

/**
 * The add-device SAS relay (device mesh §4, Appendix A). The server stores
 * and forwards opaque base64url values and enforces move ordering; nothing it
 * serves is trusted on its own. The number each side derives from these
 * values, carried by the human across both screens, is the check.
 */
const Wire32 = z.string().length(43);

export const DevicePairingStartSchema = z.object({
  initiator_device_id: UUIDSchema,
  joiner_device_id: UUIDSchema,
  initiator_public_key: Wire32,
  initiator_commit: Wire32,
});
export const DevicePairingOutSchema = z.object({
  id: UUIDSchema,
  expires_at: IsoDateTimeSchema,
});
export const DevicePairingContributeSchema = z.object({
  joiner_public_key: Wire32,
  joiner_nonce: Wire32,
});
export const DevicePairingRevealSchema = z.object({
  initiator_nonce: Wire32,
});
export const DevicePairingStateSchema = z.object({
  id: UUIDSchema,
  initiator_device_id: UUIDSchema,
  joiner_device_id: UUIDSchema,
  initiator_public_key: Wire32,
  initiator_commit: Wire32,
  joiner_public_key: Wire32.nullable().optional(),
  joiner_nonce: Wire32.nullable().optional(),
  initiator_nonce: Wire32.nullable().optional(),
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
});

export type DevicePairingStart = z.infer<typeof DevicePairingStartSchema>;
export type DevicePairingOut = z.infer<typeof DevicePairingOutSchema>;
export type DevicePairingContribute = z.infer<typeof DevicePairingContributeSchema>;
export type DevicePairingReveal = z.infer<typeof DevicePairingRevealSchema>;
export type DevicePairingState = z.infer<typeof DevicePairingStateSchema>;
