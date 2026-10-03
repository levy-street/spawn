"use client";

import { ChevronDown } from "lucide-react";
import { type JSX, useRef } from "react";
import { useHostLiveStatus } from "@/components/hosts/use-host-live-status";
import { CascadeMenu } from "@/components/ui/cascade-menu";
import { StatusDot } from "@/components/ui/status";
import type { Host, Session } from "@/lib/api";
import { basename } from "@/lib/paths";
import { displayPath } from "@/lib/places";
import { cn } from "@/lib/utils";
import { useWherePanel } from "./where-picker";

/**
 * Where a pane runs, as one control: the host's live dot, its name and the
 * folder, and a menu of other places to send it — likeliest first. Picking
 * a folder on the same machine changes directory in the running shell;
 * picking another machine moves the window there (the caller confirms).
 *
 * The dot is this device's connection to the host, not only the server's
 * word, so a pane on a host that is reconnecting says so where you are
 * looking instead of in a banner over everything.
 */
export function WhereChip({
  session,
  host,
  workspaceId,
  onPick,
}: {
  session: Session;
  host: Host | null;
  workspaceId?: string;
  onPick: (host: Host, cwd: string) => void;
}): JSX.Element {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const live = useHostLiveStatus(host);
  const where = useWherePanel({
    workspaceId,
    exclude: { hostId: session.host_id, cwd: session.cwd },
    anchorRef,
  });
  const path = displayPath(session.cwd);
  const hostName = host?.name ?? session.host_name ?? "host";
  const status = live?.label ?? `${hostName} is unknown`;

  return (
    <span ref={anchorRef} className="inline-flex min-w-0 shrink">
      <CascadeMenu
        root={where.panel(`where-${session.id}`, onPick)}
        align="end"
        sheetTitle="Where this runs"
        renderTrigger={(props) => (
          <button
            {...props}
            type="button"
            aria-label={`Runs in ${path} on ${hostName}. Change where it runs`}
            title={`${status} · ${session.cwd}`}
            className={cn(
              "flex h-7 min-w-0 max-w-72 items-center gap-1.5 rounded-md px-1.5 text-xs",
              "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              live?.reconnecting && "text-warning",
            )}
          >
            <StatusDot tone={live?.tone ?? "offline"} label={status} pulse={live?.reconnecting} />
            <span className="shrink-0 font-medium @max-[320px]/pane-header:hidden">{hostName}</span>
            <span aria-hidden className="text-border @max-[320px]/pane-header:hidden">
              ·
            </span>
            <span className="min-w-0 truncate @max-[320px]/pane-header:hidden">{path}</span>
            <span className="min-w-0 truncate @min-[321px]/pane-header:hidden">
              {basename(session.cwd) || path}
            </span>
            <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
          </button>
        )}
      />
      {where.overlays}
    </span>
  );
}
