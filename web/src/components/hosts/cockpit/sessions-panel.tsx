"use client";

import { useQuery } from "@tanstack/react-query";
import { SquareTerminal } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { sessions, workspaces } from "@/lib/api";
import { groupHostSessions, hostSessionGroupTitle } from "@/lib/host-cockpit";
import { sessionHref } from "@/lib/sessions";
import { CockpitSection } from "./cockpit-section";
import { useHostCockpit } from "./host-cockpit";
import { HostSessionRow } from "./host-session-row";

/** Every window on this host, under the workspace it sits in. */
export function HostSessions() {
  const { hostId, host } = useHostCockpit();
  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    staleTime: 5_000,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    staleTime: 30_000,
  });
  // The sidebar's own key for the archived list: it never mixes into
  // ["workspaces"], which other surfaces read as the workspaces you have.
  const archivedQ = useQuery({
    queryKey: ["workspaces", "archived"],
    queryFn: () => workspaces.list({ archived: true }),
    staleTime: 30_000,
  });
  const here = (sessionsQ.data ?? []).filter((session) => session.host_id === hostId);
  const list = [...(workspacesQ.data ?? []), ...(archivedQ.data ?? [])];
  const groups = groupHostSessions(here, list);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 @md/shell:p-6">
        {sessionsQ.isLoading && <Skeleton className="h-28 w-full rounded-xl" />}
        {sessionsQ.error && (
          <p className="text-sm text-destructive">
            Could not load sessions: {String(sessionsQ.error)}
          </p>
        )}
        {!sessionsQ.isLoading && !sessionsQ.error && groups.length === 0 && (
          <EmptyState
            icon={<SquareTerminal />}
            title={host ? `Nothing runs on ${host.name}.` : "Nothing runs here."}
            body="Windows opened on this host are listed here, under the workspace they are in."
          />
        )}
        {groups.map((group) => (
          <CockpitSection
            key={group.workspace?.id ?? "none"}
            id={`host-sessions-${group.workspace?.id ?? "none"}`}
            title={hostSessionGroupTitle(group)}
            count={group.sessions.length}
          >
            <ul className="divide-y divide-border">
              {group.sessions.map((session) => (
                <HostSessionRow
                  key={session.id}
                  session={session}
                  href={sessionHref(session.id, list)}
                />
              ))}
            </ul>
          </CockpitSection>
        ))}
      </div>
    </div>
  );
}
