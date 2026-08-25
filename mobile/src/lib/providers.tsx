import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import type { PropsWithChildren } from "react";
import { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CameraHost } from "@/components/media/camera-host";
import { ConfirmHost } from "@/components/ui/confirm";
import { ToastProvider } from "@/components/ui/toast";
import { RealtimeProvider } from "@/data/realtime/provider";
import { ThemeProvider, useTheme } from "@/theme";

export const APP_PROVIDER_ORDER = [
  "SafeAreaProvider",
  "GestureHandlerRootView",
  "ThemeProvider",
  "QueryClientProvider",
  "RealtimeProvider",
  "ToastProvider",
  "KeyboardProvider",
  "ConfirmHost",
  "CameraHost",
  "Router",
] as const;

export const APP_QUERY_DEFAULTS = {
  staleTime: 10_000,
  refetchOnWindowFocus: false,
  retry: 1,
} as const;

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: APP_QUERY_DEFAULTS,
    },
  });
}

const queryClient = createAppQueryClient();

function LaunchAppearance({ children }: PropsWithChildren): React.JSX.Element {
  const theme = useTheme();
  const didHideSplash = useRef(false);

  useEffect(() => {
    let active = true;
    void SystemUI.setBackgroundColorAsync(theme.colors.background)
      .catch(() => undefined)
      .then(() => {
        if (active && !didHideSplash.current) {
          didHideSplash.current = true;
          void SplashScreen.hideAsync();
        }
      });
    return () => {
      active = false;
    };
  }, [theme.colors.background]);

  return <>{children}</>;
}

export function AppProviders({ children }: PropsWithChildren): React.JSX.Element | null {
  const [fontsLoaded, fontError] = useFonts({
    IBMPlexSans_400Regular: require("../../assets/fonts/IBMPlexSans-Regular.ttf"),
    IBMPlexSans_500Medium: require("../../assets/fonts/IBMPlexSans-Medium.ttf"),
    Rowdies_300Light: require("../../assets/fonts/Rowdies-Light.ttf"),
  });

  if (!fontsLoaded && !fontError) return null;

  // Safe area supplies geometry; gestures need the full view; theme feeds every visual provider;
  // sheets need the gesture root; query state feeds realtime; visual hosts need the theme;
  // keyboard management and the global confirmation host stay above the router.
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        <ThemeProvider>
          <LaunchAppearance>
            <QueryClientProvider client={queryClient}>
              <RealtimeProvider>
                <ToastProvider>
                  <KeyboardProvider>
                    <ConfirmHost />
                    {/* Opened on demand over everything, the nav bar included. */}
                    <CameraHost />
                    {children}
                  </KeyboardProvider>
                </ToastProvider>
              </RealtimeProvider>
            </QueryClientProvider>
          </LaunchAppearance>
        </ThemeProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
