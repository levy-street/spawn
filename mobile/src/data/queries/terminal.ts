import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type AgentRestartPhase,
  type AgentRestartResult,
  restartSessionAgent,
} from "@/components/launcher/agent-restart";
import { pendingLaunches } from "@/components/launcher/pending-launch";
import type { ShellCommandSink } from "@/components/launcher/shell-handoff";
import { listAgents } from "@/data/api/endpoints/agents";
import { getHost } from "@/data/api/endpoints/hosts";
import { getSession, patchSession, restartSession } from "@/data/api/endpoints/sessions";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { cachedListItem } from "@/data/cached-list-item";
import { killSession, removeSessionPanes } from "@/data/queries/session-teardown";
import { qk } from "@/data/queryKeys";
import { commandBasename } from "@/data/selectors/agent";
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
 * Restart from the open terminal: the window comes back as what it was
 * opened as, its agent resumed in the same conversation where the CLI can —
 * typed into the shell it already has when the agent will quit, into a fresh
 * one otherwise (`agent-restart.ts`). Takes the terminal's keyboard so the
 * first road is open to it.
 */
export interface RestartTerminalInput {
  /** The open terminal's keyboard, when the restart is asked for from one. */
  terminal: ShellCommandSink | null;
  /** Each phase as it begins, for the control that started the restart. */
  onPhase?: (phase: AgentRestartPhase) => void;
}

export function useRestartTerminalSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<AgentRestartResult, Error, RestartTerminalInput>({
    mutationFn: async ({ terminal, onPhase }) => {
      const session = await getSession(sessionId);
      const agents = await queryClient
        .ensureQueryData({ queryKey: qk.agents(), queryFn: listAgents })
        .catch(() => []);
      return restartSessionAgent({
        session,
        agents,
        terminal,
        restart: async (id) => {
          const saved = await restartSession(id);
          queryClient.setQueryData(qk.session(id), saved);
          return saved;
        },
        pending: pendingLaunches,
        getSession,
        onSession: (latest) => queryClient.setQueryData(qk.session(latest.id), latest),
        ...(onPhase ? { onPhase } : {}),
      });
    },
    onSuccess: (result) => {
      // Typed into the shell it had: claim the foreground for the relaunched
      // agent now, as a launch does, rather than reading as a shell until the
      // next poll — the handoff's own polling left the shell in the cache.
      if (result.kind === "resumed" && result.plan.kind === "agent") {
        const basename = commandBasename(result.plan.command);
        if (basename) {
          queryClient.setQueryData<SessionOut>(qk.session(sessionId), (current) =>
            current ? { ...current, foreground_command: basename } : current,
          );
        }
      }
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
