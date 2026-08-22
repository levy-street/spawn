import "react-native-gesture-handler";

import * as Linking from "expo-linking";
import { type Href, Stack, usePathname, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect } from "react";

import { AlertPresenter } from "@/components/alerts/alert-presenter";
import { useToast } from "@/components/ui/toast";
import { authToken } from "@/data/api/auth-token";
import { AuthGate } from "@/lib/auth-gate";
import {
  isSpawnOwnedUrl,
  rememberPendingAuthenticatedLink,
  resolveIncomingLink,
  subscribeToIncomingUrls,
  takePendingAuthenticatedLink,
} from "@/lib/linking";
import { AppProviders } from "@/lib/providers";
import { useTheme } from "@/theme";

void SplashScreen.preventAutoHideAsync();

export const TERMINAL_ROUTE_OPTIONS = {
  presentation: "card",
  gestureEnabled: true,
  gestureDirection: "vertical",
  animation: "slide_from_bottom",
  animationMatchesGesture: true,
  fullScreenGestureEnabled: true,
} as const;

export const ROOT_CARD_OPTIONS = {
  presentation: "card",
  gestureEnabled: true,
  gestureDirection: "horizontal",
  fullScreenGestureEnabled: true,
} as const;

function IncomingLinkCoordinator(): null {
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();

  const openIncomingUrl = useCallback(
    async (url: string) => {
      const link = resolveIncomingLink(url);
      if (!link) {
        if (isSpawnOwnedUrl(url)) {
          toast.error("Can’t open link", {
            detail: "This spawn link is invalid or incomplete.",
          });
        }
        return;
      }

      if (link.requiresAuth) {
        const token = await authToken.get().catch(() => null);
        if (token === null) rememberPendingAuthenticatedLink(link);
      }
      router.replace(link.href as Href);
    },
    [router, toast],
  );

  useEffect(
    () => subscribeToIncomingUrls(Linking, (url) => void openIncomingUrl(url)),
    [openIncomingUrl],
  );

  useEffect(() => {
    if (pathname !== "/workspaces") return;
    const pending = takePendingAuthenticatedLink();
    if (pending && pending.href !== pathname) router.replace(pending.href as Href);
  }, [pathname, router]);

  return null;
}

function RootNavigator(): React.JSX.Element {
  const theme = useTheme();

  return (
    <>
      <StatusBar
        backgroundColor={theme.colors.background}
        style={theme.isDark ? "light" : "dark"}
      />
      <IncomingLinkCoordinator />
      <AuthGate>
        <AlertPresenter />
        <Stack
          screenOptions={{
            ...ROOT_CARD_OPTIONS,
            contentStyle: { backgroundColor: theme.colors.background },
            headerShown: false,
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="onboarding" />
          <Stack.Screen name="(drawer)" />
          <Stack.Screen name="terminal/[sessionId]" options={TERMINAL_ROUTE_OPTIONS} />
        </Stack>
      </AuthGate>
    </>
  );
}

export default function RootLayout(): React.JSX.Element {
  return (
    <AppProviders>
      <RootNavigator />
    </AppProviders>
  );
}
