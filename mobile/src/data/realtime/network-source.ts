import type { NetworkSnapshot, NetworkSource } from "@/data/realtime/lifecycle";

export interface ProductionNetworkSource extends NetworkSource {
  reportSocketFailure(): void;
  reportSocketOpen(): void;
}

const INITIAL_NETWORK_TYPE = "socket-observed:0";

interface ExpoNetworkModule {
  addNetworkStateListener(
    listener: (state: {
      isConnected?: boolean;
      isInternetReachable?: boolean;
      type?: unknown;
    }) => void,
  ): { remove?: () => void } | (() => void);
  getNetworkStateAsync?(): Promise<{
    isConnected?: boolean;
    isInternetReachable?: boolean;
    type?: unknown;
  }>;
}

function guardedExpoNetwork(): ExpoNetworkModule | null {
  try {
    // This must remain guarded: an OTA can run on the previous native runtime,
    // where resolving expo-network throws because its native module is absent.
    return require("expo-network") as ExpoNetworkModule;
  } catch {
    return null;
  }
}

/** Native reachability when present, socket-observed epochs on older builds. */
export function createProductionNetworkSource(
  expoNetworkOverride?: ExpoNetworkModule | null,
): ProductionNetworkSource {
  const expoNetwork =
    expoNetworkOverride === undefined ? guardedExpoNetwork() : expoNetworkOverride;
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

  const adoptNativeState = (state: {
    isConnected?: boolean;
    isInternetReachable?: boolean;
    type?: unknown;
  }) => {
    snapshot = {
      isConnected: typeof state.isConnected === "boolean" ? state.isConnected : null,
      isInternetReachable:
        typeof state.isInternetReachable === "boolean" ? state.isInternetReachable : null,
      type: `native:${String(state.type ?? "unknown")}`,
    };
    emit();
  };
  let removeNativeSubscription: (() => void) | null = null;

  return {
    addEventListener: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      if (expoNetwork && removeNativeSubscription === null) {
        try {
          const subscription = expoNetwork.addNetworkStateListener(adoptNativeState);
          removeNativeSubscription =
            typeof subscription === "function"
              ? subscription
              : typeof subscription.remove === "function"
                ? () => subscription.remove?.()
                : () => undefined;
          void expoNetwork
            .getNetworkStateAsync?.()
            .then(adoptNativeState)
            .catch(() => undefined);
        } catch {
          removeNativeSubscription = null;
        }
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          removeNativeSubscription?.();
          removeNativeSubscription = null;
        }
      };
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
