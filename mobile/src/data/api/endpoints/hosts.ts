import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart } from "@/data/api/endpoints/helpers";
import {
  type HostAgentInstallResult,
  HostAgentInstallResultSchema,
  type HostAgentList,
  HostAgentListSchema,
  type HostAgentPolicyOut,
  HostAgentPolicyOutSchema,
  type HostAgentPolicyPatch,
  HostAgentPolicyPatchSchema,
  type HostOut,
  HostOutSchema,
  type HostPatch,
  HostPatchSchema,
  type RecentDirList,
  RecentDirListSchema,
} from "@/data/api/schemas/hosts";

export function listHosts(): Promise<HostOut[]> {
  return api("/api/hosts", { schema: z.array(HostOutSchema) });
}

export function getHost(hostId: string): Promise<HostOut> {
  return api(`/api/hosts/${pathPart(hostId)}`, { schema: HostOutSchema });
}

export function patchHost(hostId: string, body: HostPatch): Promise<HostOut> {
  return api(`/api/hosts/${pathPart(hostId)}`, {
    method: "PATCH",
    body: jsonBody(HostPatchSchema.parse(body)),
    schema: HostOutSchema,
  });
}

export function listHostAgents(hostId: string): Promise<HostAgentList> {
  return api(`/api/hosts/${pathPart(hostId)}/agents`, {
    timeoutMs: 20_000,
    schema: HostAgentListSchema,
  });
}

export function listRecentDirectories(hostId: string): Promise<RecentDirList> {
  return api(`/api/hosts/${pathPart(hostId)}/recent-dirs`, { schema: RecentDirListSchema });
}

export function pingHost(hostId: string): Promise<void> {
  return api(`/api/hosts/${pathPart(hostId)}/control/ping`, {
    method: "POST",
    timeoutMs: 5_000,
  });
}

export function installHostAgent(hostId: string, agentId: string): Promise<HostAgentInstallResult> {
  return api(`/api/hosts/${pathPart(hostId)}/agents/${pathPart(agentId)}/install`, {
    method: "POST",
    timeoutMs: 190_000,
    schema: HostAgentInstallResultSchema,
  });
}

export function patchHostAgentPolicy(
  hostId: string,
  agentId: string,
  body: HostAgentPolicyPatch,
): Promise<HostAgentPolicyOut> {
  return api(`/api/hosts/${pathPart(hostId)}/agents/${pathPart(agentId)}/policy`, {
    method: "PATCH",
    body: jsonBody(HostAgentPolicyPatchSchema.parse(body)),
    schema: HostAgentPolicyOutSchema,
  });
}

export function deleteHost(hostId: string): Promise<void> {
  return api(`/api/hosts/${pathPart(hostId)}`, { method: "DELETE" });
}
