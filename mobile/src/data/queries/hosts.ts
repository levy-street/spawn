import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getBaseUrl } from "@/data/api/config";
import { getMe } from "@/data/api/endpoints/account";
import { listAgents } from "@/data/api/endpoints/agents";
import {
  deleteHost,
  getHost,
  installHostAgent,
  listHostAgents,
  listHosts,
  patchHost,
  patchHostAgentPolicy,
} from "@/data/api/endpoints/hosts";
import { listSessions } from "@/data/api/endpoints/sessions";
import { listSkills } from "@/data/api/endpoints/skills";
import type { HostAgentList, HostAgentPolicyOut, HostOut } from "@/data/api/schemas/hosts";
import { qk } from "@/data/queryKeys";
import { openHostPinStore } from "@/data/trust/host-pins";

const HOSTS_REFRESH_MS = 10_000;
const HOST_REFRESH_MS = 30_000;
const SESSIONS_REFRESH_MS = 5_000;
const HOST_AGENTS_REFRESH_MS = 60_000;
const HOST_AGENTS_STALE_MS = 30_000;

export interface RenameHostInput {
  hostId: string;
  name: string;
}

export interface HostAgentInput {
  hostId: string;
  agentId: string;
}

export interface HostAgentPolicyInput extends HostAgentInput {
  autoUpdate: boolean;
}

export interface RemoveHostDependencies {
  accountId(): Promise<string>;
  serverOrigin(): Promise<string>;
  revokeLocalPin(input: {
    accountId: string;
    serverOrigin: string;
    hostPublicKey: string;
  }): Promise<void>;
  hasLocalPin(input: {
    accountId: string;
    serverOrigin: string;
    hostPublicKey: string;
  }): Promise<boolean>;
  removeRemote(hostId: string): Promise<void>;
}

const removalDependencies: RemoveHostDependencies = {
  async accountId() {
    return (await getMe()).user.id;
  },
  async serverOrigin() {
    return new URL(await getBaseUrl()).origin;
  },
  async hasLocalPin(input) {
    const store = await openHostPinStore();
    const pins = await store.list(input.accountId, input.serverOrigin);
    return pins.some((pin) => pin.hostPublicKey === input.hostPublicKey);
  },
  async revokeLocalPin(input) {
    const store = await openHostPinStore();
    await store.revokeExact(input);
  },
  removeRemote: deleteHost,
};

/** Tombstone the exact local key before server deletion so revoked trust cannot be silently reused. */
export async function removeHostWithTrust(
  host: HostOut,
  dependencies: RemoveHostDependencies = removalDependencies,
): Promise<void> {
  if (host.host_public_key !== null) {
    const [accountId, serverOrigin] = await Promise.all([
      dependencies.accountId(),
      dependencies.serverOrigin(),
    ]);
    const pinInput = { accountId, serverOrigin, hostPublicKey: host.host_public_key };
    if (await dependencies.hasLocalPin(pinInput)) {
      await dependencies.revokeLocalPin(pinInput);
    }
  }
  await dependencies.removeRemote(host.id);
}

export function useHostsQuery() {
  return useQuery({
    queryKey: qk.hosts(),
    queryFn: listHosts,
    refetchInterval: HOSTS_REFRESH_MS,
  });
}

export function useHostQuery(hostId: string) {
  return useQuery({
    queryKey: qk.host(hostId),
    queryFn: () => getHost(hostId),
    refetchInterval: HOST_REFRESH_MS,
    enabled: hostId.length > 0,
  });
}

export function useAllSessionsQuery() {
  return useQuery({
    queryKey: qk.sessions(),
    queryFn: () => listSessions(),
    refetchInterval: SESSIONS_REFRESH_MS,
  });
}

export function useHostSessionsQuery(hostId: string) {
  return useQuery({
    queryKey: qk.sessionsForHost(hostId),
    queryFn: () => listSessions(hostId),
    refetchInterval: SESSIONS_REFRESH_MS,
    enabled: hostId.length > 0,
  });
}

export function useHostAgentsQuery(hostId: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.hostAgents(hostId),
    queryFn: () => listHostAgents(hostId),
    enabled: enabled && hostId.length > 0,
    refetchInterval: HOST_AGENTS_REFRESH_MS,
    staleTime: HOST_AGENTS_STALE_MS,
  });
}

export function useAgentsQuery() {
  return useQuery({ queryKey: qk.agents(), queryFn: listAgents, staleTime: HOST_AGENTS_STALE_MS });
}

export function useSkillsQuery() {
  return useQuery({ queryKey: qk.skills(), queryFn: listSkills, staleTime: HOST_AGENTS_STALE_MS });
}

export function useRenameHostMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ hostId, name }: RenameHostInput) => patchHost(hostId, { name }),
    onSuccess: (host) => {
      queryClient.setQueryData(qk.host(host.id), host);
      void queryClient.invalidateQueries({ queryKey: qk.hosts() });
    },
  });
}

export function useRemoveHostMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (host: HostOut) => removeHostWithTrust(host),
    onSuccess: (_result, host) => {
      queryClient.removeQueries({ queryKey: qk.host(host.id) });
      void queryClient.invalidateQueries({ queryKey: qk.hosts() });
      void queryClient.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

export function useInstallHostAgentMutation(hostId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId }: HostAgentInput) => installHostAgent(hostId, agentId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.hostAgents(hostId) }),
  });
}

export function useHostAgentPolicyMutation(hostId: string) {
  const queryClient = useQueryClient();
  return useMutation<HostAgentPolicyOut, Error, HostAgentPolicyInput, HostAgentList | undefined>({
    mutationFn: ({ agentId, autoUpdate }) =>
      patchHostAgentPolicy(hostId, agentId, { auto_update: autoUpdate }),
    onMutate: async ({ agentId, autoUpdate }) => {
      await queryClient.cancelQueries({ queryKey: qk.hostAgents(hostId) });
      const previous = queryClient.getQueryData<HostAgentList>(qk.hostAgents(hostId));
      queryClient.setQueryData<HostAgentList>(qk.hostAgents(hostId), (current) =>
        current
          ? {
              agents: current.agents.map((agent) =>
                agent.agent_id === agentId ? { ...agent, auto_update: autoUpdate } : agent,
              ),
            }
          : current,
      );
      return previous;
    },
    onError: (_error, _variables, previous) => {
      if (previous) queryClient.setQueryData(qk.hostAgents(hostId), previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.hostAgents(hostId) }),
  });
}
