import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart, queryString } from "@/data/api/endpoints/helpers";
import {
  type AdminEmailOut,
  AdminEmailOutSchema,
  type AdminInviteCreate,
  AdminInviteCreateSchema,
  type AdminInviteOut,
  AdminInviteOutSchema,
  type AdminMailStatus,
  AdminMailStatusSchema,
  type AdminTestEmail,
  AdminTestEmailSchema,
  type AdminUserOut,
  AdminUserOutSchema,
} from "@/data/api/schemas/admin";

export function listAdminUsers(): Promise<AdminUserOut[]> {
  return api("/api/admin/users", { schema: z.array(AdminUserOutSchema) });
}

export function listAdminInvites(): Promise<AdminInviteOut[]> {
  return api("/api/admin/invites", { schema: z.array(AdminInviteOutSchema) });
}

export function createAdminInvite(body: AdminInviteCreate): Promise<AdminInviteOut> {
  return api("/api/admin/invites", {
    method: "POST",
    body: jsonBody(AdminInviteCreateSchema.parse(body)),
    schema: AdminInviteOutSchema,
  });
}

export function revokeAdminInvite(inviteId: string): Promise<AdminInviteOut> {
  return api(`/api/admin/invites/${pathPart(inviteId)}/revoke`, {
    method: "POST",
    schema: AdminInviteOutSchema,
  });
}

export function getAdminMailStatus(): Promise<AdminMailStatus> {
  return api("/api/admin/mail", { schema: AdminMailStatusSchema });
}

export function listAdminEmails(limit = 100): Promise<AdminEmailOut[]> {
  return api(`/api/admin/emails${queryString({ limit })}`, {
    schema: z.array(AdminEmailOutSchema),
  });
}

export function sendAdminTestEmail(body: AdminTestEmail): Promise<AdminEmailOut> {
  return api("/api/admin/emails/test", {
    method: "POST",
    body: jsonBody(AdminTestEmailSchema.parse(body)),
    schema: AdminEmailOutSchema,
  });
}
