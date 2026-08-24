import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { registerPushDevice, unregisterPushDevice } from "@/data/api/endpoints/notifications";

/**
 * Remote delivery for alerts that arrive while spawn is closed.
 *
 * The local notifications in `lib/notifications.ts` can only fire for an alert
 * the app was awake to receive, which excludes the case the feature exists for:
 * an agent finishing while the phone is in a pocket. These tokens are how the
 * server reaches that phone anyway.
 *
 * Android needs the channel to exist before the first notification arrives, or
 * the system files it under a default the user cannot tune.
 */
export const ALERT_CHANNEL_ID = "alerts";

let registeredToken: string | null = null;

export type PushRegistration =
  | { status: "registered"; token: string }
  | { status: "unavailable"; reason: string };

function projectId(): string | null {
  const value =
    Constants.expoConfig?.extra?.["eas"]?.projectId ?? Constants.easConfig?.projectId ?? null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function ensureAlertChannel(
  api: Pick<typeof Notifications, "setNotificationChannelAsync"> = Notifications,
): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await api.setNotificationChannelAsync(ALERT_CHANNEL_ID, {
      name: "Session alerts",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
    });
  } catch {
    // A missing channel downgrades delivery; it does not break the app.
  }
}

/**
 * Register this install for remote alerts, if it can receive them.
 *
 * Called on every launch on purpose: push tokens are reissued on reinstall,
 * on restore to a new device and occasionally on OS upgrade, and an app that
 * registered once would go quiet without any visible symptom.
 */
export async function registerForPushNotifications(
  options: {
    api?: Pick<typeof Notifications, "getPermissionsAsync" | "getExpoPushTokenAsync">;
    register?: typeof registerPushDevice;
    label?: string | null;
  } = {},
): Promise<PushRegistration> {
  const api = options.api ?? Notifications;
  const register = options.register ?? registerPushDevice;

  const id = projectId();
  if (id === null) {
    // Expo Go and any bundle built before `eas init` have no project to
    // address, so there is nothing to register rather than something broken.
    return { status: "unavailable", reason: "This build has no EAS project id." };
  }

  try {
    const permission = await api.getPermissionsAsync();
    if (permission.status !== "granted") {
      return { status: "unavailable", reason: "Notification permission has not been granted." };
    }
  } catch {
    return { status: "unavailable", reason: "Notification permission could not be read." };
  }

  await ensureAlertChannel();

  let token: string;
  try {
    token = (await api.getExpoPushTokenAsync({ projectId: id })).data;
  } catch {
    return { status: "unavailable", reason: "This device could not be issued a push token." };
  }

  try {
    await register({
      token,
      platform: Platform.OS === "android" ? "android" : "ios",
      ...(options.label ? { label: options.label } : {}),
    });
  } catch {
    return { status: "unavailable", reason: "The server did not accept this device." };
  }

  registeredToken = token;
  return { status: "registered", token };
}

/**
 * Drop this install's registration.
 *
 * Called on sign-out, because the next person to sign in on this handset must
 * not keep receiving the previous account's alerts. Failure is swallowed: a
 * sign-out that cannot complete because a courtesy call failed is worse than
 * a stale token the server retires on its next dead-token response.
 */
export async function unregisterForPushNotifications(
  unregister: typeof unregisterPushDevice = unregisterPushDevice,
): Promise<void> {
  const token = registeredToken;
  registeredToken = null;
  if (token === null) return;
  try {
    await unregister(token);
  } catch {
    // See above.
  }
}

/** Test seam: forget any token this process believes it registered. */
export function resetPushRegistration(): void {
  registeredToken = null;
}
