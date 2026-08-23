import AsyncStorage from "@react-native-async-storage/async-storage";

export const NOTIFICATION_PREFERENCES_KEY = "spawn.notify.prefs";
export const MAX_MUTED_SESSIONS = 200;

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

export type NotificationBooleanKey = Exclude<keyof NotificationPreferences, "mutedSessions">;

export interface NotificationPreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = Object.freeze({
  toast: true,
  sound: false,
  system: false,
  haptics: false,
  onFinished: true,
  onAwaiting: true,
  onDied: true,
  mutedSessions: [],
});

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseMutedSessions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const sessions = value.filter(
    (sessionId): sessionId is string => typeof sessionId === "string" && sessionId.length > 0,
  );
  return [...new Set(sessions)].slice(-MAX_MUTED_SESSIONS);
}

export function parseNotificationPreferences(encoded: string | null): NotificationPreferences {
  if (encoded === null) return { ...DEFAULT_NOTIFICATION_PREFERENCES, mutedSessions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES, mutedSessions: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES, mutedSessions: [] };
  }
  const value = parsed as Record<string, unknown>;
  return {
    toast: booleanOrDefault(value["toast"], DEFAULT_NOTIFICATION_PREFERENCES.toast),
    sound: booleanOrDefault(value["sound"], DEFAULT_NOTIFICATION_PREFERENCES.sound),
    system: booleanOrDefault(value["system"], DEFAULT_NOTIFICATION_PREFERENCES.system),
    haptics: booleanOrDefault(value["haptics"], DEFAULT_NOTIFICATION_PREFERENCES.haptics),
    onFinished: booleanOrDefault(value["onFinished"], DEFAULT_NOTIFICATION_PREFERENCES.onFinished),
    onAwaiting: booleanOrDefault(value["onAwaiting"], DEFAULT_NOTIFICATION_PREFERENCES.onAwaiting),
    onDied: booleanOrDefault(value["onDied"], DEFAULT_NOTIFICATION_PREFERENCES.onDied),
    mutedSessions: parseMutedSessions(value["mutedSessions"]),
  };
}

export async function loadNotificationPreferences(
  storage: NotificationPreferenceStorage = AsyncStorage,
): Promise<NotificationPreferences> {
  try {
    return parseNotificationPreferences(await storage.getItem(NOTIFICATION_PREFERENCES_KEY));
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES, mutedSessions: [] };
  }
}

export async function saveNotificationPreferences(
  preferences: NotificationPreferences,
  storage: NotificationPreferenceStorage = AsyncStorage,
): Promise<void> {
  const normalized: NotificationPreferences = {
    ...preferences,
    mutedSessions: parseMutedSessions(preferences.mutedSessions),
  };
  await storage.setItem(NOTIFICATION_PREFERENCES_KEY, JSON.stringify(normalized));
}

export async function clearNotificationPreferences(
  storage: NotificationPreferenceStorage = AsyncStorage,
): Promise<void> {
  await storage.removeItem(NOTIFICATION_PREFERENCES_KEY);
}
