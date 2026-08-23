import { z } from "zod";
import { UUIDSchema } from "@/data/api/schemas/common";

const StringMapSchema = z.record(z.string(), z.string());

export const AgentCreateSchema = z.object({
  name: z.string().max(128),
  kind: z.string().max(64),
  command: z.string().max(1024),
  env: StringMapSchema.optional(),
  install: z.string().max(2048).nullable().optional(),
  yolo_args: z.string().max(256).nullable().optional(),
  yolo_env: StringMapSchema.optional(),
});
export const AgentPatchSchema = z.object({
  name: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  env: StringMapSchema.nullable().optional(),
  install: z.string().nullable().optional(),
  yolo_args: z.string().nullable().optional(),
  yolo_env: StringMapSchema.nullable().optional(),
});
export const AgentPreferencePatchSchema = z.object({ yolo: z.boolean().nullable().optional() });
export const AgentOutSchema = z.object({
  id: UUIDSchema,
  owner_user_id: UUIDSchema.nullable(),
  name: z.string(),
  kind: z.string(),
  command: z.string(),
  env: StringMapSchema,
  install: z.string().nullable(),
  yolo_args: z.string().nullable(),
  yolo_env: StringMapSchema,
  yolo: z.boolean(),
});

export type AgentCreate = z.infer<typeof AgentCreateSchema>;
export type AgentPatch = z.infer<typeof AgentPatchSchema>;
export type AgentPreferencePatch = z.infer<typeof AgentPreferencePatchSchema>;
export type AgentOut = z.infer<typeof AgentOutSchema>;
