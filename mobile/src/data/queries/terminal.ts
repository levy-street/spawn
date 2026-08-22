import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getHost } from "@/data/api/endpoints/hosts";
import {
  deleteSession,
  getSession,
  patchSession,
  restartSession,
} from "@/data/api/endpoints/sessions";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { qk } from "@/data/queryKeys";

export interface TerminalData {
  session: SessionOut | undefined;
  host: HostOut | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useTerminalData(sessionId: string): TerminalData {
  const sessionQuery = useQuery({
    queryKey: qk.session(sessionId),
    queryFn: () => getSession(sessionId),
    enabled: sessionId.length > 0,
  });
  const hostId = sessionQuery.data?.host_id ?? "";
  const hostQuery = useQuery({
    queryKey: qk.host(hostId),
    queryFn: () => getHost(hostId),
    enabled: hostId.length > 0,
  });

  return {
    session: sessionQuery.data,
    host: hostQuery.data,
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

export function useRestartTerminalSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => restartSession(sessionId),
    onSuccess: (session) => {
      queryClient.setQueryData(qk.session(sessionId), session);
      void queryClient.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

export function useKillTerminalSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteSession(sessionId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: qk.session(sessionId), exact: true });
      void queryClient.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}
