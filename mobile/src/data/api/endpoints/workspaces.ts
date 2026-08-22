import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart, queryString } from "@/data/api/endpoints/helpers";
import {
  type WorkspaceCreate,
  type WorkspaceCreateResponse,
  WorkspaceCreateResponseSchema,
  WorkspaceCreateSchema,
  type WorkspaceOut,
  WorkspaceOutSchema,
  type WorkspacePatch,
  WorkspacePatchSchema,
} from "@/data/api/schemas/workspaces";

export function listWorkspaces(archived = false): Promise<WorkspaceOut[]> {
  return api(`/api/workspaces${queryString({ archived })}`, {
    schema: z.array(WorkspaceOutSchema),
  });
}

export function createWorkspace(body: WorkspaceCreate): Promise<WorkspaceCreateResponse> {
  return api("/api/workspaces", {
    method: "POST",
    body: jsonBody(WorkspaceCreateSchema.parse(body)),
    schema: WorkspaceCreateResponseSchema,
  });
}

export function getWorkspace(workspaceId: string): Promise<WorkspaceOut> {
  return api(`/api/workspaces/${pathPart(workspaceId)}`, { schema: WorkspaceOutSchema });
}

export function patchWorkspace(workspaceId: string, body: WorkspacePatch): Promise<WorkspaceOut> {
  return api(`/api/workspaces/${pathPart(workspaceId)}`, {
    method: "PATCH",
    body: jsonBody(WorkspacePatchSchema.parse(body)),
    schema: WorkspaceOutSchema,
  });
}

export function archiveWorkspace(workspaceId: string): Promise<WorkspaceOut> {
  return api(`/api/workspaces/${pathPart(workspaceId)}/archive`, {
    method: "POST",
    schema: WorkspaceOutSchema,
  });
}

export function unarchiveWorkspace(workspaceId: string): Promise<WorkspaceOut> {
  return api(`/api/workspaces/${pathPart(workspaceId)}/unarchive`, {
    method: "POST",
    schema: WorkspaceOutSchema,
  });
}

export function deleteWorkspace(workspaceId: string): Promise<void> {
  return api(`/api/workspaces/${pathPart(workspaceId)}`, { method: "DELETE" });
}
