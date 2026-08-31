"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "@/components/ui/toast";
import { hosts } from "@/lib/api";

/**
 * The standing notice that a machine has an update, and the one that says it
 * is being taken.
 *
 * This used to be a badge in a list and a dialog you had to go and find. A
 * badge is a fact nobody is asked to act on, and it sat next to a machine name
 * on one screen while the person was on another. So the notice is now the
 * ordinary notification, in the ordinary place, and it *stays*: an update
 * waiting to be taken is a condition, not an event, and a notice that expires
 * after five seconds has told nobody anything they could act on.
 *
 * Dismissing is per machine and lasts the session. It means "not now", and the
 * badge on the machine itself is still there for whoever wants it back — this
 * notice does not replace that, it just stops the machine's state being
 * something you only learn by visiting the right page.
 */

const POLL_INTERVAL_MS = 4_000;
const DISMISSED_KEY = "spawn.hostUpdate.dismissed";

function dismissedHosts(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(DISMISSED_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    // Storage denial must not turn Dismiss into a no-op that re-nags on every
    // poll; the in-memory set below still holds for this page's lifetime.
    return new Set<string>();
  }
}

function rememberDismissed(hostId: string): void {
  try {
    const next = dismissedHosts();
    next.add(hostId);
    window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
  } catch {
    // See above.
  }
}

function forgetDismissed(hostId: string): void {
  try {
    const next = dismissedHosts();
    next.delete(hostId);
    window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
  } catch {
    // See above.
  }
}

export function HostUpdateNotifier() {
  const queryClient = useQueryClient();
  /** The live notice per machine, so state changes move one row rather than
   *  stacking a new one beside it. */
  const noticeIds = useRef(new Map<string, number>());
  /** Dismissals also live here: session storage can be denied, and a machine
   *  polled every four seconds must not re-raise a notice already waved away. */
  const dismissed = useRef<Set<string>>(new Set());
  const started = useRef(false);

  if (!started.current) {
    started.current = true;
    if (typeof window !== "undefined") dismissed.current = dismissedHosts();
  }

  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    refetchInterval: POLL_INTERVAL_MS,
    // Advisory. A failed poll must never surface as an error here: the person
    // did not ask for this query, and the app works without it.
    retry: false,
  });

  const updateM = useMutation({
    mutationFn: (hostId: string) => hosts.update(hostId),
    onSuccess: (_result, hostId) => {
      void queryClient.invalidateQueries({ queryKey: ["hosts"] });
      void queryClient.invalidateQueries({ queryKey: ["host", hostId] });
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
      const state = host.update.state;
      const existing = noticeIds.current.get(host.id);

      // An offline machine updates itself when it next connects; saying so
      // every four seconds helps nobody, and there is no button to offer.
      const wanted = (state === "available" && host.status === "online") || state === "updating";

      if (!wanted) {
        if (existing !== undefined) {
          toast.dismiss(existing);
          noticeIds.current.delete(host.id);
        }
        // Reaching `current` clears the dismissal: the *next* update is a new
        // question, and "not now" was an answer to the old one.
        if (state === "current") {
          dismissed.current.delete(host.id);
          forgetDismissed(host.id);
        }
        continue;
      }

      if (state === "updating") {
        const body = {
          message: `Updating SPAWN D on ${host.name}`,
          detail: "The daemon restarts itself. Sessions keep running.",
          progress: "indeterminate" as const,
          // Nothing to decide while it works, so no buttons — but the notice
          // is still dismissible by its X, which is what Dismiss means here.
          actions: undefined,
          persistent: true,
        };
        if (existing === undefined) {
          noticeIds.current.set(host.id, toast(body.message, body));
        } else {
          toast.update(existing, body);
        }
        continue;
      }

      if (dismissed.current.has(host.id)) continue;

      if (existing === undefined) {
        const id = toast(`${host.name} has a SPAWN D update`, {
          detail: `It is running ${host.version ?? "an older build"}. Sessions keep running through an update.`,
          persistent: true,
          actions: [
            {
              label: "Dismiss",
              onClick: () => {
                dismissed.current.add(host.id);
                rememberDismissed(host.id);
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
              onClick: () => updateM.mutate(host.id),
            },
          ],
        });
        noticeIds.current.set(host.id, id);
      }
    }

    // A machine that has gone out of the list entirely — removed, or no longer
    // visible to this account — should not leave a notice behind about itself.
    for (const [hostId, noticeId] of noticeIds.current) {
      if (seen.has(hostId)) continue;
      toast.dismiss(noticeId);
      noticeIds.current.delete(hostId);
    }
  }, [hostsQ.data, updateM]);

  // Notices live in the toast host; this component only decides which exist.
  return null;
}
