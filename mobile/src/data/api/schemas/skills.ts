import { z } from "zod";
import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const SkillCreateSchema = z.object({
  name: z.string().max(128),
  description: z.string().max(512).optional(),
  content: z.string().max(65_535),
  enabled_by_default: z.boolean().optional(),
});
export const SkillPatchSchema = z.object({
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  enabled_by_default: z.boolean().nullable().optional(),
});
export const SkillOutSchema = z.object({
  id: UUIDSchema,
  owner_user_id: UUIDSchema,
  name: z.string(),
  description: z.string(),
  content: z.string(),
  enabled_by_default: z.boolean(),
  created_at: IsoDateTimeSchema,
});
export const SessionAccessPatchSchema = z.object({
  skill_ids: z.array(UUIDSchema).nullable().optional(),
});
export const SessionAccessOutSchema = z.object({
  session_id: UUIDSchema,
  skills: z.array(SkillOutSchema),
});
export const SkillLaunchConfigSchema = z.object({
  id: UUIDSchema,
  name: z.string(),
  description: z.string(),
  content: z.string(),
});

export type SkillCreate = z.infer<typeof SkillCreateSchema>;
export type SkillPatch = z.infer<typeof SkillPatchSchema>;
export type SkillOut = z.infer<typeof SkillOutSchema>;
export type SessionAccessPatch = z.infer<typeof SessionAccessPatchSchema>;
export type SessionAccessOut = z.infer<typeof SessionAccessOutSchema>;
export type SkillLaunchConfig = z.infer<typeof SkillLaunchConfigSchema>;
