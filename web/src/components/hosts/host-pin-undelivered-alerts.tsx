"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "@/components/ui/toast";
import { subscribeToTrustEvents } from "@/lib/alert-socket";
import { hosts } from "@/lib/api";
import { hostPinUndeliveredEventToast } from "@/lib/host-pin-hygiene";

/**
 * Global delivery failures for host approvals. The event carries stable ids;
 * the host name is resolved locally so the toast can use the contract's plain
 * sentence without trusting an event-supplied display label.
 */
export function HostPinUndeliveredAlerts({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const hostList = useQuery({
    queryKey: ["hosts"],
    queryFn: () => hosts.list(),
    enabled,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!enabled) return;
    return subscribeToTrustEvents((event) => {
      if (event.event !== "host.pin_undelivered") return;
      void (async () => {
        const cached = hostList.data?.find((host) => host.id === event.host_id);
        const hostName =
          cached?.name ?? (await hosts.get(event.host_id).catch(() => null))?.name ?? "the host";
        toast.error(hostPinUndeliveredEventToast(event, hostName));
        void queryClient.invalidateQueries({ queryKey: ["trust", "host-pins", event.host_id] });
        void queryClient.invalidateQueries({ queryKey: ["trust", "host-pin-map"] });
        void queryClient.invalidateQueries({ queryKey: ["trust", "host-pin-details"] });
      })();
    });
  }, [enabled, hostList.data, queryClient]);

  return null;
}
