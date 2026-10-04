"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { DaemonConnection } from "@/lib/daemon-connection";
import { deriveHostOffers, type HostOffers, NO_HOST_OFFERS } from "@/lib/host-offers";
import { useDaemonConnection } from "./DaemonConnectionsProvider";

const NO_CONNECTION: DaemonConnection | null = null;
const NO_CAPABILITIES: readonly string[] = [];
const noop = () => () => {};

/**
 * What this host's page offers beyond its fixed tabs, from the capabilities
 * the host announced on this device's own connection to it. No connection —
 * offline, or this device not approved — offers nothing extra.
 */
export function useHostOffers(hostId: string | null): HostOffers {
  const connection = useDaemonConnection(hostId) ?? NO_CONNECTION;
  const capabilities = useSyncExternalStore(
    connection?.subscribe ?? noop,
    () => connection?.getSnapshot().capabilities ?? NO_CAPABILITIES,
    () => NO_CAPABILITIES,
  );
  return useMemo(
    () => (capabilities.length === 0 ? NO_HOST_OFFERS : deriveHostOffers(capabilities)),
    [capabilities],
  );
}
