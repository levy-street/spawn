import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { AppState, type AppStateStatus } from "react-native";

import type { AlertEvent, AlertEventKind } from "@/data/realtime/alert-socket";

export const NOTIFICATION_PREFERENCES_STORAGE_KEY = "spawn.notify.prefs";
export const LOCAL_NOTIFICATION_RATE_LIMIT_MS = 30_000;
const MAX_MUTED_SESSIONS = 200;

export interface NotificationPreferences {
  toast: boolean;
  sound: boolean;
  system: boolean;
  haptics: boolean;
  onFinished: boolean;
  onAwaiting: boolean;
  onDied: boolean;
  mutedSessions: string[];
}

export type NotificationPreferenceKey = keyof NotificationPreferences;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  toast: true,
  sound: false,
  system: true,
  haptics: false,
  onFinished: true,
  onAwaiting: true,
  onDied: true,
  mutedSessions: [],
};

export const REMOTE_NOTIFICATIONS_UNAVAILABLE_REASON =
  "Remote notifications need an installed build. Expo Go cannot be issued a push token, so alerts arrive only while SPAWN D is running.";

export const notificationCapabilities = {
  local: {
    available: true,
    detail: "Local notifications can show alerts received while SPAWN D is running.",
  },
  remote: {
    available: true,
    detail: "Installed builds register for push, so alerts arrive while SPAWN D is closed.",
  },
  suspendedDelivery: {
    available: true,
    detail: "A suspended or closed app is reached by push instead of the alert socket.",
  },
} as const;

type PreferenceListener = () => void;

const preferenceListeners = new Set<PreferenceListener>();
const lastNotificationAtBySession = new Map<string, number>();
let preferences: NotificationPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES };
let hydrationPromise: Promise<NotificationPreferences> | null = null;
let hydrated = false;
let notificationsConfigured = false;

function clonePreferences(value: NotificationPreferences): NotificationPreferences {
  return { ...value, mutedSessions: [...value.mutedSessions] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  if (!isRecord(value)) return clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES);

  const flag = (
    key: Exclude<NotificationPreferenceKey, "mutedSessions">,
  ): NotificationPreferences[typeof key] => {
    const candidate = value[key];
    return typeof candidate === "boolean" ? candidate : DEFAULT_NOTIFICATION_PREFERENCES[key];
  };
  const muted = Array.isArray(value["mutedSessions"])
    ? value["mutedSessions"].filter((item): item is string => typeof item === "string")
    : [];

  return {
    toast: flag("toast"),
    sound: flag("sound"),
    system: flag("system"),
    haptics: flag("haptics"),
    onFinished: flag("onFinished"),
    onAwaiting: flag("onAwaiting"),
    onDied: flag("onDied"),
    mutedSessions: [...new Set(muted)].slice(-MAX_MUTED_SESSIONS),
  };
}

function emitPreferences(): void {
  for (const listener of preferenceListeners) listener();
}

async function persistPreferences(): Promise<void> {
  try {
    await AsyncStorage.setItem(NOTIFICATION_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences still apply for this process when device storage is unavailable.
  }
}

export function getNotificationPreferences(): NotificationPreferences {
  return preferences;
}

export function subscribeNotificationPreferences(listener: PreferenceListener): () => void {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

export async function hydrateNotificationPreferences(): Promise<NotificationPreferences> {
  if (hydrated) return preferences;
  if (hydrationPromise) return hydrationPromise;

  hydrationPromise = (async () => {
    try {
      const stored = await AsyncStorage.getItem(NOTIFICATION_PREFERENCES_STORAGE_KEY);
      preferences = stored
        ? normalizeNotificationPreferences(JSON.parse(stored) as unknown)
        : clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES);
    } catch {
      preferences = clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES);
    }
    hydrated = true;
    emitPreferences();
    return preferences;
  })();

  try {
    return await hydrationPromise;
  } finally {
    hydrationPromise = null;
  }
}

export async function setNotificationPreference<K extends NotificationPreferenceKey>(
  key: K,
  value: NotificationPreferences[K],
): Promise<NotificationPreferences> {
  await hydrateNotificationPreferences();
  preferences = normalizeNotificationPreferences({ ...preferences, [key]: value });
  emitPreferences();
  await persistPreferences();
  return preferences;
}

export async function setSessionNotificationsMuted(
  sessionId: string,
  muted: boolean,
): Promise<NotificationPreferences> {
  await hydrateNotificationPreferences();
  const next = new Set(preferences.mutedSessions);
  if (muted) next.add(sessionId);
  else next.delete(sessionId);
  preferences = { ...preferences, mutedSessions: [...next].slice(-MAX_MUTED_SESSIONS) };
  emitPreferences();
  await persistPreferences();
  return preferences;
}

export async function clearNotificationPreferences(): Promise<void> {
  preferences = clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES);
  hydrated = true;
  hydrationPromise = null;
  lastNotificationAtBySession.clear();
  emitPreferences();
  try {
    await AsyncStorage.removeItem(NOTIFICATION_PREFERENCES_STORAGE_KEY);
  } catch {
    // Clearing account-local preferences must not block logout.
  }
}

export function notificationEventEnabled(
  value: NotificationPreferences,
  event: AlertEventKind,
): boolean {
  if (event === "agent.finished") return value.onFinished;
  if (event === "agent.awaiting_input") return value.onAwaiting;
  return value.onDied;
}

export type LocalNotificationPermission = "granted" | "denied" | "undetermined";

function normalizePermission(status: string): LocalNotificationPermission {
  if (status === "granted" || status === "denied") return status;
  return "undetermined";
}

export async function getLocalNotificationPermission(): Promise<LocalNotificationPermission> {
  try {
    const result = await Notifications.getPermissionsAsync();
    return normalizePermission(result.status);
  } catch {
    return "undetermined";
  }
}

export async function setSystemNotificationsEnabled(
  enabled: boolean,
): Promise<LocalNotificationPermission> {
  if (!enabled) {
    await setNotificationPreference("system", false);
    return getLocalNotificationPermission();
  }

  let permission = await getLocalNotificationPermission();
  if (permission !== "granted") {
    try {
      permission = normalizePermission((await Notifications.requestPermissionsAsync()).status);
    } catch {
      permission = "undetermined";
    }
  }
  await setNotificationPreference("system", permission === "granted");
  return permission;
}

export function configureLocalNotifications(): void {
  if (notificationsConfigured) return;
  notificationsConfigured = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => {
        // A push can land while spawn is open, and the alert socket has
        // already drawn a toast for the same event. Two notices for one
        // alert reads as a bug, so the banner yields to the toast and the
        // notification is left in the tray for later.
        const foreground = AppState.currentState === "active";
        return {
          shouldShowBanner: !foreground,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      },
    });
  } catch {
    // In-app toasts remain available when the native notification surface is absent.
  }
}

export interface LocalAlertNotificationInput {
  alert: AlertEvent;
  eventKey: string;
  title: string;
  body: string;
  appState: AppStateStatus;
  currentSessionId?: string | null;
  workspaceId?: string;
  tabId?: string;
  now?: number;
}

export type LocalAlertNotificationResult =
  | { scheduled: true; identifier: string }
  | {
      scheduled: false;
      reason:
        | "app_active"
        | "current_session"
        | "event_disabled"
        | "session_muted"
        | "system_disabled"
        | "permission_denied"
        | "rate_limited"
        | "schedule_failed";
    };

export async function scheduleLocalAlertNotification(
  input: LocalAlertNotificationInput,
): Promise<LocalAlertNotificationResult> {
  const prefs = await hydrateNotificationPreferences();
  if (!notificationEventEnabled(prefs, input.alert.event)) {
    return { scheduled: false, reason: "event_disabled" };
  }
  if (prefs.mutedSessions.includes(input.alert.session_id)) {
    return { scheduled: false, reason: "session_muted" };
  }
  if (input.appState === "active" && input.currentSessionId === input.alert.session_id) {
    return { scheduled: false, reason: "current_session" };
  }
  if (input.appState === "active") return { scheduled: false, reason: "app_active" };
  if (!prefs.system) return { scheduled: false, reason: "system_disabled" };
  if ((await getLocalNotificationPermission()) !== "granted") {
    return { scheduled: false, reason: "permission_denied" };
  }

  const now = input.now ?? Date.now();
  const previous = lastNotificationAtBySession.get(input.alert.session_id);
  if (previous !== undefined && now - previous < LOCAL_NOTIFICATION_RATE_LIMIT_MS) {
    return { scheduled: false, reason: "rate_limited" };
  }

  const data: Record<string, string> = {
    sessionId: input.alert.session_id,
    eventKey: input.eventKey,
  };
  if (input.workspaceId) data["workspaceId"] = input.workspaceId;
  if (input.tabId) data["tabId"] = input.tabId;

  try {
    const identifier = await Notifications.scheduleNotificationAsync({
      identifier: `spawn:${input.eventKey}`,
      content: {
        title: input.title,
        body: input.body,
        data,
        sound: prefs.sound ? "default" : false,
      },
      trigger: null,
    });
    lastNotificationAtBySession.set(input.alert.session_id, now);
    return { scheduled: true, identifier };
  } catch {
    return { scheduled: false, reason: "schedule_failed" };
  }
}

export interface NotificationNavigationTarget {
  sessionId: string;
  workspaceId?: string;
  tabId?: string;
  eventKey?: string;
}

/**
 * A knock pushed by the server (`device.approval_requested`): another device
 * of this account is waiting to be approved. Tapping it opens the app, where
 * the approval prompt takes over; nothing about the device travels in the
 * payload beyond the request id, and the fingerprint comparison happens in
 * the prompt, never on the lock screen.
 */
export interface NotificationApprovalTarget {
  requestId: string;
}

export function parseNotificationApprovalTarget(value: unknown): NotificationApprovalTarget | null {
  if (
    !isRecord(value) ||
    value["event"] !== "device.approval_requested" ||
    typeof value["requestId"] !== "string" ||
    !value["requestId"]
  ) {
    return null;
  }
  return { requestId: value["requestId"] };
}

export function parseNotificationNavigationTarget(
  value: unknown,
): NotificationNavigationTarget | null {
  if (!isRecord(value) || typeof value["sessionId"] !== "string" || !value["sessionId"]) {
    return null;
  }
  return {
    sessionId: value["sessionId"],
    ...(typeof value["workspaceId"] === "string" ? { workspaceId: value["workspaceId"] } : {}),
    ...(typeof value["tabId"] === "string" ? { tabId: value["tabId"] } : {}),
    ...(typeof value["eventKey"] === "string" ? { eventKey: value["eventKey"] } : {}),
  };
}

function targetFromResponse(
  response: Notifications.NotificationResponse,
): NotificationNavigationTarget | null {
  return parseNotificationNavigationTarget(response.notification.request.content.data);
}

export function subscribeToLocalNotificationResponses(
  listener: (target: NotificationNavigationTarget) => void,
  onApproval?: (target: NotificationApprovalTarget) => void,
): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const target = targetFromResponse(response);
    if (target) {
      listener(target);
      return;
    }
    const approval = parseNotificationApprovalTarget(response.notification.request.content.data);
    if (approval && onApproval) {
      onApproval(approval);
    }
  });
  return () => subscription.remove();
}

export function consumeLastLocalNotificationResponse(): NotificationNavigationTarget | null {
  const response = Notifications.getLastNotificationResponse();
  if (!response) return null;
  const target = targetFromResponse(response);
  Notifications.clearLastNotificationResponse();
  return target;
}

/** The knock the app was opened from, if it was: consumed once, like the session target. */
export function consumeLastApprovalNotificationResponse(): NotificationApprovalTarget | null {
  const response = Notifications.getLastNotificationResponse();
  if (!response) return null;
  const approval = parseNotificationApprovalTarget(response.notification.request.content.data);
  if (approval) Notifications.clearLastNotificationResponse();
  return approval;
}
