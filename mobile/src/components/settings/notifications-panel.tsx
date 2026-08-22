import * as Notifications from "expo-notifications";
import { StyleSheet } from "react-native";
import { SettingsInfoRow, SettingsToggleRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { UnavailableRow } from "@/components/settings/unavailable-row";
import { useNotificationPreferences } from "@/components/settings/use-notification-preferences";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import { useConnectionStore } from "@/data/stores/connection";
import { haptics } from "@/lib/haptics";
import { spacing } from "@/theme";

const PUSH_UNAVAILABLE_REASON =
  "Remote notifications are unavailable in Expo Go, and spawn has no server push delivery path. Alerts arrive only while the app is running.";

export function NotificationsPanel(): React.JSX.Element {
  const toast = useToast();
  const alertSocket = useConnectionStore((state) => state.alertSocket);
  const { preferences, setPreference, error } = useNotificationPreferences();

  if (preferences === null) {
    return (
      <SettingsScreen title="Notifications">
        <Skeleton style={styles.skeleton} />
      </SettingsScreen>
    );
  }

  const sendTestAlert = async () => {
    if (preferences.haptics) haptics.success();
    if (preferences.toast) {
      toast.show("Test alert — this is what a finished agent looks like.");
    }
    if (preferences.sound) {
      try {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: "spawn",
            body: "Test alert — this is what a finished agent looks like.",
            sound: "default",
          },
          trigger: null,
        });
      } catch {
        toast.error("Notification permission was not granted.");
      }
    }
  };

  const enableSound = async () => {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "spawn",
          body: "Test alert — this is what a finished agent looks like.",
          sound: "default",
        },
        trigger: null,
      });
      setPreference("sound", true);
    } catch {
      toast.error("Notification permission was not granted.");
    }
  };

  return (
    <SettingsScreen
      description="Tells you when an agent finishes a run, so you can leave the machine and mean it. Alerts arrive the moment the host reports it — there is no polling in the path. These settings apply to this device only."
      testID="notifications-panel"
      title="Notifications"
    >
      {error ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {error}
        </Text>
      ) : null}
      <SettingsSection title="TELL ME WHEN">
        <SettingsToggleRow
          hint="The agent process exited and the shell is back. Crisp, but rarer than you would think — most coding agents stay running between turns."
          icon="BellRing"
          label="An agent finishes"
          onValueChange={(value) => setPreference("onFinished", value)}
          value={preferences.onFinished}
        />
        <SettingsToggleRow
          hint="A running agent stopped producing output — it finished its turn, or it is asking a permission question. The same moment its status dot turns amber. Coding agents idle at a prompt rather than exit, so this is usually the one you want."
          icon="MessageCircleQuestion"
          label="An agent is waiting for you"
          onValueChange={(value) => setPreference("onAwaiting", value)}
          value={preferences.onAwaiting}
        />
        <SettingsToggleRow
          hint="The shell itself went away — a crash, or a host that stopped."
          icon="Skull"
          label="A session exits or is killed"
          onValueChange={(value) => setPreference("onDied", value)}
          value={preferences.onDied}
        />
      </SettingsSection>

      <SettingsSection title="HOW">
        <SettingsToggleRow
          hint="A toast while you are looking at the app."
          icon="MessageSquare"
          label="In-app message"
          onValueChange={(value) => setPreference("toast", value)}
          value={preferences.toast}
        />
        <SettingsToggleRow
          hint="A short cue. Turning this on sends one local test notification so you know what to listen for."
          icon="Volume2"
          label="Sound"
          onValueChange={(value) => {
            if (value) {
              void enableSound();
            } else {
              setPreference("sound", false);
            }
          }}
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

      <SettingsSection>
        <SettingsInfoRow
          hint={
            alertSocket === "open"
              ? "Connected. Events arrive as they happen."
              : "Not connected — alerts will resume automatically."
          }
          icon="RadioTower"
          label="Alert stream"
          trailing={
            <Badge variant={alertSocket === "open" ? "success" : "outline"}>
              {alertSocket === "open" ? "Connected" : "Disconnected"}
            </Badge>
          }
        />
        <Button onPress={() => void sendTestAlert()} variant="outline">
          Send a test alert
        </Button>
      </SettingsSection>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    height: spacing[32] + spacing[8],
  },
});
