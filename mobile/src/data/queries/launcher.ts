import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createLaunchOrchestrator,
  type LaunchRequest,
  type TerminalCommandSink,
} from "@/components/launcher/launch-orchestrator";
import { pendingLaunches } from "@/components/launcher/pending-launch";
import { listAgents } from "@/data/api/endpoints/agents";
import { listHosts, listRecentDirectories } from "@/data/api/endpoints/hosts";
import { createSession, deleteSession, getSession } from "@/data/api/endpoints/sessions";
import { getWorkspace, patchWorkspace } from "@/data/api/endpoints/workspaces";
import type { RecentDirOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { qk } from "@/data/queryKeys";

export const launcherOrchestrator = createLaunchOrchestrator({
  getWorkspace,
  patchWorkspace: (workspaceId, patch) => patchWorkspace(workspaceId, patch),
  createSession,
  deleteSession,
  pending: pendingLaunches,
});

export function useLauncherData(workspaceId: string, enabled = true) {
  const [hosts, agents, workspace] = useQueries({
    queries: [
      { queryKey: qk.hosts(), queryFn: listHosts, enabled },
      { queryKey: qk.agents(), queryFn: listAgents, enabled },
      {
        queryKey: qk.workspace(workspaceId),
        queryFn: () => getWorkspace(workspaceId),
        enabled: enabled && workspaceId.length > 0,
      },
    ],
  });

  return {
    hosts: hosts.data ?? [],
    agents: agents.data ?? [],
    workspace: workspace.data,
    error: hosts.error ?? agents.error ?? workspace.error,
    isLoading: hosts.isLoading || agents.isLoading || workspace.isLoading,
    refetch: async () => {
      await Promise.all([hosts.refetch(), agents.refetch(), workspace.refetch()]);
    },
  };
}

export interface RecentDirectoriesState {
  data: RecentDirOut[];
  error: Error | null;
  isLoading: boolean;
  refetch(): Promise<void>;
}

export async function loadLauncherRecents(
  hostId: string,
  load: typeof listRecentDirectories = listRecentDirectories,
): Promise<RecentDirOut[]> {
  return (await load(hostId)).dirs;
}

export function useRecentDirectories(
  hostId: string | null,
  enabled: boolean,
): RecentDirectoriesState {
  const [data, setData] = useState<RecentDirOut[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const activeHost = useRef(hostId);
  const activeEnabled = useRef(enabled);
  activeHost.current = hostId;
  activeEnabled.current = enabled;

  const load = useCallback(async () => {
    if (!hostId || !enabled) return;
    setIsLoading(true);
    setError(null);
    try {
      const recentDirectories = await loadLauncherRecents(hostId);
      if (activeHost.current === hostId && activeEnabled.current) setData(recentDirectories);
    } catch (cause) {
      if (activeHost.current === hostId && activeEnabled.current) {
        setError(cause instanceof Error ? cause : new Error("Could not load recent folders."));
      }
    } finally {
      if (activeHost.current === hostId && activeEnabled.current) setIsLoading(false);
    }
  }, [enabled, hostId]);

  useEffect(() => {
    setData([]);
    setError(null);
    setIsLoading(false);
    if (enabled && hostId) void load();
  }, [enabled, hostId, load]);

  return { data, error, isLoading, refetch: load };
}

export function useLaunchSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: LaunchRequest) => launcherOrchestrator.launch(request),
    onSuccess: async (result, request) => {
      queryClient.setQueryData<SessionOut>(qk.session(result.session.id), result.session);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.workspace(request.workspaceId) }),
        queryClient.invalidateQueries({ queryKey: qk.workspaces() }),
        queryClient.invalidateQueries({ queryKey: qk.sessions() }),
      ]);
    },
  });
}

export async function deliverPendingLaunch(sessionId: string, terminal: TerminalCommandSink) {
  return launcherOrchestrator.deliverPending(sessionId, terminal);
}

export async function discardLaunchedSession(sessionId: string): Promise<void> {
  await launcherOrchestrator.discard(sessionId);
}

export async function keepLaunchedShell(sessionId: string): Promise<void> {
  await launcherOrchestrator.keepShell(sessionId);
}

export type { LaunchRequest, TerminalCommandSink, WorkspaceOut };
export { getSession };
