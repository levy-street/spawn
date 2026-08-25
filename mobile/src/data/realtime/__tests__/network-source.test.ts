import {
  installRealtimeLifecycle,
  type NetworkSnapshot,
  type NetworkSource,
} from "@/data/realtime/lifecycle";
import { createProductionNetworkSource } from "@/data/realtime/network-source";

function manualNetworkSource(): {
  source: NetworkSource;
  emit(state: NetworkSnapshot): void;
} {
  const listeners = new Set<(state: NetworkSnapshot) => void>();
  return {
    source: {
      addEventListener: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit: (state) => {
      for (const listener of listeners) listener(state);
    },
  };
}

function activeAppStateSource() {
  return {
    currentState: "active" as const,
    addEventListener: () => ({ remove: jest.fn() }),
  };
}

function recoveryHarness(source: NetworkSource) {
  const order: string[] = [];
  const controller = installRealtimeLifecycle({
    appStateSource: activeAppStateSource(),
    managers: { setFocused: jest.fn(), setOnline: jest.fn() },
    networkSource: source,
    retireAll: (reason) => order.push(`retire:${reason}`),
    resume: {
      reconnectSockets: () => {
        order.push("reconnect");
      },
      refetchActiveQueries: () => {
        order.push("refetch");
      },
      reopenVisibleTransports: () => {
        order.push("transports");
      },
    },
  });
  return { controller, order };
}

const WIFI: NetworkSnapshot = {
  isConnected: true,
  isInternetReachable: true,
  type: "wifi",
};

describe("production network source fallback", () => {
  it("forces retirement before reconnect after an established socket fails", async () => {
    const source = createProductionNetworkSource(null);
    const { controller, order } = recoveryHarness(source);

    source.reportSocketOpen();
    source.reportSocketFailure();
    await controller.whenIdle();

    expect(order).toEqual(["retire:interface-change", "reconnect", "refetch", "transports"]);
    controller.dispose();
  });

  it("coalesces one failure episode until the socket opens again", () => {
    const source = createProductionNetworkSource(null);
    const snapshots: NetworkSnapshot[] = [];
    const unsubscribe = source.addEventListener((snapshot) => snapshots.push(snapshot));

    source.reportSocketFailure();
    source.reportSocketFailure();
    source.reportSocketOpen();
    source.reportSocketFailure();

    expect(snapshots.map((snapshot) => snapshot.type)).toEqual([
      "socket-observed:0",
      "socket-observed:1",
      "socket-observed:1",
      "socket-observed:2",
    ]);
    unsubscribe();
  });

  it("prefers native interface changes when the next app build provides expo-network", () => {
    let emitNative: ((state: { type?: unknown; isConnected?: boolean }) => void) | undefined;
    const remove = jest.fn();
    const source = createProductionNetworkSource({
      addNetworkStateListener: (listener) => {
        emitNative = listener;
        return { remove };
      },
    });
    const snapshots: NetworkSnapshot[] = [];
    const unsubscribe = source.addEventListener((snapshot) => snapshots.push(snapshot));

    emitNative?.({ type: "CELLULAR", isConnected: true });
    expect(snapshots.at(-1)).toEqual({
      type: "native:CELLULAR",
      isConnected: true,
      isInternetReachable: null,
    });

    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("network recovery ordering", () => {
  it("treats an interface change as retire then reconnect", async () => {
    const network = manualNetworkSource();
    const { controller, order } = recoveryHarness(network.source);

    network.emit(WIFI);
    network.emit({ ...WIFI, type: "cellular" });
    await controller.whenIdle();

    expect(order).toEqual(["retire:interface-change", "reconnect", "refetch", "transports"]);
    controller.dispose();
  });

  it("runs the documented sweep after an offline-to-online edge", async () => {
    const network = manualNetworkSource();
    const { controller, order } = recoveryHarness(network.source);

    network.emit(WIFI);
    network.emit({ ...WIFI, isConnected: false, isInternetReachable: false });
    network.emit(WIFI);
    await controller.whenIdle();

    expect(order).toEqual([
      "retire:offline",
      "retire:interface-change",
      "reconnect",
      "refetch",
      "transports",
    ]);
    controller.dispose();
  });
});
