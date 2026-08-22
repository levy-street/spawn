import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { alertBody, alertTitle } from "@/components/alerts/alert-content";
import {
  type AlertHaptic,
  currentTerminalSession,
  planAlertDelivery,
  selectPendingStoredAlerts,
} from "@/components/alerts/alert-delivery";
import { Icon, type IconName } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { getAlertQueryContext, refreshAlertSession } from "@/data/queries/alerts";
import type { AlertEvent } from "@/data/realtime/alert-socket";
import { alertEventKey, useAlertStore } from "@/data/stores/alerts";
import { haptics } from "@/lib/haptics";
import {
  configureLocalNotifications,
  consumeLastLocalNotificationResponse,
  getNotificationPreferences,
  hydrateNotificationPreferences,
  type NotificationNavigationTarget,
  scheduleLocalAlertNotification,
  subscribeToLocalNotificationResponses,
} from "@/lib/notifications";

export interface AlertPresenterProps {
  currentSessionId?: string | null;
  onOpenSession?: (sessionId: string) => void;
}

function alertIcon(event: AlertEvent): React.JSX.Element {
  const values: Record<
    AlertEvent["event"],
    { name: IconName; color: "success" | "warning" | "destructive" }
  > = {
    "agent.finished": { name: "BellRing", color: "success" },
    "agent.awaiting_input": { name: "MessageCircleQuestion", color: "warning" },
    "session.died": { name: "Skull", color: "destructive" },
  };
  const value = values[event.event];
  return <Icon color={value.color} name={value.name} />;
}

function fireAlertHaptic(feedback: AlertHaptic): void {
  haptics[feedback]();
}

export function AlertPresenter({
  currentSessionId: explicitCurrentSessionId,
  onOpenSession,
}: AlertPresenterProps): null {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const alerts = useAlertStore((state) => state.alerts);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState ?? "active");
  const inFlightKeysRef = useRef(new Set<string>());
  const handledResponseKeysRef = useRef(new Set<string>());
  const currentSessionId =
    explicitCurrentSessionId === undefined
      ? currentTerminalSession(pathname)
      : explicitCurrentSessionId;

  const openSession = useCallback(
    (sessionId: string) => {
      if (onOpenSession) {
        onOpenSession(sessionId);
        return;
      }
      router.push(`/terminal/${encodeURIComponent(sessionId)}`);
    },
    [onOpenSession, router],
  );

  const handleNotificationTarget = useCallback(
    async (target: NotificationNavigationTarget) => {
      const responseKey = target.eventKey ?? target.sessionId;
      if (handledResponseKeysRef.current.has(responseKey)) return;
      handledResponseKeysRef.current.add(responseKey);
      try {
        await refreshAlertSession(queryClient, target.sessionId);
      } catch {
        toast.error("Session unavailable", {
          detail: "Opening its latest available state.",
        });
      } finally {
        openSession(target.sessionId);
      }
    },
    [openSession, queryClient, toast],
  );

  useEffect(() => {
    configureLocalNotifications();
    void hydrateNotificationPreferences();
    const lastResponse = consumeLastLocalNotificationResponse();
    if (lastResponse) void handleNotificationTarget(lastResponse);
    return subscribeToLocalNotificationResponses((target) => {
      void handleNotificationTarget(target);
    });
  }, [handleNotificationTarget]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      appStateRef.current = state;
    });
    return () => subscription.remove();
  }, []);

  const deliver = useCallback(
    async (alert: AlertEvent, key: string) => {
      await hydrateNotificationPreferences();
      const prefs = getNotificationPreferences();
      const preview = planAlertDelivery({
        alert,
        prefs,
        appState: appStateRef.current,
        currentSessionId,
        claimed: true,
      });
      if (preview.suppressedBy) return;

      const needsClaim = preview.haptic !== null || preview.localNotification;
      const claimed = !needsClaim || useAlertStore.getState().claim(key);
      const plan = claimed
        ? preview
        : planAlertDelivery({
            alert,
            prefs,
            appState: appStateRef.current,
            currentSessionId,
            claimed: false,
          });
      const context = getAlertQueryContext(queryClient, alert);
      const title = alertTitle(alert, context.agents);
      const body = alertBody(alert, {
        ...(context.session ? { session: context.session } : {}),
        agents: context.agents,
        ...(context.placement ? { workspaceName: context.placement.workspace.name } : {}),
      });

      if (plan.toast) {
        toast.show(title, {
          detail: body,
          icon: alertIcon(alert),
          onPress: () => openSession(alert.session_id),
          actionLabel: `Go to ${title}`,
        });
      }
      if (plan.haptic) fireAlertHaptic(plan.haptic);
      if (plan.localNotification) {
        await scheduleLocalAlertNotification({
          alert,
          eventKey: alertEventKey(alert),
          title,
          body,
          appState: appStateRef.current,
          currentSessionId,
          ...(context.placement
            ? {
                workspaceId: context.placement.workspace.id,
                tabId: context.placement.tabId,
              }
            : {}),
        });
      }
    },
    [currentSessionId, openSession, queryClient, toast],
  );

  useEffect(() => {
    const pending = selectPendingStoredAlerts(alerts, inFlightKeysRef.current);
    for (const item of pending) {
      inFlightKeysRef.current.add(item.key);
      void deliver(item.alert, item.key).finally(() => {
        useAlertStore.getState().remove(item.key);
        inFlightKeysRef.current.delete(item.key);
      });
    }
  }, [alerts, deliver]);

  return null;
}
