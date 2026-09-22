import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type AgentRestartResult, restartSessionAgent } from "@/components/launcher/agent-restart";
import { pendingLaunches } from "@/components/launcher/pending-launch";
import { listAgents } from "@/data/api/endpoints/agents";
import { getHost } from "@/data/api/endpoints/hosts";
import { getSession, patchSession, restartSession } from "@/data/api/endpoints/sessions";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { cachedListItem } from "@/data/cached-list-item";
import { killSession, removeSessionPanes } from "@/data/queries/session-teardown";
import { qk } from "@/data/queryKeys";
import type { AgentDef } from "@/data/types/domain";

/** Definitions change when someone edits them in Settings, not per keystroke. */
const AGENTS_STALE_MS = 60_000;

export interface TerminalData {
  session: SessionOut | undefined;
  host: HostOut | undefined;
  /** Every agent definition, for naming what a restart of this window brings
   *  back. Empty until loaded; the screen never waits on it. */
  agents: readonly AgentDef[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useTerminalData(sessionId: string): TerminalData {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: qk.session(sessionId),
    queryFn: () => getSession(sessionId),
    enabled: sessionId.length > 0,
    ...cachedListItem<SessionOut>(queryClient, qk.sessions(), sessionId),
  });
  const hostId = sessionQuery.data?.host_id ?? "";
  const hostQuery = useQuery({
    queryKey: qk.host(hostId),
    queryFn: () => getHost(hostId),
    enabled: hostId.length > 0,
    ...cachedListItem<HostOut>(queryClient, qk.hosts(), hostId),
  });

  const agentsQuery = useQuery({
    queryKey: qk.agents(),
    queryFn: listAgents,
    staleTime: AGENTS_STALE_MS,
  });

  return {
    session: sessionQuery.data,
    host: hostQuery.data,
    agents: agentsQuery.data ?? [],
    isLoading: sessionQuery.isLoading || (hostId.length > 0 && hostQuery.isLoading),
    error:
      sessionQuery.error instanceof Error
        ? sessionQuery.error
        : hostQuery.error instanceof Error
          ? hostQuery.error
          : null,
    refetch: async () => {
      const sessionResult = await sessionQuery.refetch();
      if (sessionResult.data?.host_id) await hostQuery.refetch();
    },
  };
}

export function useRenameTerminalSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => patchSession(sessionId, { name }),
    onSuccess: (session) => {
      queryClient.setQueryData(qk.session(sessionId), session);
      void queryClient.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

/**
 * Restart the window as what it was opened as: the session is restarted and,
 * for an agent window, the agent's resume command is queued for the terminal
 * to type the moment the fresh shell connects (`agent-restart.ts`).
 */
export function useRestartTerminalSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<AgentRestartResult, Error, void>({
    mutationFn: async () => {
      const session = await getSession(sessionId);
      const agents = await queryClient
        .ensureQueryData({ queryKey: qk.agents(), queryFn: listAgents })
        .catch(() => []);
      return restartSessionAgent({
        session,
        agents,
        restart: async (id) => {
          const saved = await restartSession(id);
          queryClient.setQueryData(qk.session(id), saved);
          return saved;
        },
        pending: pendingLaunches,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

export interface KillTerminalSessionResult {
  /** True when the server had already dropped the session before we asked. */
  alreadyGone: boolean;
  /** Set when the session died but its pane could not be taken out of a layout. */
  paneError: Error | null;
}

export function useKillTerminalSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<KillTerminalSessionResult, Error, void>({
    // Everything happens in the mutation rather than in onSuccess: the terminal
    // closes as soon as the kill is confirmed, and an observer whose component
    // has gone never runs its callbacks — while the session list and the
    // layouts pointing at this pane have to be corrected either way.
    mutationFn: async () => {
      const { alreadyGone } = await killSession(sessionId);
      queryClient.removeQueries({ queryKey: qk.session(sessionId), exact: true });
      void queryClient.invalidateQueries({ queryKey: qk.sessions() });
      try {
        await removeSessionPanes(queryClient, sessionId);
        return { alreadyGone, paneError: null };
      } catch (error) {
        // Reported rather than thrown: the process is dead whatever the
        // workspace write did, and calling that a failed kill would be a lie.
        return {
          alreadyGone,
          paneError: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  });
}
