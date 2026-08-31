import {
  type ConnectionMachineState,
  INITIAL_CONNECTION_STATE,
  type ReadinessGate,
  reconnectDelay,
  reduceConnection,
} from "@/terminal/transport/state-machine";

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [Array.from(values)];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index)).map((tail) => [
      value,
      ...tail,
    ]),
  );
}

describe("transport readiness state machine", () => {
  const gates: ReadinessGate[] = [
    "bindingAccepted",
    "ptyOpen",
    "ctlOpen",
    "daemonReady",
    "historyReady",
  ];

  test("becomes ready only after every gate, in every arrival order", () => {
    for (const order of permutations(gates)) {
      let state = reduceConnection(INITIAL_CONNECTION_STATE, { type: "open" });
      state = reduceConnection(state, { type: "signal-open" });
      for (const [index, gate] of order.entries()) {
        state = reduceConnection(state, { type: "gate", gate });
        expect(state.phase).toBe(index === order.length - 1 ? "ready" : "connecting");
      }
    }
  });

  test("uses capped exponential reconnect delays and resets gates", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    let state: ConnectionMachineState = { ...INITIAL_CONNECTION_STATE, phase: "ready" };
    const observed: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      state = reduceConnection(state, { type: "disconnect" });
      observed.push(state.reconnectDelayMs ?? 0);
      state = reduceConnection(state, { type: "retry" });
      state = { ...state, phase: "ready" };
    }
    expect(observed).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(reconnectDelay(99, 0.5)).toBe(30_000);
    jest.restoreAllMocks();
  });

  test("accepts a fresh signal from ready and resets the ladder when gates reopen", () => {
    let state: ConnectionMachineState = {
      ...INITIAL_CONNECTION_STATE,
      phase: "ready",
      reconnectAttempt: 4,
    };
    state = reduceConnection(state, { type: "signal-open" });
    expect(state).toMatchObject({ phase: "connecting", reconnectAttempt: 4 });
    for (const gate of gates) state = reduceConnection(state, { type: "gate", gate });
    expect(state).toMatchObject({ phase: "ready", reconnectAttempt: 0 });
  });

  test("retires on background and can resume with a clean generation", () => {
    const active = { ...INITIAL_CONNECTION_STATE, phase: "ready" as const };
    const retired = reduceConnection(active, { type: "background" });
    expect(retired).toMatchObject({ phase: "closed", retired: true });
    expect(reduceConnection(retired, { type: "disconnect" })).toEqual(retired);
    expect(reduceConnection(retired, { type: "resume" })).toMatchObject({
      phase: "signalling",
      retired: false,
      reconnectAttempt: 0,
    });
  });

  test("terminal failures never reconnect", () => {
    const failed = reduceConnection(
      { ...INITIAL_CONNECTION_STATE, phase: "connecting" },
      { type: "fail" },
    );
    expect(failed.phase).toBe("failed");
    expect(reduceConnection(failed, { type: "disconnect" })).toEqual(failed);
  });
});
