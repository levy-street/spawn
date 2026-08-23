import { create } from "zustand";

import type { SocketState } from "@/data/realtime/socket";
import type { TransportState } from "@/terminal/transport/types";

interface ConnectionStoreState {
  alertSocket: SocketState;
  sessionSignals: Record<string, SocketState>;
  hostSignals: Record<string, SocketState>;
  sessionTransports: Record<string, TransportState>;
  hostTransports: Record<string, TransportState>;
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
    set((current) => ({ hostTransports: { ...current.hostTransports, [hostId]: state } }));
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
      return { hostSignals, hostTransports };
    });
  },
  reset: () => set(EMPTY_CONNECTIONS),
}));
