import { z } from "zod";
import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const TilePlacementSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
});
export const SessionCreateSchema = z.object({
  host_id: UUIDSchema,
  cwd: z.string(),
  name: z.string().max(128).nullable().optional(),
  /** The agent this window is being opened as: the type a duplicate copies. */
  agent_id: UUIDSchema.nullable().optional(),
  skill_ids: z.array(UUIDSchema).nullable().optional(),
  workspace_id: UUIDSchema.nullable().optional(),
  tile: TilePlacementSchema.nullable().optional(),
});
export const SessionPatchSchema = z.object({
  name: z.string().nullable().optional(),
  /** Sent when an agent is launched into a running window, and sent as null
   *  when it is stopped back to a bare prompt. Omitted leaves the type be. */
  agent_id: UUIDSchema.nullable().optional(),
});
export const SessionOutSchema = z.object({
  id: UUIDSchema,
  name: z.string().nullable(),
  host_id: UUIDSchema,
  host_name: z.string().nullable(),
  cwd: z.string(),
  status: z.string(),
  started_at: IsoDateTimeSchema,
  exited_at: IsoDateTimeSchema.nullable(),
  exit_code: z.number().int().nullable(),
  last_output_at: IsoDateTimeSchema.nullable(),
  last_input_at: IsoDateTimeSchema.nullable(),
  last_activity_at: IsoDateTimeSchema.nullable(),
  activity_state: z.string(),
  activity_label: z.string(),
  foreground_command: z.string().nullable(),
  /**
   * What this window was opened as, as opposed to `foreground_command`, which
   * is whatever holds the terminal this second. Defaulted rather than required
   * so a bundle that reaches a phone before its server does still parses.
   */
  agent_id: UUIDSchema.nullable().default(null),
});

export type TilePlacement = z.infer<typeof TilePlacementSchema>;
export type SessionCreate = z.infer<typeof SessionCreateSchema>;
export type SessionPatch = z.infer<typeof SessionPatchSchema>;
export type SessionOut = z.infer<typeof SessionOutSchema>;
