"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { subscribeToDataEvents } from "@/lib/alert-socket";
import type { DataEvent } from "@/lib/alerts";
import { CLIENT_INSTANCE_ID } from "@/lib/client-instance";

/**
 * Every open client shows the same account at the same moment.
 *
 * The server publishes one content-free frame per successful mutation of
 * client-visible data (`server/spawn_server/data_events.py`) — a tab added on
 * the phone, a session started on the host itself, a workspace renamed in
 * another browser — and this hook turns each into an invalidation of the
 * queries that render that resource. TanStack refetches only what is mounted,
 * so the cost of a frame nobody is looking at is nothing.
 *
 * Mounted exactly once, in the app shell, beside `useSessionAlerts` and for
 * the same reason: it reads the shared query caches and must not care that
 * the shell remounts on every route change.
 *
 * Frames this tab caused are skipped by the `origin` echo. That is not an
 * optimisation but a correctness rule for the one writer with in-flight
 * optimistic state: a layout PATCH mid-drag must not race a refetch of the
 * very layout it is about to replace. Mutations already settle their own
 * caches on response.
 */

/** Query-key prefixes to invalidate per resource frame. `["workspace"]`
 *  covers every `["workspace", id]` detail by prefix match. */
const RESOURCE_KEYS: Record<string, (id: string | null) => string[][]> = {
  workspaces: () => [["workspaces"], ["workspace"]],
  "workspace-templates": () => [["workspace-templates"]],
  sessions: (id) => (id ? [["sessions"], ["session", id]] : [["sessions"], ["session"]]),
  hosts: () => [["hosts"], ["host"], ["host-agents"]],
  agents: () => [["agents"], ["skills"]],
  profile: () => [["me"]],
};

export function useLiveData(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    return subscribeToDataEvents((event: DataEvent) => {
      if (event.origin === CLIENT_INSTANCE_ID) return;
      // An unmapped resource is a future server talking; nothing to refetch.
      const keys = RESOURCE_KEYS[event.resource]?.(event.id) ?? [];
      for (const queryKey of keys) {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
  }, [queryClient]);
}
