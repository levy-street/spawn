import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, StyleSheet } from "react-native";
import { SettingsLinkRow, SettingsToggleRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useNotificationPreferences } from "@/data/queries/alerts";
import { haptics } from "@/lib/haptics";
import {
  getLocalNotificationPermission,
  hydrateNotificationPreferences,
  type LocalNotificationPermission,
  type NotificationPreferenceKey,
} from "@/lib/notifications";
import { requestPushRegistration, unregisterForPushNotifications } from "@/lib/push";
import { spacing } from "@/theme";

type NotificationBooleanPreferenceKey = Exclude<NotificationPreferenceKey, "mutedSessions">;

/** What the system-notification row says under its label, given where things stand. */
export function systemNotificationHint(
  permission: LocalNotificationPermission | null,
  enabled: boolean,
): string {
  if (permission === "denied") {
    return "Turned off for SPAWN D in the system Settings. Turn it on there and come back.";
  }
  if (enabled && permission === "granted") {
    return "Alerts reach this phone even while SPAWN D is closed.";
  }
  return "Alerts reach this phone even while SPAWN D is closed. Asks for permission when turned on.";
}

export function NotificationsPanel(): React.JSX.Element {
  const {
    prefs: preferences,
    setPreference: setSharedPreference,
    setSystemEnabled,
  } = useNotificationPreferences();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<LocalNotificationPermission | null>(null);

  useEffect(() => {
    let active = true;
    void hydrateNotificationPreferences().then(
      () => {
        if (active) setReady(true);
      },
      () => {
        if (active) {
          setError("Notification preferences could not be loaded on this device.");
          setReady(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  // The system's answer is read here, and read again whenever the app comes
  // back to the front: the way to reverse a refusal is the system Settings,
  // and the row has to reflect what was done there without a restart.
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getLocalNotificationPermission().then((next) => {
        if (active) setPermission(next);
      });
    };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const setPreference = useCallback(
    (key: NotificationBooleanPreferenceKey, value: boolean) => {
      void setSharedPreference(key, value).then(
        () => setError(null),
        () => setError("Notification preferences could not be saved on this device."),
      );
    },
    [setSharedPreference],
  );

  const toggleSystem = useCallback(
    async (value: boolean) => {
      try {
        const result = await setSystemEnabled(value);
        setPermission(result);
        setError(null);
        if (!value) {
          await unregisterForPushNotifications();
          return;
        }
        if (result === "granted") {
          haptics.success();
          requestPushRegistration();
        } else {
          haptics.error();
        }
      } catch {
        setError("Notification preferences could not be saved on this device.");
      }
    },
    [setSystemEnabled],
  );

  if (!ready) {
    return (
      <SettingsScreen title="Notifications">
        <Skeleton style={styles.skeleton} />
      </SettingsScreen>
    );
  }

  const systemOn = preferences.system && permission === "granted";

  return (
    <SettingsScreen testID="notifications-panel" title="Notifications">
      {error ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {error}
        </Text>
      ) : null}
      <SettingsSection title="Tell me when">
        <SettingsToggleRow
          hint="The agent process exited and the shell is back."
          icon="BellRing"
          label="An agent finishes"
          onValueChange={(value) => setPreference("onFinished", value)}
          value={preferences.onFinished}
        />
        <SettingsToggleRow
          hint="A running agent stopped producing output. Usually the one you want."
          icon="MessageCircleQuestion"
          label="An agent is waiting for you"
          onValueChange={(value) => setPreference("onAwaiting", value)}
          value={preferences.onAwaiting}
        />
        <SettingsToggleRow
          hint="The shell went away: a crash, or a host that stopped."
          icon="Skull"
          label="A session exits or is killed"
          onValueChange={(value) => setPreference("onDied", value)}
          value={preferences.onDied}
        />
      </SettingsSection>

      <SettingsSection title="How">
        <SettingsToggleRow
          hint="A toast while you are looking at the app."
          icon="MessageSquare"
          label="In-app message"
          onValueChange={(value) => setPreference("toast", value)}
          value={preferences.toast}
        />
        <SettingsToggleRow
          hint="A short cue on the same events."
          icon="Volume2"
          label="Sound"
          onValueChange={(value) => setPreference("sound", value)}
          value={preferences.sound}
        />
        <SettingsToggleRow
          hint={systemNotificationHint(permission, preferences.system)}
          icon="BellRing"
          label="System notification"
          onValueChange={(value) => void toggleSystem(value)}
          testID="push-toggle"
          value={systemOn}
        />
        {permission === "denied" ? (
          <SettingsLinkRow
            accessibilityHint="Opens the system Settings for SPAWN D"
            hint="SPAWN D cannot ask a second time itself."
            icon="ExternalLink"
            label="Open system Settings"
            onPress={() => void Linking.openSettings()}
            testID="push-open-settings"
          />
        ) : null}
        <SettingsToggleRow
          hint="A short buzz on the same events."
          icon="Smartphone"
          label="Vibration"
          onValueChange={(value) => {
            if (value) haptics.success();
            setPreference("haptics", value);
          }}
          value={preferences.haptics}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    height: spacing[32] + spacing[8],
  },
});
