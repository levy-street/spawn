import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { deleteAccount, getMe } from "@/data/api/endpoints/account";
import {
  createAgent,
  deleteAgent,
  listAgents,
  patchAgent,
  patchAgentPreferences,
} from "@/data/api/endpoints/agents";
import {
  listBrowserDevices,
  pruneBrowserDevices,
  renameBrowserDevice,
  revokeBrowserDevice,
} from "@/data/api/endpoints/devices";
import { listHosts } from "@/data/api/endpoints/hosts";
import { getProfile } from "@/data/api/endpoints/legion";
import { createSkill, deleteSkill, listSkills, patchSkill } from "@/data/api/endpoints/skills";
import {
  deleteWorkspaceTemplate,
  listWorkspaceTemplates,
  patchWorkspaceTemplate,
} from "@/data/api/endpoints/templates";
import { getTrustBundle, listEndorsements, listPasskeys } from "@/data/api/endpoints/trust";
import type { AgentCreate, AgentOut, AgentPatch } from "@/data/api/schemas/agents";
import type { AccountDeleteRequest, MeResponse } from "@/data/api/schemas/auth";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { ProfileOut } from "@/data/api/schemas/legion";
import type { SkillCreate, SkillOut, SkillPatch } from "@/data/api/schemas/skills";
import type { WorkspaceTemplateOut } from "@/data/api/schemas/templates";
import type {
  BrowserEndorsementRecord,
  PasskeyCredentialOut,
  TrustBundleOut,
} from "@/data/api/schemas/trust";
import { qk } from "@/data/queryKeys";

export function useMeSettingsQuery(): UseQueryResult<MeResponse> {
  return useQuery({ queryKey: qk.me(), queryFn: getMe });
}

export function useProfileSettingsQuery(): UseQueryResult<ProfileOut> {
  return useQuery({ queryKey: qk.profile(), queryFn: getProfile });
}

export function useHostsSettingsQuery(): UseQueryResult<HostOut[]> {
  return useQuery({ queryKey: qk.hosts(), queryFn: listHosts, refetchInterval: 10_000 });
}

export function useAgentsSettingsQuery(): UseQueryResult<AgentOut[]> {
  return useQuery({ queryKey: qk.agents(), queryFn: listAgents });
}

export function useSkillsSettingsQuery(): UseQueryResult<SkillOut[]> {
  return useQuery({ queryKey: qk.skills(), queryFn: listSkills });
}

export function useTemplatesSettingsQuery(): UseQueryResult<WorkspaceTemplateOut[]> {
  return useQuery({ queryKey: qk.workspaceTemplates(), queryFn: listWorkspaceTemplates });
}

export function useBrowserDevicesSettingsQuery(): UseQueryResult<BrowserDeviceOut[]> {
  return useQuery({ queryKey: qk.browserDevices(), queryFn: listBrowserDevices });
}

export function useTrustBundleSettingsQuery(): UseQueryResult<TrustBundleOut | null> {
  return useQuery({ queryKey: qk.trustBundle(), queryFn: getTrustBundle });
}

export function usePasskeysSettingsQuery(): UseQueryResult<PasskeyCredentialOut[]> {
  return useQuery({ queryKey: qk.trustPasskeys(), queryFn: listPasskeys });
}

export function useEndorsementsSettingsQuery(
  accountId: string | undefined,
  deviceId: string | undefined,
): UseQueryResult<BrowserEndorsementRecord[]> {
  return useQuery({
    queryKey:
      accountId && deviceId
        ? qk.trustIntroductions(accountId, deviceId)
        : qk.trustIntroductions("", ""),
    queryFn: () => listEndorsements(deviceId ?? ""),
    enabled: accountId !== undefined && deviceId !== undefined,
  });
}

export function useDeleteAccountMutation(): UseMutationResult<void, Error, AccountDeleteRequest> {
  return useMutation({ mutationFn: deleteAccount });
}

export function saveAgentYoloPreference(agentId: string, yolo: boolean): Promise<AgentOut> {
  return patchAgentPreferences(agentId, { yolo });
}

export function useAgentMutations(): {
  create: UseMutationResult<AgentOut, Error, AgentCreate>;
  patch: UseMutationResult<AgentOut, Error, { id: string; patch: AgentPatch }>;
  remove: UseMutationResult<void, Error, string>;
  preference: UseMutationResult<AgentOut, Error, { id: string; yolo: boolean }>;
} {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.agents() });
  return {
    create: useMutation({ mutationFn: createAgent, onSuccess: invalidate }),
    patch: useMutation({
      mutationFn: ({ id, patch }) => patchAgent(id, patch),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteAgent, onSuccess: invalidate }),
    preference: useMutation({
      mutationFn: ({ id, yolo }) => saveAgentYoloPreference(id, yolo),
      onSuccess: invalidate,
    }),
  };
}

export function useSkillMutations(): {
  create: UseMutationResult<SkillOut, Error, SkillCreate>;
  patch: UseMutationResult<SkillOut, Error, { id: string; patch: SkillPatch }>;
  remove: UseMutationResult<void, Error, string>;
} {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.skills() });
  return {
    create: useMutation({ mutationFn: createSkill, onSuccess: invalidate }),
    patch: useMutation({
      mutationFn: ({ id, patch }) => patchSkill(id, patch),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteSkill, onSuccess: invalidate }),
  };
}

export function useTemplateMutations(): {
  patch: UseMutationResult<
    WorkspaceTemplateOut,
    Error,
    { id: string; patch: { name?: string; icon?: string | null; icon_source?: "custom" } }
  >;
  remove: UseMutationResult<void, Error, string>;
} {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.workspaceTemplates() });
  return {
    patch: useMutation({
      mutationFn: ({ id, patch }) => patchWorkspaceTemplate(id, patch),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteWorkspaceTemplate, onSuccess: invalidate }),
  };
}

export function useBrowserDeviceMutations(): {
  rename: UseMutationResult<BrowserDeviceOut, Error, { id: string; label: string | null }>;
  revoke: UseMutationResult<BrowserDeviceOut, Error, { id: string; publicKey: string }>;
  prune: UseMutationResult<{ pruned: number }, Error, void>;
} {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.browserDevices() });
  return {
    rename: useMutation({
      mutationFn: ({ id, label }) => renameBrowserDevice(id, { label }),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: ({ id, publicKey }) =>
        revokeBrowserDevice(id, { expected_public_key: publicKey }),
      onSuccess: invalidate,
    }),
    prune: useMutation({ mutationFn: pruneBrowserDevices, onSuccess: invalidate }),
  };
}
