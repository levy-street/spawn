import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { listAgents } from "@/data/api/endpoints/agents";
import { listHosts } from "@/data/api/endpoints/hosts";
import { listSessions } from "@/data/api/endpoints/sessions";
import { getWorkspace, patchWorkspace } from "@/data/api/endpoints/workspaces";
import type { WorkspaceOut, WorkspacePatch } from "@/data/api/schemas/workspaces";
import { qk } from "@/data/queryKeys";
import type { Workspace } from "@/data/types/domain";
import type { WorkspaceLayoutV3 } from "@/data/types/layout";
import { duration } from "@/theme";

export const WORKSPACE_REORDER_DEBOUNCE_MS = duration.progress;

/** Removes the wire-only nullable widget spelling while retaining every envelope field. */
export function normalizeWorkspace(workspace: WorkspaceOut): Workspace {
  return {
    ...workspace,
    layout: {
      ...workspace.layout,
      tabs: workspace.layout.tabs.map((tab) => ({
        ...tab,
        layout: {
          ...tab.layout,
          tiles: tab.layout.tiles.map((tile) => {
            const { widget, ...geometry } = tile;
            return widget ? { ...geometry, widget: { ...widget } } : geometry;
          }),
        },
      })),
    },
  };
}

export function useWorkspaceDetail(workspaceId: string) {
  const enabled = workspaceId.length > 0;
  const workspace = useQuery({
    queryKey: qk.workspace(workspaceId),
    queryFn: async () => normalizeWorkspace(await getWorkspace(workspaceId)),
    enabled,
  });
  const sessions = useQuery({
    queryKey: qk.sessions(),
    queryFn: () => listSessions(),
    enabled,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const hosts = useQuery({ queryKey: qk.hosts(), queryFn: listHosts, enabled });
  const agents = useQuery({ queryKey: qk.agents(), queryFn: listAgents, enabled });

  // Only a pull drives the refresh chrome. The five-second session poll sets
  // `isFetching` constantly, and binding that to the control makes the list
  // twitch downwards on its own every tick.
  const [refreshing, setRefreshing] = useState(false);
  const refetchWorkspace = workspace.refetch;
  const refetchSessions = sessions.refetch;
  const refetchHosts = hosts.refetch;
  const refetchAgents = agents.refetch;
  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      await Promise.all([refetchWorkspace(), refetchSessions(), refetchHosts(), refetchAgents()]);
    } finally {
      setRefreshing(false);
    }
  }, [refetchAgents, refetchHosts, refetchSessions, refetchWorkspace]);

  return {
    workspace,
    sessions,
    hosts,
    agents,
    loading: workspace.isPending || sessions.isPending || hosts.isPending || agents.isPending,
    refreshing,
    refresh,
    error: workspace.error ?? sessions.error ?? hosts.error ?? agents.error,
  };
}

async function invalidateWorkspaceKeys(client: QueryClient, workspaceId: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: qk.workspace(workspaceId) }),
    client.invalidateQueries({ queryKey: qk.workspaces() }),
  ]);
}

export async function commitWorkspaceLayout(
  client: QueryClient,
  workspace: Workspace,
  layout: WorkspaceLayoutV3,
): Promise<Workspace> {
  const key = qk.workspace(workspace.id);
  const rollback = client.getQueryData<Workspace>(key) ?? workspace;
  client.setQueryData<Workspace>(key, { ...workspace, layout });

  try {
    const saved = normalizeWorkspace(
      await patchWorkspace(workspace.id, { layout: layoutForWire(layout) }),
    );
    client.setQueryData(key, saved);
    return saved;
  } catch (error) {
    client.setQueryData(key, rollback);
    throw error;
  } finally {
    await invalidateWorkspaceKeys(client, workspace.id);
  }
}

function layoutForWire(layout: WorkspaceLayoutV3): NonNullable<WorkspacePatch["layout"]> {
  // The domain keeps unknown future widget fields; today's server schema accepts files widgets.
  return layout as unknown as NonNullable<WorkspacePatch["layout"]>;
}

export interface WorkspaceReorderDebouncerOptions {
  patch: (workspaceId: string, layout: WorkspaceLayoutV3) => Promise<Workspace>;
  onOptimistic: (workspace: Workspace) => void;
  onSaved: (workspace: Workspace) => void;
  onRollback: (workspace: Workspace) => void;
  onError?: (error: unknown) => void;
  delayMs?: number;
}

export interface WorkspaceReorderDebouncer {
  schedule(workspace: Workspace, layout: WorkspaceLayoutV3): void;
  flush(): Promise<Workspace | null>;
  cancel(): void;
}

/** Coalesces drag/list reorder ticks while keeping the last server value for rollback. */
export function createWorkspaceReorderDebouncer(
  options: WorkspaceReorderDebouncerOptions,
): WorkspaceReorderDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rollback: Workspace | null = null;
  let pending: { workspace: Workspace; layout: WorkspaceLayoutV3 } | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flush = async (): Promise<Workspace | null> => {
    clearTimer();
    const next = pending;
    const fallback = rollback;
    pending = null;
    rollback = null;
    if (!next) return null;

    try {
      const saved = await options.patch(next.workspace.id, next.layout);
      options.onSaved(saved);
      return saved;
    } catch (error) {
      if (fallback) options.onRollback(fallback);
      options.onError?.(error);
      throw error;
    }
  };

  return {
    schedule(workspace, layout) {
      if (!rollback) rollback = workspace;
      pending = { workspace, layout };
      options.onOptimistic({ ...workspace, layout });
      clearTimer();
      timer = setTimeout(() => {
        void flush().catch(() => undefined);
      }, options.delayMs ?? WORKSPACE_REORDER_DEBOUNCE_MS);
    },
    flush,
    cancel() {
      clearTimer();
      pending = null;
      rollback = null;
    },
  };
}

export function useWorkspaceLayoutCommit() {
  const client = useQueryClient();
  return useCallback(
    (workspace: Workspace, layout: WorkspaceLayoutV3) =>
      commitWorkspaceLayout(client, workspace, layout),
    [client],
  );
}

export function useWorkspaceReorder(onError: (error: unknown) => void) {
  const client = useQueryClient();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const debouncerRef = useRef<WorkspaceReorderDebouncer | null>(null);

  if (debouncerRef.current === null) {
    debouncerRef.current = createWorkspaceReorderDebouncer({
      patch: async (workspaceId, layout) =>
        normalizeWorkspace(await patchWorkspace(workspaceId, { layout: layoutForWire(layout) })),
      onOptimistic: (workspace) => {
        client.setQueryData(qk.workspace(workspace.id), workspace);
      },
      onSaved: (workspace) => {
        client.setQueryData(qk.workspace(workspace.id), workspace);
        void invalidateWorkspaceKeys(client, workspace.id);
      },
      onRollback: (workspace) => {
        client.setQueryData(qk.workspace(workspace.id), workspace);
        void invalidateWorkspaceKeys(client, workspace.id);
      },
      onError: (error) => onErrorRef.current(error),
    });
  }

  useEffect(
    () => () => {
      void debouncerRef.current?.flush().catch(() => undefined);
    },
    [],
  );

  return debouncerRef.current;
}
