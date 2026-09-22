import { useIsFocused } from "@react-navigation/native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { ROUNDED_CARD_GESTURE_OPTIONS } from "@/components/nav/navigation-options";
import { TerminalOverlay } from "@/components/terminal-ui/terminal-overlay";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import {
  useKillTerminalSession,
  useRenameTerminalSession,
  useRestartTerminalSession,
  useTerminalData,
} from "@/data/queries/terminal";
import { restartDetail } from "@/data/selectors/agent";
import { useTheme } from "@/theme";
import { bottomNavHeight } from "@/theme/sizing";

function routeSessionId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function killReason(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The server did not answer.";
}

export const TERMINAL_ROUTE_GESTURE_OPTIONS = {
  ...ROUNDED_CARD_GESTURE_OPTIONS,
  headerShown: false,
} as const;

export default function TerminalScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const router = useRouter();
  const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
  const sessionId = routeSessionId(params.sessionId);
  const data = useTerminalData(sessionId);
  const rename = useRenameTerminalSession(sessionId);
  const restart = useRestartTerminalSession(sessionId);
  const kill = useKillTerminalSession(sessionId);
  const toast = useToast();

  /**
   * The kill runs on after the terminal has closed over it, so the answer has
   * to arrive somewhere that outlives this screen. It never rethrows for the
   * same reason: there is no longer anything mounted to catch it.
   */
  const killSession = async (name: string | null): Promise<void> => {
    try {
      const result = await kill.mutateAsync();
      if (result.paneError) {
        toast.error("Session killed, but its pane stayed in the workspace", {
          detail: result.paneError.message,
        });
      } else if (result.alreadyGone) {
        toast.success("Session removed", { detail: "It had already ended on the host." });
      } else {
        toast.success("Session killed", name ? { detail: name } : undefined);
      }
    } catch (error) {
      toast.error("Session could not be killed", { detail: killReason(error) });
    }
  };

  const screenOptions = (
    <Stack.Screen
      options={{
        ...TERMINAL_ROUTE_GESTURE_OPTIONS,
        // The same clipped corner every other pushed card carries: the terminal
        // is dragged away from the screen edge too, and a smaller radius there
        // cuts across the display's own curve mid-swipe.
        contentStyle: {
          backgroundColor: theme.colors.background,
          borderRadius: theme.radii.device,
          overflow: "hidden",
        },
      }}
    />
  );

  if (sessionId.length === 0 || data.error) {
    return (
      <>
        {screenOptions}
        <View
          style={[styles.navClearance, { paddingBottom: bottomNavHeight(insets.bottom) }]}
          testID="terminal-nav-clearance"
        >
          <Screen
            header={<AppHeader onBack={() => router.back()} title="Terminal" />}
            padded={false}
          >
            <View
              style={[
                styles.center,
                {
                  backgroundColor: theme.colors.background,
                  gap: theme.space(3),
                  paddingHorizontal: theme.space(6),
                },
              ]}
            >
              <Text accessibilityRole="header" variant="title">
                Terminal unavailable
              </Text>
              <Text color="mutedForeground" style={styles.centered} variant="body">
                {sessionId.length === 0
                  ? "This terminal link does not include a session."
                  : (data.error?.message ?? "The session could not be loaded.")}
              </Text>
              {sessionId.length > 0 ? (
                <Button onPress={() => void data.refetch()} variant="outline">
                  Retry
                </Button>
              ) : null}
            </View>
          </Screen>
        </View>
      </>
    );
  }

  if (data.isLoading || !data.session || !data.host) {
    return (
      <>
        {screenOptions}
        <View
          style={[styles.navClearance, { paddingBottom: bottomNavHeight(insets.bottom) }]}
          testID="terminal-nav-clearance"
        >
          <Screen
            header={<AppHeader onBack={() => router.back()} title="Terminal" />}
            padded={false}
          >
            <View
              accessibilityLabel="Loading terminal"
              accessibilityRole="progressbar"
              style={[styles.center, { backgroundColor: theme.colors.background }]}
            >
              <Spinner />
            </View>
          </Screen>
        </View>
      </>
    );
  }

  const host = data.host;
  const sessionName = data.session.name?.trim() || null;
  return (
    <>
      {screenOptions}
      {/* No clearance wrapper here: the overlay reserves the nav bar itself and
        gives that reservation back the moment the keyboard covers the bar. A
        fixed padding is what left a dead band under the key row. */}
      <TerminalOverlay
        focused={focused}
        host={host}
        onDismiss={() => router.back()}
        onKill={() => killSession(sessionName)}
        onRename={(name) => rename.mutateAsync(name).then(() => undefined)}
        onRestart={(terminal, onPhase) => restart.mutateAsync({ terminal, onPhase })}
        restartDetail={restartDetail(data.session, data.agents)}
        session={data.session}
      />
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  centered: {
    textAlign: "center",
  },
  navClearance: {
    flex: 1,
  },
});
