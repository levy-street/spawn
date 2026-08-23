import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart } from "@/data/api/endpoints/helpers";
import {
  type AgentCreate,
  AgentCreateSchema,
  type AgentOut,
  AgentOutSchema,
  type AgentPatch,
  AgentPatchSchema,
  type AgentPreferencePatch,
  AgentPreferencePatchSchema,
} from "@/data/api/schemas/agents";

export function listAgents(): Promise<AgentOut[]> {
  return api("/api/agents", { schema: z.array(AgentOutSchema) });
}

export function createAgent(body: AgentCreate): Promise<AgentOut> {
  return api("/api/agents", {
    method: "POST",
    body: jsonBody(AgentCreateSchema.parse(body)),
    schema: AgentOutSchema,
  });
}

export function patchAgent(agentId: string, body: AgentPatch): Promise<AgentOut> {
  return api(`/api/agents/${pathPart(agentId)}`, {
    method: "PATCH",
    body: jsonBody(AgentPatchSchema.parse(body)),
    schema: AgentOutSchema,
  });
}

export function deleteAgent(agentId: string): Promise<void> {
  return api(`/api/agents/${pathPart(agentId)}`, { method: "DELETE" });
}

export function patchAgentPreferences(
  agentId: string,
  body: AgentPreferencePatch,
): Promise<AgentOut> {
  return api(`/api/agents/${pathPart(agentId)}/preferences`, {
    method: "PATCH",
    body: jsonBody(AgentPreferencePatchSchema.parse(body)),
    schema: AgentOutSchema,
  });
}
