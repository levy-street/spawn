"use client";

import { useSyncExternalStore } from "react";
import type { DaemonConnection } from "@/lib/daemon-connection";
import { type HostLiveStatus, hostLiveStatus } from "@/lib/host-live-status";
import { useDaemonConnection } from "./DaemonConnectionsProvider";

const NO_CONNECTION: DaemonConnection | null = null;
const noop = () => () => {};

/** A host's live status for this device: its connection, not only the server's word. */
export function useHostLiveStatus(
  host: { id: string; name: string; status: string } | null,
): HostLiveStatus | null {
  const connection = useDaemonConnection(host?.id ?? null) ?? NO_CONNECTION;
  const snapshot = useSyncExternalStore(
    connection?.subscribe ?? noop,
    () => connection?.getSnapshot() ?? null,
    () => null,
  );
  return host ? hostLiveStatus(host, snapshot) : null;
}
