import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart, queryString } from "@/data/api/endpoints/helpers";
import {
  type SessionCreate,
  SessionCreateSchema,
  type SessionMove,
  SessionMoveFenceSchema,
  SessionMoveSchema,
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

export function moveSession(sessionId: string, body: SessionMove): Promise<SessionOut> {
  return api(`/api/sessions/${pathPart(sessionId)}/move`, {
    method: "POST",
    body: jsonBody(SessionMoveSchema.parse(body)),
    schema: SessionOutSchema,
  });
}

/**
 * Mark a window as moving: this device is about to carry its conversation to
 * another host. Lifecycle metadata only — no host hears of it, and the server
 * is not told where the window goes until the commit (`moveSession` with
 * `carried`). Refused with `move_in_progress`, `move_conflict`,
 * `source_offline` or `workspace_archived`.
 */
export function beginSessionMove(sessionId: string, expectedHostId: string): Promise<SessionOut> {
  return api(`/api/sessions/${pathPart(sessionId)}/move/begin`, {
    method: "POST",
    body: jsonBody(SessionMoveFenceSchema.parse({ expected_host_id: expectedHostId })),
    schema: SessionOutSchema,
  });
}

/**
 * End a carried move that will not commit: "running" when nothing stopped
 * the window, "killed" when an exit was recorded (restart it there).
 */
export function abortSessionMove(sessionId: string, expectedHostId: string): Promise<SessionOut> {
  return api(`/api/sessions/${pathPart(sessionId)}/move/abort`, {
    method: "POST",
    body: jsonBody(SessionMoveFenceSchema.parse({ expected_host_id: expectedHostId })),
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
