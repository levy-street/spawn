import { create } from "zustand";

import type { SocketState } from "@/data/realtime/socket";
import type { TransportState } from "@/terminal/transport/types";

interface ConnectionStoreState {
  alertSocket: SocketState;
  sessionSignals: Record<string, SocketState>;
  hostSignals: Record<string, SocketState>;
  sessionTransports: Record<string, TransportState>;
  hostTransports: Record<string, TransportState>;
  /** Why a host's connection needs attention, when it does. */
  hostProblems: Record<string, string>;
  /** Hosts this device has been connected to since it opened: only these can
   *  be "reconnecting" rather than still connecting for the first time. */
  hostsSeenReady: Record<string, true>;
  /** Retry a host's connection now, from wherever its state is shown. */
  hostRetries: Record<string, () => void>;
  setHostProblem: (hostId: string, problem: string | null) => void;
  setHostRetry: (hostId: string, retry: (() => void) | null) => void;
  setAlertSocket: (state: SocketState) => void;
  setSessionSignal: (sessionId: string, state: SocketState) => void;
  setHostSignal: (hostId: string, state: SocketState) => void;
  setSessionTransport: (sessionId: string, state: TransportState) => void;
  setHostTransport: (hostId: string, state: TransportState) => void;
  removeSession: (sessionId: string) => void;
  removeHost: (hostId: string) => void;
  reset: () => void;
}

const EMPTY_CONNECTIONS = {
  alertSocket: "idle" as const,
  sessionSignals: {},
  hostSignals: {},
  sessionTransports: {},
  hostTransports: {},
  hostProblems: {},
  hostsSeenReady: {},
  hostRetries: {},
};

export const useConnectionStore = create<ConnectionStoreState>((set) => ({
  ...EMPTY_CONNECTIONS,
  setAlertSocket: (alertSocket) => set({ alertSocket }),
  setSessionSignal: (sessionId, state) => {
    set((current) => ({ sessionSignals: { ...current.sessionSignals, [sessionId]: state } }));
  },
  setHostSignal: (hostId, state) => {
    set((current) => ({ hostSignals: { ...current.hostSignals, [hostId]: state } }));
  },
  setSessionTransport: (sessionId, state) => {
    set((current) => ({
      sessionTransports: { ...current.sessionTransports, [sessionId]: state },
    }));
  },
  setHostTransport: (hostId, state) => {
    set((current) => ({
      hostTransports: { ...current.hostTransports, [hostId]: state },
      ...(state === "ready" && !current.hostsSeenReady[hostId]
        ? { hostsSeenReady: { ...current.hostsSeenReady, [hostId]: true as const } }
        : {}),
    }));
  },
  setHostProblem: (hostId, problem) => {
    set((current) => {
      const { [hostId]: _previous, ...rest } = current.hostProblems;
      return { hostProblems: problem ? { ...rest, [hostId]: problem } : rest };
    });
  },
  setHostRetry: (hostId, retry) => {
    set((current) => {
      const { [hostId]: _previous, ...rest } = current.hostRetries;
      return { hostRetries: retry ? { ...rest, [hostId]: retry } : rest };
    });
  },
  removeSession: (sessionId) => {
    set((current) => {
      const { [sessionId]: _signal, ...sessionSignals } = current.sessionSignals;
      const { [sessionId]: _transport, ...sessionTransports } = current.sessionTransports;
      return { sessionSignals, sessionTransports };
    });
  },
  removeHost: (hostId) => {
    set((current) => {
      const { [hostId]: _signal, ...hostSignals } = current.hostSignals;
      const { [hostId]: _transport, ...hostTransports } = current.hostTransports;
      const { [hostId]: _problem, ...hostProblems } = current.hostProblems;
      const { [hostId]: _retry, ...hostRetries } = current.hostRetries;
      const { [hostId]: _seen, ...hostsSeenReady } = current.hostsSeenReady;
      return { hostSignals, hostTransports, hostProblems, hostRetries, hostsSeenReady };
    });
  },
  reset: () => set(EMPTY_CONNECTIONS),
}));
