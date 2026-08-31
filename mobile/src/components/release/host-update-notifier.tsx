import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useToast } from "@/components/ui/toast";
import { updateHost } from "@/data/api/endpoints/hosts";
import { useHostsQuery } from "@/data/queries/hosts";
import { qk } from "@/data/queryKeys";

/**
 * The standing notice that a machine has an update, and the one that says it
 * is being taken. The web app's `HostUpdateNotifier`, in this app's idiom.
 *
 * An update waiting to be taken is a condition, not an event, so the notice
 * stays until it is answered — a notification that fades after five seconds
 * has told nobody anything they could act on. Dismissing means "not now" and
 * lasts until the machine reaches `current`, at which point the *next* update
 * is a new question.
 *
 * Progress is indeterminate on purpose: the daemon reports update state and
 * never byte counts, so a percentage here would be invented.
 */

const DISMISSED = new Set<string>();

export function HostUpdateNotifier(): null {
  const toast = useToast();
  const queryClient = useQueryClient();
  const hostsQ = useHostsQuery();
  const noticeIds = useRef(new Map<string, string>());

  const updateM = useMutation({
    mutationFn: (hostId: string) => updateHost(hostId),
    onSuccess: (_result, hostId) => {
      void queryClient.invalidateQueries({ queryKey: qk.hosts() });
      void queryClient.invalidateQueries({ queryKey: qk.host(hostId) });
    },
    onError: (caught, hostId) => {
      const notice = noticeIds.current.get(hostId);
      if (notice !== undefined) {
        toast.dismiss(notice);
        noticeIds.current.delete(hostId);
      }
      toast.error(`The update could not be started: ${String(caught)}`);
    },
  });

  useEffect(() => {
    const list = hostsQ.data;
    if (!list) return;

    const seen = new Set<string>();
    for (const host of list) {
      seen.add(host.id);
      const state = host.update?.state ?? "unknown";
      const existing = noticeIds.current.get(host.id);

      // An offline machine updates itself when it next connects. There is no
      // button to offer, so there is nothing to say every few seconds.
      const wanted = (state === "available" && host.status === "online") || state === "updating";

      if (!wanted) {
        if (existing !== undefined) {
          toast.dismiss(existing);
          noticeIds.current.delete(host.id);
        }
        if (state === "current") DISMISSED.delete(host.id);
        continue;
      }

      if (state === "updating") {
        const body = {
          detail: "The daemon restarts itself. Sessions keep running.",
          persistent: true,
          progress: "indeterminate" as const,
        };
        if (existing === undefined) {
          noticeIds.current.set(host.id, toast.show(`Updating SPAWN D on ${host.name}`, body));
        } else {
          toast.update(existing, body);
        }
        continue;
      }

      if (DISMISSED.has(host.id) || existing !== undefined) continue;

      const id = toast.show(`${host.name} has a SPAWN D update`, {
        detail: `It is running ${host.version ?? "an older build"}. Sessions keep running through an update.`,
        persistent: true,
        actions: [
          {
            label: "Dismiss",
            onPress: () => {
              DISMISSED.add(host.id);
              const live = noticeIds.current.get(host.id);
              if (live !== undefined) {
                toast.dismiss(live);
                noticeIds.current.delete(host.id);
              }
            },
          },
          {
            label: "Update now",
            variant: "primary" as const,
            onPress: () => updateM.mutate(host.id),
          },
        ],
      });
      noticeIds.current.set(host.id, id);
    }

    // A machine no longer in the list should not leave a notice about itself.
    for (const [hostId, noticeId] of noticeIds.current) {
      if (seen.has(hostId)) continue;
      toast.dismiss(noticeId);
      noticeIds.current.delete(hostId);
    }
  }, [hostsQ.data, toast, updateM]);

  return null;
}
