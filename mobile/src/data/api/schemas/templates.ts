import { z } from "zod";
import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";
import { TilePlacementSchema } from "@/data/api/schemas/sessions";
import { WorkspaceIconFieldsSchema, WorkspaceIconPatchSchema } from "@/data/api/schemas/workspaces";

export const TemplateRunSchema = z.object({
  kind: z.enum(["shell", "agent", "files"]),
  command: z.string().nullable().optional(),
});
export const TemplateTileSchema = TilePlacementSchema.extend({ run: TemplateRunSchema });
export const TemplateTabSchema = z.object({
  name: z.string(),
  tiles: z.array(TemplateTileSchema).optional(),
});
export const WorkspaceTemplateSpecSchema = z.object({
  version: z.literal(2),
  tabs: z.array(TemplateTabSchema).min(1).max(8),
});
export const WorkspaceTemplateCreateSchema = WorkspaceIconPatchSchema.extend({
  name: z.string(),
  host_id: UUIDSchema.nullable().optional(),
  cwd: z.string().nullable().optional(),
  spec: WorkspaceTemplateSpecSchema,
});
export const WorkspaceTemplatePatchSchema = WorkspaceIconPatchSchema.extend({
  name: z.string().nullable().optional(),
  host_id: UUIDSchema.nullable().optional(),
  cwd: z.string().nullable().optional(),
  spec: WorkspaceTemplateSpecSchema.nullable().optional(),
});
export const WorkspaceTemplateOutSchema = WorkspaceIconFieldsSchema.extend({
  id: UUIDSchema,
  name: z.string(),
  host_id: UUIDSchema.nullable(),
  cwd: z.string().nullable(),
  spec: WorkspaceTemplateSpecSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});

export type TemplateRun = z.infer<typeof TemplateRunSchema>;
export type TemplateTile = z.infer<typeof TemplateTileSchema>;
export type TemplateTab = z.infer<typeof TemplateTabSchema>;
export type WorkspaceTemplateSpec = z.infer<typeof WorkspaceTemplateSpecSchema>;
export type WorkspaceTemplateCreate = z.infer<typeof WorkspaceTemplateCreateSchema>;
export type WorkspaceTemplatePatch = z.infer<typeof WorkspaceTemplatePatchSchema>;
export type WorkspaceTemplateOut = z.infer<typeof WorkspaceTemplateOutSchema>;
