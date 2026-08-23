import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart, queryString } from "@/data/api/endpoints/helpers";
import {
  type SessionCreate,
  SessionCreateSchema,
  type SessionOut,
  SessionOutSchema,
  type SessionPatch,
  SessionPatchSchema,
} from "@/data/api/schemas/sessions";
import {
  type SessionAccessOut,
  SessionAccessOutSchema,
  type SessionAccessPatch,
  SessionAccessPatchSchema,
} from "@/data/api/schemas/skills";

export function listSessions(hostId?: string): Promise<SessionOut[]> {
  return api(`/api/sessions${queryString({ host_id: hostId })}`, {
    schema: z.array(SessionOutSchema),
  });
}

export function createSession(body: SessionCreate): Promise<SessionOut> {
  return api("/api/sessions", {
    method: "POST",
    body: jsonBody(SessionCreateSchema.parse(body)),
    schema: SessionOutSchema,
  });
}

export function getSession(sessionId: string): Promise<SessionOut> {
  return api(`/api/sessions/${pathPart(sessionId)}`, { schema: SessionOutSchema });
}

export function patchSession(sessionId: string, body: SessionPatch): Promise<SessionOut> {
  return api(`/api/sessions/${pathPart(sessionId)}`, {
    method: "PATCH",
    body: jsonBody(SessionPatchSchema.parse(body)),
    schema: SessionOutSchema,
  });
}

export function restartSession(sessionId: string): Promise<SessionOut> {
  return api(`/api/sessions/${pathPart(sessionId)}/restart`, {
    method: "POST",
    schema: SessionOutSchema,
  });
}

export function deleteSession(sessionId: string): Promise<void> {
  return api(`/api/sessions/${pathPart(sessionId)}`, { method: "DELETE" });
}

export function getSessionAccess(sessionId: string): Promise<SessionAccessOut> {
  return api(`/api/sessions/${pathPart(sessionId)}/access`, { schema: SessionAccessOutSchema });
}

export function patchSessionAccess(
  sessionId: string,
  body: SessionAccessPatch,
): Promise<SessionAccessOut> {
  return api(`/api/sessions/${pathPart(sessionId)}/access`, {
    method: "PATCH",
    body: jsonBody(SessionAccessPatchSchema.parse(body)),
    schema: SessionAccessOutSchema,
  });
}
