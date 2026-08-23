import {
  installRealtimeLifecycle,
  type NetworkSnapshot,
  registerRealtimeGenerationTarget,
  reopenRegisteredGenerations,
  retireRegisteredGenerations,
  runResumeSweep,
} from "@/data/realtime/lifecycle";

const WIFI: NetworkSnapshot = {
  isConnected: true,
  isInternetReachable: true,
  type: "wifi",
};

function harness(initialAppState: "active" | "background" = "active") {
  const order: string[] = [];
  const appListeners = new Set<(state: "active" | "background" | "inactive") => void>();
  const networkListeners = new Set<(state: NetworkSnapshot) => void>();
  const controller = installRealtimeLifecycle({
    appStateSource: {
      currentState: initialAppState,
      addEventListener: (_type, listener) => {
        appListeners.add(listener);
        return { remove: () => appListeners.delete(listener) };
      },
    },
    networkSource: {
      addEventListener: (listener) => {
        networkListeners.add(listener);
        return () => networkListeners.delete(listener);
      },
    },
    managers: {
      setFocused: (focused) => order.push(`focused:${focused}`),
      setOnline: (online) => order.push(`online:${online}`),
    },
    retireAll: (reason) => order.push(`retire:${reason}`),
    resume: {
      reconnectSockets: () => {
        order.push("resume:reconnect");
      },
      refetchActiveQueries: () => {
        order.push("resume:refetch");
      },
      reopenVisibleTransports: () => {
        order.push("resume:transports");
      },
    },
  });
  return {
    controller,
    order,
    emitAppState: (state: "active" | "background" | "inactive") => {
      for (const listener of appListeners) listener(state);
    },
    emitNetwork: (state: NetworkSnapshot) => {
      for (const listener of networkListeners) listener(state);
    },
    appListeners,
    networkListeners,
  };
}

describe("runResumeSweep", () => {
  it("reconnects, refetches, then reopens visible transports", async () => {
    const order: string[] = [];
    await runResumeSweep({
      reconnectSockets: async () => {
        order.push("reconnect");
      },
      refetchActiveQueries: async () => {
        order.push("refetch");
      },
      reopenVisibleTransports: async () => {
        order.push("transports");
      },
    });
    expect(order).toEqual(["reconnect", "refetch", "transports"]);
  });
});

describe("realtime generation registry", () => {
  it("retires and reopens only registered transports", async () => {
    const events: string[] = [];
    const unregister = registerRealtimeGenerationTarget({
      retire: (reason) => events.push(`retire:${reason}`),
      reopen: () => {
        events.push("reopen");
      },
    });

    retireRegisteredGenerations("interface-change");
    await reopenRegisteredGenerations();
    unregister();
    retireRegisteredGenerations("background");
    expect(events).toEqual(["retire:interface-change", "reopen"]);
  });
});

describe("installRealtimeLifecycle", () => {
  it("retires all generations on background and sweeps on resume", async () => {
    const { controller, emitAppState, order } = harness();
    emitAppState("background");
    expect(order).toEqual(["focused:true", "focused:false", "retire:background"]);

    emitAppState("active");
    await controller.whenIdle();
    expect(order.slice(-4)).toEqual([
      "focused:true",
      "resume:reconnect",
      "resume:refetch",
      "resume:transports",
    ]);
  });

  it("marks inactive as unfocused without retiring twice", () => {
    const { emitAppState, order } = harness();
    emitAppState("inactive");
    emitAppState("inactive");
    expect(order).toEqual(["focused:true", "focused:false"]);
  });

  it("sets online state and hard-reconnects on an interface change", async () => {
    const { controller, emitNetwork, order } = harness();
    emitNetwork(WIFI);
    emitNetwork({ ...WIFI, type: "cellular" });
    await controller.whenIdle();

    expect(order).toContain("online:true");
    expect(order).toContain("retire:interface-change");
    expect(order.slice(-3)).toEqual(["resume:reconnect", "resume:refetch", "resume:transports"]);
  });

  it("retires offline and recovers on the online edge", async () => {
    const { controller, emitNetwork, order } = harness();
    emitNetwork(WIFI);
    emitNetwork({ ...WIFI, isConnected: false, isInternetReachable: false });
    expect(order).toContain("online:false");
    expect(order).toContain("retire:offline");

    emitNetwork(WIFI);
    await controller.whenIdle();
    expect(order.slice(-4)).toEqual([
      "retire:interface-change",
      "resume:reconnect",
      "resume:refetch",
      "resume:transports",
    ]);
  });

  it("cleans up both subscriptions", () => {
    const { controller, appListeners, networkListeners } = harness();
    expect(appListeners.size).toBe(1);
    expect(networkListeners.size).toBe(1);
    controller.dispose();
    expect(appListeners.size).toBe(0);
    expect(networkListeners.size).toBe(0);
  });
});
