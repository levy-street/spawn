import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart } from "@/data/api/endpoints/helpers";
import {
  type WorkspaceTemplateCreate,
  WorkspaceTemplateCreateSchema,
  type WorkspaceTemplateOut,
  WorkspaceTemplateOutSchema,
  type WorkspaceTemplatePatch,
  WorkspaceTemplatePatchSchema,
} from "@/data/api/schemas/templates";

export function listWorkspaceTemplates(): Promise<WorkspaceTemplateOut[]> {
  return api("/api/workspace-templates", { schema: z.array(WorkspaceTemplateOutSchema) });
}

export function createWorkspaceTemplate(
  body: WorkspaceTemplateCreate,
): Promise<WorkspaceTemplateOut> {
  return api("/api/workspace-templates", {
    method: "POST",
    body: jsonBody(WorkspaceTemplateCreateSchema.parse(body)),
    schema: WorkspaceTemplateOutSchema,
  });
}

export function patchWorkspaceTemplate(
  templateId: string,
  body: WorkspaceTemplatePatch,
): Promise<WorkspaceTemplateOut> {
  return api(`/api/workspace-templates/${pathPart(templateId)}`, {
    method: "PATCH",
    body: jsonBody(WorkspaceTemplatePatchSchema.parse(body)),
    schema: WorkspaceTemplateOutSchema,
  });
}

export function deleteWorkspaceTemplate(templateId: string): Promise<void> {
  return api(`/api/workspace-templates/${pathPart(templateId)}`, { method: "DELETE" });
}
