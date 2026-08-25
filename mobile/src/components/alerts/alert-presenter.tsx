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
import { useToast } from "@/components/ui/toast";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import { getAlertQueryContext, refreshAlertSession } from "@/data/queries/alerts";
import { useRegisteredPhone } from "@/data/queries/pairing";
import { useMeSettingsQuery } from "@/data/queries/settings";
import { qk } from "@/data/queryKeys";
import type { AlertEvent } from "@/data/realtime/alert-socket";
import { identifyAgent } from "@/data/selectors/agent";
import { alertEventKey, useAlertStore } from "@/data/stores/alerts";
import { useAuthenticatedAccount } from "@/lib/auth-gate";
import { haptics } from "@/lib/haptics";
import {
  configureLocalNotifications,
  consumeLastApprovalNotificationResponse,
  consumeLastLocalNotificationResponse,
  getNotificationPreferences,
  hydrateNotificationPreferences,
  type NotificationNavigationTarget,
  scheduleLocalAlertNotification,
  subscribeToLocalNotificationResponses,
} from "@/lib/notifications";
import { registerForPushNotifications } from "@/lib/push";

export interface AlertPresenterProps {
  currentSessionId?: string | null;
  onOpenSession?: (sessionId: string) => void;
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
  // The push token is registered against this install's trust identity so
  // the server never pushes this device's own knock back to it. Nothing here
  // runs while signed out: the permission prompt belongs after sign-in, not
  // on the login screen.
  const { accountId } = useAuthenticatedAccount();
  const me = useMeSettingsQuery();
  const phone = useRegisteredPhone(accountId === null ? undefined : me.data?.user.id);
  const browserDeviceId = phone.data?.id ?? null;

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

  // A tapped knock opens the app; the approval prompt is mounted in the
  // signed-in shell and shows the moment the pending list is fresh.
  const surfaceApproval = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.deviceApprovals() });
  }, [queryClient]);

  useEffect(() => {
    configureLocalNotifications();
    void hydrateNotificationPreferences();
    // Re-registered on every signed-in mount on purpose: push tokens are
    // reissued on reinstall, on restore to a new handset and sometimes on an
    // OS upgrade, and a stale registration fails silently — the alerts simply
    // stop. Runs again once the trust identity is known, so the token carries
    // it. Signed out, it neither asks for permission nor registers.
    if (accountId !== null) void registerForPushNotifications({ browserDeviceId });
    const lastResponse = consumeLastLocalNotificationResponse();
    if (lastResponse) void handleNotificationTarget(lastResponse);
    else if (consumeLastApprovalNotificationResponse()) surfaceApproval();
    return subscribeToLocalNotificationResponses(
      (target) => {
        void handleNotificationTarget(target);
      },
      () => surfaceApproval(),
    );
  }, [handleNotificationTarget, surfaceApproval, browserDeviceId, accountId]);

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
      const identity = identifyAgent(
        alert.command ?? context.session?.foreground_command ?? null,
        context.agents,
      );
      const title = alertTitle(alert, context.agents);
      const body = alertBody(alert, {
        ...(context.session ? { session: context.session } : {}),
        agents: context.agents,
        ...(context.placement ? { workspaceName: context.placement.workspace.name } : {}),
      });

      if (plan.toast) {
        toast.show(title, {
          detail: body,
          icon: <AgentIcon identity={identity} />,
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
