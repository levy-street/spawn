import type { TransportState } from "@/terminal/transport/types";

export interface ReadinessGates {
  bindingAccepted: boolean;
  ptyOpen: boolean;
  ctlOpen: boolean;
  daemonReady: boolean;
  historyReady: boolean;
}

export interface ConnectionMachineState {
  phase: TransportState;
  gates: ReadinessGates;
  reconnectAttempt: number;
  reconnectDelayMs: number | null;
  retired: boolean;
}

export type ReadinessGate = keyof ReadinessGates;

export type TransportEvent =
  | { type: "open" }
  | { type: "signal-open" }
  | { type: "gate"; gate: ReadinessGate }
  | { type: "disconnect" }
  | { type: "retry" }
  | { type: "background" }
  | { type: "resume" }
  | { type: "close" }
  | { type: "fail" };

const EMPTY_GATES: ReadinessGates = {
  bindingAccepted: false,
  ptyOpen: false,
  ctlOpen: false,
  daemonReady: false,
  historyReady: false,
};

export const INITIAL_CONNECTION_STATE: ConnectionMachineState = {
  phase: "idle",
  gates: EMPTY_GATES,
  reconnectAttempt: 0,
  reconnectDelayMs: null,
  retired: false,
};

export function readinessComplete(gates: ReadinessGates): boolean {
  return (
    gates.bindingAccepted &&
    gates.ptyOpen &&
    gates.ctlOpen &&
    gates.daemonReady &&
    gates.historyReady
  );
}

export function reconnectDelay(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt));
}

export function reduceConnection(
  state: ConnectionMachineState,
  event: TransportEvent,
): ConnectionMachineState {
  switch (event.type) {
    case "open":
      if (state.phase !== "idle" && state.phase !== "closed") return state;
      return { ...INITIAL_CONNECTION_STATE, phase: "signalling" };
    case "signal-open":
      if (state.phase !== "signalling" && state.phase !== "reconnecting") return state;
      return { ...state, phase: "connecting", reconnectDelayMs: null };
    case "gate": {
      if (state.phase !== "connecting") return state;
      const gates = { ...state.gates, [event.gate]: true };
      return { ...state, gates, phase: readinessComplete(gates) ? "ready" : "connecting" };
    }
    case "disconnect": {
      if (state.phase === "closed" || state.phase === "failed" || state.retired) return state;
      const reconnectAttempt = state.reconnectAttempt + 1;
      return {
        ...state,
        phase: "reconnecting",
        gates: EMPTY_GATES,
        reconnectAttempt,
        reconnectDelayMs: reconnectDelay(reconnectAttempt - 1),
      };
    }
    case "retry":
      if (state.phase !== "reconnecting") return state;
      return { ...state, phase: "signalling", gates: EMPTY_GATES, reconnectDelayMs: null };
    case "background":
      return { ...state, phase: "closed", gates: EMPTY_GATES, retired: true };
    case "resume":
      if (!state.retired) return state;
      return { ...INITIAL_CONNECTION_STATE, phase: "signalling" };
    case "close":
      return { ...state, phase: "closed", gates: EMPTY_GATES, retired: true };
    case "fail":
      return { ...state, phase: "failed", gates: EMPTY_GATES, retired: true };
  }
}

/** Frozen public-state reducer. Detailed gate memory lives in reduceConnection. */
export function reduce(state: TransportState, event: TransportEvent): TransportState {
  return reduceConnection({ ...INITIAL_CONNECTION_STATE, phase: state }, event).phase;
}
