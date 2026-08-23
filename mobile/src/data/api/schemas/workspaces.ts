import { z } from "zod";
import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";
import { SessionOutSchema } from "@/data/api/schemas/sessions";

export const WorkspaceIconSourceSchema = z.enum(["auto", "custom", "none"]);
export const WorkspaceIconFieldsSchema = z.object({
  icon: z.string().nullable(),
  icon_source: WorkspaceIconSourceSchema.nullable(),
});
export const WorkspaceIconPatchSchema = z.object({
  icon: z.string().nullable().optional(),
  icon_source: WorkspaceIconSourceSchema.nullable().optional(),
});
export const TileWidgetSchema = z.object({
  kind: z.literal("files"),
  host_id: UUIDSchema,
  path: z.string(),
});
export const WorkspaceTileSchema = z.object({
  session_id: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
  widget: TileWidgetSchema.nullable().optional(),
});
export const WorkspaceLayoutSchema = z.object({
  version: z.literal(3),
  tiles: z.array(WorkspaceTileSchema),
});
export const WorkspaceTabSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  layout: WorkspaceLayoutSchema,
  host_id: UUIDSchema.nullable(),
  cwd: z.string().nullable(),
});
export const WorkspaceLayoutV3Schema = z.object({
  version: z.literal(3),
  active_tab: z.string().nullable(),
  tabs: z.array(WorkspaceTabSchema).min(1).max(8),
});
export const WorkspaceFirstSessionSchema = z.object({
  host_id: UUIDSchema,
  cwd: z.string(),
  skill_ids: z.array(UUIDSchema).nullable().optional(),
});
export const WorkspaceCreateSchema = WorkspaceIconPatchSchema.extend({
  name: z.string().nullable().optional(),
  first_session: WorkspaceFirstSessionSchema.nullable().optional(),
  host_id: UUIDSchema.nullable().optional(),
  cwd: z.string().nullable().optional(),
});
export const WorkspacePatchSchema = WorkspaceIconPatchSchema.extend({
  name: z.string().nullable().optional(),
  layout: WorkspaceLayoutV3Schema.nullable().optional(),
  position: z.number().int().nullable().optional(),
  host_id: UUIDSchema.nullable().optional(),
  cwd: z.string().nullable().optional(),
});
export const WorkspaceOutSchema = WorkspaceIconFieldsSchema.extend({
  id: UUIDSchema,
  name: z.string(),
  host_id: UUIDSchema.nullable(),
  cwd: z.string().nullable(),
  layout: WorkspaceLayoutV3Schema,
  position: z.number().int(),
  archived_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export const WorkspaceCreateResponseSchema = z.object({
  workspace: WorkspaceOutSchema,
  session: SessionOutSchema.nullable(),
});

export type WorkspaceIconSource = z.infer<typeof WorkspaceIconSourceSchema>;
export type WorkspaceIconFields = z.infer<typeof WorkspaceIconFieldsSchema>;
export type WorkspaceIconPatch = z.infer<typeof WorkspaceIconPatchSchema>;
export type TileWidget = z.infer<typeof TileWidgetSchema>;
export type WorkspaceTile = z.infer<typeof WorkspaceTileSchema>;
export type WorkspaceLayout = z.infer<typeof WorkspaceLayoutSchema>;
export type WorkspaceTab = z.infer<typeof WorkspaceTabSchema>;
export type WorkspaceLayoutV3 = z.infer<typeof WorkspaceLayoutV3Schema>;
export type WorkspaceFirstSession = z.infer<typeof WorkspaceFirstSessionSchema>;
export type WorkspaceCreate = z.infer<typeof WorkspaceCreateSchema>;
export type WorkspacePatch = z.infer<typeof WorkspacePatchSchema>;
export type WorkspaceOut = z.infer<typeof WorkspaceOutSchema>;
export type WorkspaceCreateResponse = z.infer<typeof WorkspaceCreateResponseSchema>;
