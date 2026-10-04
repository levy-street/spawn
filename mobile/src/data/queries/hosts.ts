import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { getBaseUrl } from "@/data/api/config";
import { getMe } from "@/data/api/endpoints/account";
import { listAgents } from "@/data/api/endpoints/agents";
import { listBrowserDevices } from "@/data/api/endpoints/devices";
import {
  deleteHost,
  getHost,
  installHostAgent,
  listHostAgents,
  listHosts,
  patchHost,
  patchHostAgentPolicy,
  updateHost,
} from "@/data/api/endpoints/hosts";
import { listSessions } from "@/data/api/endpoints/sessions";
import { getHostPins } from "@/data/api/endpoints/trust";
import type {
  HostAgentList,
  HostAgentPolicyOut,
  HostOut,
  HostUpdateOut,
} from "@/data/api/schemas/hosts";
import { qk } from "@/data/queryKeys";
import { type HostPin, openHostPinStore, subscribeHostPinChanges } from "@/data/trust/host-pins";
import { activeDeviceIdentityAccount, subscribeDeviceIdentityAccount } from "@/lib/crypto/identity";

const HOSTS_REFRESH_MS = 10_000;
const HOST_REFRESH_MS = 30_000;
const SESSIONS_REFRESH_MS = 5_000;
const HOST_AGENTS_STALE_MS = 30_000;
const HOST_UPDATE_POLL_MS = 2_000;
const HOST_UPDATE_POLL_LIMIT_MS = 3 * 60 * 1_000;

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
  localPins(input: {
    accountId: string;
    serverOrigin: string;
  }): Promise<readonly Pick<HostPin, "hostIds" | "hostPublicKey" | "state">[]>;
  removeRemote(hostId: string): Promise<void>;
}

const removalDependencies: RemoveHostDependencies = {
  async accountId() {
    return (await getMe()).user.id;
  },
  async serverOrigin() {
    return new URL(await getBaseUrl()).origin;
  },
  async localPins(input) {
    const store = await openHostPinStore();
    return store.list(input.accountId, input.serverOrigin);
  },
  async revokeLocalPin(input) {
    const store = await openHostPinStore();
    await store.revokeExact(input);
  },
  removeRemote: deleteHost,
};

/**
 * The approval this device holds for a host, looked up the way every connection
 * to it is decided (`HostPinStore.resolve`, through `verifyDaemonHost`): the
 * pin bound to its ID, whatever key that pin holds; failing that, the pin for
 * the key the server presents, whatever host IDs that pin carries.
 *
 * The second half is not a guess. This phone never binds a host ID when a
 * connection matches by key, and the server keeps one host row per key, so a
 * pin for the presented key that names other host IDs names this machine's
 * former rows — removed elsewhere and possessed again with the same key. It is
 * exactly the pin that lets this device reach the host today.
 *
 * And nothing else: when a pin is bound to this host under a different key (an
 * identity conflict), the presented key does not reach this host at all, so a
 * pin for it — another host's approval — is not this host's to withdraw.
 */
function approvalForHost(
  pins: readonly Pick<HostPin, "hostIds" | "hostPublicKey" | "state">[],
  host: Pick<HostOut, "id" | "host_public_key">,
) {
  const bound = pins.find((pin) => pin.hostIds.includes(host.id));
  if (bound !== undefined || host.host_public_key === null) return bound;
  return pins.find((pin) => pin.hostPublicKey === host.host_public_key);
}

/**
 * Tombstone this device's trust for the host before server deletion, so revoked
 * trust cannot be silently reused: whatever presents that key afterwards — this
 * host if the deletion fails, or the same machine possessed again as a new
 * host — is refused until a fresh ceremony approves it.
 *
 * What dies is the approval every connection to this host resolves to
 * (`approvalForHost`) — even when the server now presents a different key, or
 * withholds it. A different key is the identity-conflict case, and removal is
 * its only exit: the server cannot veto a local withdrawal, and a re-keyed host
 * would otherwise keep its old approval here forever. The browser revokes the
 * same record (web/src/lib/browser-host-pins.ts revokeBrowserHostPin): it binds
 * a host ID on every connection, so its pin bound to this host is the one
 * found here. (A withheld key still skips the browser's tombstone; that gap is
 * the browser's to close, not this device's to copy.)
 */
export async function removeHostWithTrust(
  host: HostOut,
  dependencies: RemoveHostDependencies = removalDependencies,
): Promise<void> {
  const [accountId, serverOrigin] = await Promise.all([
    dependencies.accountId(),
    dependencies.serverOrigin(),
  ]);
  const pins = await dependencies.localPins({ accountId, serverOrigin });
  const approved = approvalForHost(pins, host);
  if (approved?.state === "active") {
    await dependencies.revokeLocalPin({
      accountId,
      serverOrigin,
      hostPublicKey: approved.hostPublicKey,
    });
  }
  await dependencies.removeRemote(host.id);
}

export interface HostIdentityDependencies {
  openHostPinStore(): Promise<Pick<Awaited<ReturnType<typeof openHostPinStore>>, "resolve">>;
  serverOrigin(): Promise<string>;
}

const identityDependencies: HostIdentityDependencies = {
  openHostPinStore,
  serverOrigin: removalDependencies.serverOrigin,
};

/**
 * Whether this device approved a different key for this host than the one the
 * server now presents for it — a reinstall, or something impersonating it. Only
 * this device's own approvals can say so: the server's word is what is in doubt.
 */
export async function hostIdentityConflicts(
  input: { accountId: string; hostId: string; hostPublicKey: string },
  dependencies: HostIdentityDependencies = identityDependencies,
): Promise<boolean> {
  const [store, serverOrigin] = await Promise.all([
    dependencies.openHostPinStore(),
    dependencies.serverOrigin(),
  ]);
  const resolution = await store.resolve({
    accountId: input.accountId,
    serverOrigin,
    hostId: input.hostId,
    presentedHostPublicKey: input.hostPublicKey,
    phoneIdentityAvailable: true,
  });
  return resolution.status === "mismatch";
}

export function useHostIdentityConflictQuery(
  host: Pick<HostOut, "id" | "host_public_key"> | undefined,
) {
  const queryClient = useQueryClient();
  const accountId = useSyncExternalStore(
    subscribeDeviceIdentityAccount,
    activeDeviceIdentityAccount,
    activeDeviceIdentityAccount,
  );
  const hostId = host?.id ?? "";
  const hostPublicKey = host?.host_public_key ?? null;

  // An approval made or revoked anywhere in the app changes the answer.
  useEffect(
    () =>
      subscribeHostPinChanges(() => {
        void queryClient.invalidateQueries({ queryKey: qk.hostIdentityForHost(hostId) });
      }),
    [hostId, queryClient],
  );

  return useQuery({
    queryKey: qk.hostIdentity(hostId, hostPublicKey, accountId),
    queryFn: () =>
      accountId === null || hostPublicKey === null
        ? false
        : hostIdentityConflicts({ accountId, hostId, hostPublicKey }),
    enabled: hostId.length > 0 && hostPublicKey !== null && accountId !== null,
    retry: false,
  });
}

export function useHostsQuery({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.hosts(),
    queryFn: listHosts,
    refetchInterval: HOSTS_REFRESH_MS,
    enabled,
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

export function useHostPinsQuery(hostId: string) {
  return useQuery({
    queryKey: qk.hostPins(hostId),
    queryFn: () => getHostPins(hostId),
    enabled: hostId.length > 0,
    retry: false,
  });
}

export function useHostBrowserDevicesQuery(hostId: string) {
  return useQuery({
    queryKey: qk.browserDevices(),
    queryFn: listBrowserDevices,
    enabled: hostId.length > 0,
  });
}

function withHostUpdate(host: HostOut, update: HostUpdateOut): HostOut {
  return { ...host, update };
}

export function useUpdateHost(hostId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => updateHost(hostId),
    onSuccess: ({ update }) => {
      queryClient.setQueryData<HostOut>(qk.host(hostId), (host) =>
        host ? withHostUpdate(host, update) : host,
      );
      queryClient.setQueryData<HostOut[]>(qk.hosts(), (hosts) =>
        hosts?.map((host) => (host.id === hostId ? withHostUpdate(host, update) : host)),
      );
      if (update.state !== "updating") {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: qk.hosts() }),
          queryClient.invalidateQueries({ queryKey: qk.host(hostId) }),
        ]);
      }
    },
  });
}

export function useHostUpdatePolling(host: HostOut, enabled: boolean) {
  const queryClient = useQueryClient();
  const startedAtRef = useRef<number | null>(null);
  const sawUpdatingRef = useRef(false);
  const pollingHostIdRef = useRef(host.id);
  const query = useQuery({
    queryKey: qk.host(host.id),
    queryFn: () => getHost(host.id),
    enabled,
    placeholderData: host,
    refetchInterval: ({ state }) => {
      if (state.data?.update?.state !== "updating") return false;
      startedAtRef.current ??= Date.now();
      return Date.now() - startedAtRef.current < HOST_UPDATE_POLL_LIMIT_MS
        ? HOST_UPDATE_POLL_MS
        : false;
    },
  });

  useEffect(() => {
    pollingHostIdRef.current = host.id;
    startedAtRef.current = null;
    sawUpdatingRef.current = false;
  }, [host.id]);

  const state = query.data?.update?.state;
  useEffect(() => {
    if (state === "updating") {
      sawUpdatingRef.current = true;
      return;
    }
    if (!sawUpdatingRef.current) return;
    sawUpdatingRef.current = false;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.hosts() }),
      queryClient.invalidateQueries({ queryKey: qk.host(host.id) }),
    ]);
  }, [host.id, queryClient, state]);

  return query;
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

/**
 * Which agents a host has, checked when a person asks rather than on a timer.
 * The check is the server asking the host to run each agent's version probe
 * (`host.agents.check`), which is execution the server chooses the targets of
 * (docs/DAEMON_COMMAND_AUTHORITY.md) — so a host's page never repeats it on
 * its own, and opening the page does not start one.
 */
export function useHostAgentsQuery(hostId: string) {
  return useQuery({
    queryKey: qk.hostAgents(hostId),
    queryFn: () => listHostAgents(hostId),
    // Never on its own — not on mount, not when a "hosts" frame invalidates
    // the key, not when the network returns: only the caller's `refetch()`,
    // from a person's press, runs the probe. An answer already cached (from
    // a window's agent sheet, say) is still read.
    enabled: false,
    staleTime: HOST_AGENTS_STALE_MS,
  });
}

export function useAgentsQuery() {
  return useQuery({ queryKey: qk.agents(), queryFn: listAgents, staleTime: HOST_AGENTS_STALE_MS });
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
