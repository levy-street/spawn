"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  type HostControlPresence,
  hostControlPresence,
  subscribe,
} from "@/lib/host-control-presence";

export function useHostControlPresence(hostId: string): HostControlPresence | null {
  const getSnapshot = useCallback(() => hostControlPresence(hostId), [hostId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
