import { useIsFocused } from "@react-navigation/native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { TerminalOverlay } from "@/components/terminal-ui/terminal-overlay";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import {
  useKillTerminalSession,
  useRenameTerminalSession,
  useRestartTerminalSession,
  useTerminalData,
} from "@/data/queries/terminal";
import { useTheme } from "@/theme";

function routeSessionId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export const TERMINAL_ROUTE_GESTURE_OPTIONS = {
  animation: "slide_from_right",
  animationMatchesGesture: true,
  fullScreenGestureEnabled: true,
  gestureDirection: "horizontal",
  gestureEnabled: true,
  headerShown: false,
  presentation: "card",
} as const;

export default function TerminalScreen(): React.JSX.Element {
  const theme = useTheme();
  const focused = useIsFocused();
  const router = useRouter();
  const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
  const sessionId = routeSessionId(params.sessionId);
  const data = useTerminalData(sessionId);
  const rename = useRenameTerminalSession(sessionId);
  const restart = useRestartTerminalSession(sessionId);
  const kill = useKillTerminalSession(sessionId);

  const screenOptions = (
    <Stack.Screen
      options={{
        ...TERMINAL_ROUTE_GESTURE_OPTIONS,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );

  if (sessionId.length === 0 || data.error) {
    return (
      <>
        {screenOptions}
        <Screen header={<AppHeader onBack={() => router.back()} title="Terminal" />} padded={false}>
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
      </>
    );
  }

  if (data.isLoading || !data.session || !data.host) {
    return (
      <>
        {screenOptions}
        <Screen header={<AppHeader onBack={() => router.back()} title="Terminal" />} padded={false}>
          <View
            accessibilityLabel="Loading terminal"
            accessibilityRole="progressbar"
            style={[styles.center, { backgroundColor: theme.colors.background }]}
          >
            <Spinner />
          </View>
        </Screen>
      </>
    );
  }

  return (
    <>
      {screenOptions}
      <TerminalOverlay
        focused={focused}
        host={data.host}
        onDismiss={() => router.back()}
        onKill={() => kill.mutateAsync()}
        onRename={(name) => rename.mutateAsync(name).then(() => undefined)}
        onRestart={() => restart.mutateAsync().then(() => undefined)}
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
});
