"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type Host, hosts, trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  readBrowserDeviceRevocationMarker,
  useBrowserDeviceRegistration,
} from "@/lib/browser-device-registration";
import { subscribeToBrowserHostPinChanges } from "@/lib/browser-host-pins";
import { type DaemonConnection, SharedDaemonConnection } from "@/lib/daemon-connection";
import { HostControlClient } from "@/lib/hostControl";
import { resolveSignedRtcTrust } from "@/lib/signed-rtc-trust";

const Connections = createContext<ReadonlyMap<string, DaemonConnection>>(new Map());

/** Connection ownership survives route changes and the last terminal closing. */
export function DaemonConnectionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth({ probe: "hinted" });
  const accountId = user?.id ?? null;
  const registration = useBrowserDeviceRegistration(user?.id);
  const deviceKey = registration.data?.status === "ready" ? registration.data.publicKey : null;
  const queryClient = useQueryClient();
  const hostQuery = useQuery({
    queryKey: ["hosts", "daemon-connections", accountId],
    queryFn: hosts.list,
    enabled: accountId !== null,
    refetchInterval: 30_000,
  });
  const records = useRef<ReadonlyMap<string, Host>>(new Map());
  records.current = new Map((hostQuery.data ?? []).map((host) => [host.id, host]));
  const activeAccount = useRef(accountId);
  activeAccount.current = accountId;
  const activeDevice = useRef(deviceKey);
  activeDevice.current = deviceKey;
  const owned = useRef(new Map<string, SharedDaemonConnection>());
  const [connections, setConnections] = useState<ReadonlyMap<string, DaemonConnection>>(new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: an account or device-key change retires every connection.
  useEffect(() => {
    const current = owned.current;
    return () => {
      for (const connection of current.values()) connection.close();
      current.clear();
    };
  }, [accountId, deviceKey]);

  useEffect(() => {
    if (!accountId || !deviceKey) {
      setConnections(new Map());
      return;
    }
    const current = owned.current;
    const isActive = () => {
      if (activeAccount.current !== accountId || activeDevice.current !== deviceKey) return false;
      try {
        return readBrowserDeviceRevocationMarker(accountId) === null;
      } catch {
        return false;
      }
    };
    for (const [id, connection] of current) {
      if (!records.current.has(id)) {
        connection.close();
        current.delete(id);
      }
    }
    for (const host of hostQuery.data ?? []) {
      if (current.has(host.id) || host.status !== "online") continue;
      const id = host.id;
      current.set(
        id,
        new SharedDaemonConnection(
          `${accountId}:${deviceKey}:${id}`,
          () =>
            new HostControlClient(id, {
              deviceConnection: true,
              resolveSignedRtcTrust: () =>
                resolveSignedRtcTrust({
                  accountId,
                  hostId: id,
                  claimedHostPublicKey: records.current.get(id)?.host_public_key ?? null,
                  isActive: () => isActive() && records.current.has(id),
                }),
              loadCarriedEndorsements: async () => {
                const edges = await queryClient.fetchQuery({
                  queryKey: ["account-endorsements", accountId],
                  queryFn: trust.accountEndorsements,
                  // A retry must see approval granted by another device since
                  // the refused offer. This only fetches when negotiating.
                  staleTime: 0,
                });
                return edges.map((edge) => ({ account_id: accountId, ...edge }));
              },
            }),
          isActive,
        ),
      );
    }
    setConnections(new Map(current));
  }, [accountId, deviceKey, hostQuery.data, queryClient]);

  useEffect(
    () =>
      subscribeToBrowserHostPinChanges((changed) => {
        for (const connection of owned.current.values()) connection.retry(!changed);
      }),
    [],
  );

  return (
    <Connections.Provider value={accountId ? connections : new Map()}>
      {children}
      <div className="pointer-events-none fixed inset-x-2 top-2 z-50 flex flex-col gap-2">
        {accountId &&
          [...connections].map(([id, connection]) => (
            <DaemonNotice
              key={id}
              connection={connection}
              name={records.current.get(id)?.name ?? "host"}
            />
          ))}
      </div>
    </Connections.Provider>
  );
}

function DaemonNotice({ connection, name }: { connection: DaemonConnection; name: string }) {
  const snapshot = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
    connection.getSnapshot,
  );
  const wasReady = useRef(false);
  if (snapshot.state === "ready") wasReady.current = true;
  if (
    snapshot.state === "ready" ||
    (!wasReady.current && !snapshot.error && snapshot.state !== "error")
  )
    return null;
  return (
    <div
      role="status"
      className="pointer-events-auto mx-auto flex max-w-xl items-center gap-3 rounded-md border border-warning/45 bg-background/95 px-3 py-2 text-xs shadow-lg"
    >
      <span>
        {snapshot.error
          ? `${name}: ${snapshot.error}`
          : `Reconnecting to ${name}. Terminal input is paused.`}
      </span>
      <button
        type="button"
        aria-label={`Retry connection to ${name}`}
        className="rounded border border-border px-2 py-1"
        onClick={() => connection.retry()}
      >
        Retry
      </button>
    </div>
  );
}

export function useDaemonConnection(hostId: string | null): DaemonConnection | null {
  return useContext(Connections).get(hostId ?? "") ?? null;
}

export function useDaemonConnections(): ReadonlyMap<string, DaemonConnection> {
  return useContext(Connections);
}
