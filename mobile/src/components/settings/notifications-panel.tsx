import { useCallback, useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import { SettingsToggleRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { UnavailableRow } from "@/components/settings/unavailable-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useNotificationPreferences } from "@/data/queries/alerts";
import { haptics } from "@/lib/haptics";
import {
  hydrateNotificationPreferences,
  type NotificationPreferenceKey,
} from "@/lib/notifications";
import { spacing } from "@/theme";

const PUSH_UNAVAILABLE_REASON = "Alerts arrive only while the app is running.";
type NotificationBooleanPreferenceKey = Exclude<NotificationPreferenceKey, "mutedSessions">;

export function NotificationsPanel(): React.JSX.Element {
  const { prefs: preferences, setPreference: setSharedPreference } = useNotificationPreferences();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const setPreference = useCallback(
    (key: NotificationBooleanPreferenceKey, value: boolean) => {
      void setSharedPreference(key, value).then(
        () => setError(null),
        () => setError("Notification preferences could not be saved on this device."),
      );
    },
    [setSharedPreference],
  );

  if (!ready) {
    return (
      <SettingsScreen title="Notifications">
        <Skeleton style={styles.skeleton} />
      </SettingsScreen>
    );
  }

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
        <UnavailableRow
          icon="BellRing"
          label="System notification"
          reason={PUSH_UNAVAILABLE_REASON}
          testID="push-unavailable"
        />
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
