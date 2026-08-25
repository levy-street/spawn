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
/** What the last successful registration told the server, to skip repeats. */
let registeredKey: string | null = null;

const registrationRequests = new Set<() => void>();

/**
 * Something outside the signed-in shell — the notifications panel, after the
 * person turned system notifications on — wants this install registered now
 * rather than at the next launch. The shell is the only place that knows the
 * device's trust identity, so it listens and registers on its behalf.
 */
export function subscribePushRegistrationRequests(listener: () => void): () => void {
  registrationRequests.add(listener);
  return () => {
    registrationRequests.delete(listener);
  };
}

export function requestPushRegistration(): void {
  for (const listener of registrationRequests) listener();
}

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
    api?: Pick<
      typeof Notifications,
      "getPermissionsAsync" | "requestPermissionsAsync" | "getExpoPushTokenAsync"
    >;
    register?: typeof registerPushDevice;
    label?: string | null;
    /**
     * Whether to put the system prompt up if permission has never been asked
     * for. A registration retried on foregrounding must not: the prompt is a
     * question, and it belongs to a moment the person chose.
     */
    ask?: boolean;
    /**
     * This install's trust identity. Sent with the token so the server never
     * pushes this device's own knock back to it; null until registration of
     * the identity has landed, after which the caller registers again.
     */
    browserDeviceId?: string | null;
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
    let permission = await api.getPermissionsAsync();
    if (permission.status === "undetermined" && (options.ask ?? true)) {
      // The system prompt shows once per install; iOS remembers the answer
      // and every later call returns it without asking. Nobody else asks, so
      // an install that skipped this never received a single push.
      permission = await api.requestPermissionsAsync();
    }
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

  const browserDeviceId = options.browserDeviceId ?? null;
  const key = `${token}:${browserDeviceId ?? ""}`;
  if (registeredKey === key) return { status: "registered", token };

  try {
    await register({
      token,
      platform: Platform.OS === "android" ? "android" : "ios",
      ...(options.label ? { label: options.label } : {}),
      browser_device_id: browserDeviceId,
    });
  } catch {
    return { status: "unavailable", reason: "The server did not accept this device." };
  }

  registeredToken = token;
  registeredKey = key;
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
  registeredKey = null;
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
  registeredKey = null;
}
