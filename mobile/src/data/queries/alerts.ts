import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { getSession } from "@/data/api/endpoints/sessions";
import { qk } from "@/data/queryKeys";
import type { AlertEvent } from "@/data/realtime/alert-socket";
import { attentionRank, sessionAttention } from "@/data/selectors/session";
import { tabStats, workspaceStats } from "@/data/selectors/workspace";
import { useConnectionStore } from "@/data/stores/connection";
import type { AgentDef, Session, Workspace } from "@/data/types/domain";
import type { WorkspaceTab } from "@/data/types/layout";
import {
  getNotificationPreferences,
  hydrateNotificationPreferences,
  type NotificationPreferenceKey,
  type NotificationPreferences,
  setNotificationPreference,
  setSessionNotificationsMuted,
  setSystemNotificationsEnabled,
  subscribeNotificationPreferences,
} from "@/lib/notifications";

export interface AttentionSummary {
  total: number;
  waiting: number;
  dead: number;
  highest: "waiting" | "dead";
}

export function attentionSummaryFromCounts(waiting: number, dead: number): AttentionSummary | null {
  const normalizedWaiting = Math.max(0, Math.trunc(waiting));
  const normalizedDead = Math.max(0, Math.trunc(dead));
  const total = normalizedWaiting + normalizedDead;
  if (total === 0) return null;
  return {
    total,
    waiting: normalizedWaiting,
    dead: normalizedDead,
    highest: normalizedDead > 0 ? "dead" : "waiting",
  };
}

export function sessionAttentionSummary(session: Session): AttentionSummary | null {
  const attention = sessionAttention(session);
  const rank = attentionRank(session);
  if (attention === null || rank === 0) return null;
  return attentionSummaryFromCounts(attention === "waiting" ? 1 : 0, attention === "dead" ? 1 : 0);
}

export function tabAttentionSummary(
  tab: WorkspaceTab,
  sessionsById: ReadonlyMap<string, Session>,
): AttentionSummary | null {
  const stats = tabStats(tab, sessionsById);
  return attentionSummaryFromCounts(stats.waiting, stats.dead);
}

export function workspaceAttentionSummary(
  workspace: Workspace,
  sessionsById: ReadonlyMap<string, Session>,
): AttentionSummary | null {
  const stats = workspaceStats(workspace, sessionsById);
  return attentionSummaryFromCounts(stats.waiting, stats.dead);
}

export interface AlertPlacement {
  workspace: Workspace;
  tabId: string;
}

export function findAlertPlacement(
  workspaces: readonly Workspace[],
  sessionId: string,
): AlertPlacement | null {
  for (const workspace of workspaces) {
    const tab = workspace.layout.tabs.find((candidate) =>
      candidate.layout.tiles.some((tile) => !tile.widget && tile.session_id === sessionId),
    );
    if (tab) return { workspace, tabId: tab.id };
  }
  return null;
}

export interface AlertQueryContext {
  session: Session | undefined;
  agents: readonly AgentDef[];
  placement: AlertPlacement | null;
}

export function getAlertQueryContext(
  queryClient: Pick<QueryClient, "getQueryData">,
  alert: AlertEvent,
): AlertQueryContext {
  const sessions = queryClient.getQueryData<Session[]>(qk.sessions()) ?? [];
  const workspaces = queryClient.getQueryData<Workspace[]>(qk.workspaces()) ?? [];
  return {
    session: sessions.find((session) => session.id === alert.session_id),
    agents: queryClient.getQueryData<AgentDef[]>(qk.agents()) ?? [],
    placement: findAlertPlacement(workspaces, alert.session_id),
  };
}

export async function refreshAlertSession(
  queryClient: Pick<QueryClient, "fetchQuery">,
  sessionId: string,
): Promise<Session> {
  return queryClient.fetchQuery({
    queryKey: qk.session(sessionId),
    queryFn: () => getSession(sessionId),
  });
}

export interface NotificationPreferencesQuery {
  prefs: NotificationPreferences;
  setPreference: <K extends NotificationPreferenceKey>(
    key: K,
    value: NotificationPreferences[K],
  ) => Promise<NotificationPreferences>;
  setSystemEnabled: (enabled: boolean) => ReturnType<typeof setSystemNotificationsEnabled>;
  setSessionMuted: (sessionId: string, muted: boolean) => Promise<NotificationPreferences>;
}

export function useNotificationPreferences(): NotificationPreferencesQuery {
  const prefs = useSyncExternalStore(
    subscribeNotificationPreferences,
    getNotificationPreferences,
    getNotificationPreferences,
  );

  useEffect(() => {
    void hydrateNotificationPreferences();
  }, []);

  const setPreference = useCallback(
    <K extends NotificationPreferenceKey>(key: K, value: NotificationPreferences[K]) =>
      setNotificationPreference(key, value),
    [],
  );
  const setSystemEnabled = useCallback(
    (enabled: boolean) => setSystemNotificationsEnabled(enabled),
    [],
  );
  const setSessionMuted = useCallback(
    (sessionId: string, muted: boolean) => setSessionNotificationsMuted(sessionId, muted),
    [],
  );

  return useMemo(
    () => ({ prefs, setPreference, setSystemEnabled, setSessionMuted }),
    [prefs, setPreference, setSessionMuted, setSystemEnabled],
  );
}

export function useSessionNotificationsMuted(sessionId: string | null | undefined): boolean {
  const prefs = useSyncExternalStore(
    subscribeNotificationPreferences,
    getNotificationPreferences,
    getNotificationPreferences,
  );
  useEffect(() => {
    void hydrateNotificationPreferences();
  }, []);
  return sessionId ? prefs.mutedSessions.includes(sessionId) : false;
}

export function useAlertStreamConnected(): boolean {
  return useConnectionStore((state) => state.alertSocket === "open");
}
