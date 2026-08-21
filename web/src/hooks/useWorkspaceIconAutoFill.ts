"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useHostControl } from "@/hooks/useHostControl";
import { hosts, type Workspace, workspaces } from "@/lib/api";
import { findFolderIcon } from "@/lib/workspace-icon-scan";

/**
 * Giving a workspace the mark its folder already has.
 *
 * Runs once per workspace, the first time it is opened with its host online:
 * `icon_source` being null is the record that nobody has looked yet, and the
 * scan settles it either way — to "auto" with an icon, or to "none" when the
 * folder has nothing worth wearing. Both are terminal, so this never runs
 * twice for the same workspace and never argues with a mark its owner chose.
 *
 * Opening is the trigger rather than listing, so exactly one host is scanned
 * at a time and a sidebar full of workspaces does not open a connection each.
 * A scan that never completes — the host went away mid-walk — leaves the pair
 * null, and the next open tries again.
 */
export function useWorkspaceIconAutoFill(workspace: Workspace | undefined): void {
  const queryClient = useQueryClient();
  const attempted = useRef(new Set<string>());

  const wants =
    workspace !== undefined &&
    workspace.icon_source === null &&
    workspace.archived_at === null &&
    workspace.host_id !== null &&
    workspace.cwd !== null;

  const hostId = wants ? (workspace as Workspace).host_id : null;
  const hostQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    staleTime: 30_000,
    enabled: hostId !== null,
  });
  const online =
    hostQ.data?.some((host) => host.id === hostId && host.status === "online") ?? false;

  const { client, state } = useHostControl(hostId, wants && online);

  // Primitives, not the workspace object: a layout write while the walk is in
  // flight must not re-run the effect and abandon it.
  const id = wants ? (workspace as Workspace).id : null;
  const cwd = wants ? (workspace as Workspace).cwd : null;

  useEffect(() => {
    if (!client || state !== "ready" || id === null || cwd === null) return;
    if (attempted.current.has(id)) return;
    // Claimed before the first await, so a re-render cannot start a second walk.
    attempted.current.add(id);

    void (async () => {
      try {
        const icon = await findFolderIcon(client, cwd);
        const next = await workspaces.update(
          id,
          icon ? { icon, icon_source: "auto" } : { icon_source: "none" },
        );
        queryClient.setQueryData(["workspace", id], next);
        queryClient.setQueryData<Workspace[]>(["workspaces"], (current) =>
          current?.map((row) => (row.id === id ? next : row)),
        );
      } catch {
        // A folder that cannot be read, a host that dropped mid-walk, a write
        // that failed: the workspace keeps its initials and the question stays
        // open for the next time it is opened.
        attempted.current.delete(id);
      }
    })();
  }, [client, cwd, id, queryClient, state]);
}
