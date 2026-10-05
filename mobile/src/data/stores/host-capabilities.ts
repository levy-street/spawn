import { useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";

import { deriveHostOffers, type HostOffers } from "@/data/selectors/host-offers";
import { activeDeviceIdentityAccount, subscribeDeviceIdentityAccount } from "@/lib/crypto/identity";

/**
 * The capabilities each host last advertised to this device, from the hello on
 * a channel this device opened to it. Held in memory only, and per account:
 * another account's hosts, or this one's under a device key since replaced,
 * are never read back.
 */
interface HostCapabilitiesState {
  byHost: Readonly<Record<string, readonly string[]>>;
  record(key: string, operations: readonly string[]): void;
}

const useHostCapabilitiesStore = create<HostCapabilitiesState>((set) => ({
  byHost: {},
  record: (key, operations) =>
    set((current) => {
      const held = current.byHost[key];
      if (
        held !== undefined &&
        held.length === operations.length &&
        held.every((operation, index) => operation === operations[index])
      ) {
        return current;
      }
      return { byHost: { ...current.byHost, [key]: [...operations] } };
    }),
}));

function capabilityKey(account: string | null, hostId: string): string {
  return `${account ?? ""}\u0000${hostId}`;
}

/** Keep what a host's hello said, for the account this device is signed in as. */
export function recordHostCapabilities(hostId: string, operations: readonly string[]): void {
  useHostCapabilitiesStore
    .getState()
    .record(capabilityKey(activeDeviceIdentityAccount(), hostId), operations);
}

/** What the host last advertised to this device, or null before any hello. */
export function useHostCapabilities(hostId: string): readonly string[] | null {
  const account = useSyncExternalStore(
    subscribeDeviceIdentityAccount,
    activeDeviceIdentityAccount,
    activeDeviceIdentityAccount,
  );
  return useHostCapabilitiesStore((state) => state.byHost[capabilityKey(account, hostId)] ?? null);
}

/** The cockpit's offers for a host, from its last hello (`deriveHostOffers`). */
export function useHostOffers(hostId: string): HostOffers {
  const capabilities = useHostCapabilities(hostId);
  return useMemo(() => deriveHostOffers(capabilities), [capabilities]);
}

/** Tests only: forget every hello. */
export function resetHostCapabilities(): void {
  useHostCapabilitiesStore.setState({ byHost: {} });
}
