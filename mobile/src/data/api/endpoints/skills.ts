import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart } from "@/data/api/endpoints/helpers";
import {
  type SkillCreate,
  SkillCreateSchema,
  type SkillOut,
  SkillOutSchema,
  type SkillPatch,
  SkillPatchSchema,
} from "@/data/api/schemas/skills";

export function listSkills(): Promise<SkillOut[]> {
  return api("/api/skills", { schema: z.array(SkillOutSchema) });
}

export function createSkill(body: SkillCreate): Promise<SkillOut> {
  return api("/api/skills", {
    method: "POST",
    body: jsonBody(SkillCreateSchema.parse(body)),
    schema: SkillOutSchema,
  });
}

export function patchSkill(skillId: string, body: SkillPatch): Promise<SkillOut> {
  return api(`/api/skills/${pathPart(skillId)}`, {
    method: "PATCH",
    body: jsonBody(SkillPatchSchema.parse(body)),
    schema: SkillOutSchema,
  });
}

export function deleteSkill(skillId: string): Promise<void> {
  return api(`/api/skills/${pathPart(skillId)}`, { method: "DELETE" });
}
