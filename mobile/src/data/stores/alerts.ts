import { create } from "zustand";

import type { AlertEvent } from "@/data/realtime/alert-socket";

export const ALERT_DEDUP_TTL_MS = 30_000;
export const MAX_IN_MEMORY_ALERTS = 100;
const MAX_TRACKED_KEYS = 256;

export interface StoredAlert {
  key: string;
  alert: AlertEvent;
  receivedAt: number;
}

interface AlertStoreState {
  alerts: StoredAlert[];
  seenKeys: Record<string, number>;
  claimedKeys: Record<string, number>;
  receive: (alert: AlertEvent, receivedAt?: number) => boolean;
  claim: (key: string, claimedAt?: number) => boolean;
  remove: (key: string) => void;
  removeSession: (sessionId: string) => void;
  clear: () => void;
}

export function alertEventKey(alert: AlertEvent): string {
  return `${alert.event}:${alert.session_id}:${alert.at}`;
}

function pruneKeys(keys: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(keys)
      .filter(([, expiresAt]) => expiresAt > now)
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_TRACKED_KEYS),
  );
}

export const useAlertStore = create<AlertStoreState>((set, get) => ({
  alerts: [],
  seenKeys: {},
  claimedKeys: {},
  receive: (alert, receivedAt = Date.now()) => {
    const key = alertEventKey(alert);
    const seenKeys = pruneKeys(get().seenKeys, receivedAt);
    if (seenKeys[key] !== undefined) {
      set({ seenKeys });
      return false;
    }
    seenKeys[key] = receivedAt + ALERT_DEDUP_TTL_MS;
    set((state) => ({
      seenKeys,
      alerts: [{ key, alert, receivedAt }, ...state.alerts].slice(0, MAX_IN_MEMORY_ALERTS),
    }));
    return true;
  },
  claim: (key, claimedAt = Date.now()) => {
    const claimedKeys = pruneKeys(get().claimedKeys, claimedAt);
    if (claimedKeys[key] !== undefined) {
      set({ claimedKeys });
      return false;
    }
    claimedKeys[key] = claimedAt + ALERT_DEDUP_TTL_MS;
    set({ claimedKeys });
    return true;
  },
  remove: (key) => {
    set((state) => ({ alerts: state.alerts.filter((item) => item.key !== key) }));
  },
  removeSession: (sessionId) => {
    set((state) => ({
      alerts: state.alerts.filter((item) => item.alert.session_id !== sessionId),
    }));
  },
  clear: () => {
    set({ alerts: [], seenKeys: {}, claimedKeys: {} });
  },
}));
