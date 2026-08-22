import type { AppStateStatus } from "react-native";

import type { AlertEvent, AlertEventKind } from "@/data/realtime/alert-socket";
import type { StoredAlert } from "@/data/stores/alerts";
import { type NotificationPreferences, notificationEventEnabled } from "@/lib/notifications";

export type AlertHaptic = "success" | "warning" | "error";

export interface AlertDeliveryPlan {
  suppressedBy: "event_disabled" | "session_muted" | "current_session" | null;
  toast: boolean;
  haptic: AlertHaptic | null;
  localNotification: boolean;
}

function hapticForEvent(event: AlertEventKind): AlertHaptic {
  if (event === "agent.finished") return "success";
  if (event === "agent.awaiting_input") return "warning";
  return "error";
}

export function planAlertDelivery(input: {
  alert: AlertEvent;
  prefs: NotificationPreferences;
  appState: AppStateStatus;
  currentSessionId: string | null;
  claimed: boolean;
}): AlertDeliveryPlan {
  const empty = (suppressedBy: AlertDeliveryPlan["suppressedBy"]): AlertDeliveryPlan => ({
    suppressedBy,
    toast: false,
    haptic: null,
    localNotification: false,
  });

  if (!notificationEventEnabled(input.prefs, input.alert.event)) {
    return empty("event_disabled");
  }
  if (input.prefs.mutedSessions.includes(input.alert.session_id)) {
    return empty("session_muted");
  }
  if (input.appState === "active" && input.currentSessionId === input.alert.session_id) {
    return empty("current_session");
  }

  const active = input.appState === "active";
  return {
    suppressedBy: null,
    toast: active && input.prefs.toast,
    haptic: input.claimed && input.prefs.haptics ? hapticForEvent(input.alert.event) : null,
    localNotification: !active && input.claimed && input.prefs.system,
  };
}

export function selectPendingStoredAlerts(
  alerts: readonly StoredAlert[],
  inFlightKeys: ReadonlySet<string>,
): StoredAlert[] {
  const selected: StoredAlert[] = [];
  const selectedKeys = new Set<string>();
  for (const item of [...alerts].reverse()) {
    if (inFlightKeys.has(item.key) || selectedKeys.has(item.key)) continue;
    selected.push(item);
    selectedKeys.add(item.key);
  }
  return selected;
}

export function currentTerminalSession(pathname: string): string | null {
  const match = /^\/terminal\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
