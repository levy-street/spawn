import { z } from "zod";

import { IsoDateTimeSchema } from "@/data/api/schemas/common";

export const PushDeviceRegisterSchema = z.object({
  token: z.string().min(8).max(255),
  platform: z.enum(["ios", "android"]),
  label: z.string().max(64).nullable().optional(),
  /** This install's trust identity, so its own knock is never pushed back to it. */
  browser_device_id: z.string().uuid().nullable().optional(),
});

export const PushDeviceOutSchema = z.object({
  id: z.string(),
  platform: z.string(),
  label: z.string().nullable().optional(),
  created_at: IsoDateTimeSchema,
  last_seen_at: IsoDateTimeSchema,
});

export type PushDeviceRegister = z.infer<typeof PushDeviceRegisterSchema>;
export type PushDeviceOut = z.infer<typeof PushDeviceOutSchema>;
