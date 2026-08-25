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
import type { HostOut } from "@/data/api/schemas/hosts";
import { getAlertQueryContext, refreshAlertSession } from "@/data/queries/alerts";
import { useRegisteredPhone } from "@/data/queries/pairing";
import { useMeSettingsQuery } from "@/data/queries/settings";
import { qk } from "@/data/queryKeys";
import type { AlertEvent, HostPinUndeliveredTrustEvent } from "@/data/realtime/alert-socket";
import { subscribePinUndeliveredEvents } from "@/data/realtime/pin-undelivered-events";
import { identifyAgent } from "@/data/selectors/agent";
import { alertEventKey, useAlertStore } from "@/data/stores/alerts";
import { useAuthenticatedAccount } from "@/lib/auth-gate";
import { haptics } from "@/lib/haptics";
import {
  configureLocalNotifications,
  consumeLastApprovalNotificationResponse,
  consumeLastLocalNotificationResponse,
  consumeLastPairingNotificationResponse,
  getNotificationPreferences,
  hydrateNotificationPreferences,
  type NotificationNavigationTarget,
  type NotificationPairingTarget,
  scheduleLocalAlertNotification,
  subscribeToLocalNotificationResponses,
} from "@/lib/notifications";
import { registerForPushNotifications, subscribePushRegistrationRequests } from "@/lib/push";

export interface AlertPresenterProps {
  currentSessionId?: string | null;
  onOpenSession?: (sessionId: string) => void;
}

function fireAlertHaptic(feedback: AlertHaptic): void {
  haptics[feedback]();
}

export function pinUndeliveredToast(
  event: HostPinUndeliveredTrustEvent,
  hostName: string,
): { message: string; detail: string } {
  const detail =
    event.reason === "pin_limit"
      ? "This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again."
      : event.reason === "invalid_chain"
        ? `${hostName} could not verify the approval. Approve the device again from a device ${hostName} already trusts.`
        : `Try approving again; if it keeps failing, run spawnd doctor on ${hostName}.`;
  return { message: `The approval didn't reach ${hostName}.`, detail };
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

  useEffect(
    () =>
      subscribePinUndeliveredEvents((event) => {
        const host =
          queryClient.getQueryData<HostOut>(qk.host(event.host_id)) ??
          queryClient
            .getQueryData<HostOut[]>(qk.hosts())
            ?.find((item) => item.id === event.host_id);
        const presentation = pinUndeliveredToast(event, host?.name ?? "the host");
        toast.error(presentation.message, { detail: presentation.detail });
        void queryClient.invalidateQueries({ queryKey: qk.hostPins(event.host_id) });
      }),
    [queryClient, toast],
  );

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

  const openPairingReview = useCallback(
    (target: NotificationPairingTarget) => {
      router.push({
        pathname: "/onboarding/device",
        params: { approvalRef: target.approvalRef },
      });
    },
    [router],
  );

  useEffect(() => {
    configureLocalNotifications();
    void hydrateNotificationPreferences();
    // Re-registered on every signed-in mount on purpose: push tokens are
    // reissued on reinstall, on restore to a new handset and sometimes on an
    // OS upgrade, and a stale registration fails silently — the alerts simply
    // stop. Runs again once the trust identity is known, so the token carries
    // it. Signed out, it neither asks for permission nor registers.
    // Only while system notifications are wanted: the preference is the one
    // switch for alerts that reach the phone as notifications, push included.
    const registerPush = (ask: boolean) => {
      if (accountId === null) return;
      void hydrateNotificationPreferences().then((prefs) => {
        if (prefs.system) void registerForPushNotifications({ ask, browserDeviceId });
      });
    };
    registerPush(true);
    const lastResponse = consumeLastLocalNotificationResponse();
    if (lastResponse) void handleNotificationTarget(lastResponse);
    else if (consumeLastApprovalNotificationResponse()) surfaceApproval();
    else {
      const pairing = consumeLastPairingNotificationResponse();
      if (pairing) openPairingReview(pairing);
    }
    const unsubscribeResponses = subscribeToLocalNotificationResponses(
      (target) => {
        void handleNotificationTarget(target);
      },
      () => surfaceApproval(),
      (target) => openPairingReview(target),
    );
    // The notifications panel asks for this once permission has been granted
    // from there, so the token goes out at that moment rather than next launch.
    const unsubscribeRequests = subscribePushRegistrationRequests(() => registerPush(true));
    // Coming back from the system Settings, where notifications may just have
    // been turned on: register if allowed now, but never put the prompt up.
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") registerPush(false);
    });
    return () => {
      unsubscribeResponses();
      unsubscribeRequests();
      foreground.remove();
    };
  }, [handleNotificationTarget, openPairingReview, surfaceApproval, browserDeviceId, accountId]);

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
