import type { NetworkSnapshot, NetworkSource } from "@/data/realtime/lifecycle";

export interface ProductionNetworkSource extends NetworkSource {
  reportSocketFailure(): void;
  reportSocketOpen(): void;
}

const INITIAL_NETWORK_TYPE = "socket-observed:0";

/**
 * The frozen Expo dependency set has no native reachability package. This source
 * turns an established socket failure into a network epoch so lifecycle recovery
 * still retires stale generations instead of trusting the old path.
 */
export function createProductionNetworkSource(): ProductionNetworkSource {
  const listeners = new Set<(state: NetworkSnapshot) => void>();
  let epoch = 0;
  let failureReported = false;
  let snapshot: NetworkSnapshot = {
    isConnected: true,
    isInternetReachable: null,
    type: INITIAL_NETWORK_TYPE,
  };

  const emit = () => {
    for (const listener of listeners) listener(snapshot);
  };

  return {
    addEventListener: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    reportSocketFailure: () => {
      if (failureReported) return;
      failureReported = true;
      epoch += 1;
      snapshot = {
        isConnected: true,
        isInternetReachable: null,
        type: `socket-observed:${epoch}`,
      };
      emit();
    },
    reportSocketOpen: () => {
      failureReported = false;
      if (snapshot.isInternetReachable === true) return;
      snapshot = { ...snapshot, isInternetReachable: true };
      emit();
    },
  };
}
