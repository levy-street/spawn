import { useConnectionStore } from "@/data/stores/connection";

describe("connection store", () => {
  beforeEach(() => {
    useConnectionStore.getState().reset();
  });

  it("tracks socket and transport states by scope", () => {
    const store = useConnectionStore.getState();
    store.setAlertSocket("open");
    store.setSessionSignal("session-1", "connecting");
    store.setHostSignal("host-1", "reconnecting");
    store.setSessionTransport("session-1", "ready");
    store.setHostTransport("host-1", "failed");

    expect(useConnectionStore.getState()).toMatchObject({
      alertSocket: "open",
      sessionSignals: { "session-1": "connecting" },
      hostSignals: { "host-1": "reconnecting" },
      sessionTransports: { "session-1": "ready" },
      hostTransports: { "host-1": "failed" },
    });
  });

  it("cleans session and host scopes independently", () => {
    const store = useConnectionStore.getState();
    store.setSessionSignal("session-1", "open");
    store.setSessionTransport("session-1", "ready");
    store.setHostSignal("host-1", "open");
    store.setHostTransport("host-1", "ready");

    store.removeSession("session-1");
    expect(useConnectionStore.getState().sessionSignals).toEqual({});
    expect(useConnectionStore.getState().hostSignals).toEqual({ "host-1": "open" });

    store.removeHost("host-1");
    expect(useConnectionStore.getState().hostTransports).toEqual({});
  });
});
