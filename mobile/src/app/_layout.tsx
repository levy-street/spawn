import "react-native-gesture-handler";

import * as Linking from "expo-linking";
import { type Href, Stack, usePathname, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect } from "react";

import { AlertPresenter } from "@/components/alerts/alert-presenter";
import { ROUNDED_CARD_GESTURE_OPTIONS } from "@/components/nav/navigation-options";
import { useCardAnimation } from "@/components/nav/navigation-reset";
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

/**
 * One configuration for the terminal card, not two. The route used to be
 * declared here as a vertical slide-from-bottom while the screen itself asked
 * for the horizontal rounded card every other pushed screen uses, so the same
 * card was described with two different dismiss directions.
 */
export const TERMINAL_ROUTE_OPTIONS = ROUNDED_CARD_GESTURE_OPTIONS;

/**
 * The gate's own screens — the launch resolver, the account flow, onboarding,
 * the signed-in shell — replace one another rather than stacking, and they do
 * it under the gate's loading cover. A replace still played the push animation
 * by default, so the very first screen slid in from the right over nothing;
 * and the replace is animated off the screen *leaving*, which has had its
 * options for the whole launch, rather than the one arriving. There is never
 * anything legitimate under these to swipe back to, so the back gesture is off
 * here — it was catching every horizontal swipe on the sign-in sheet. Only the
 * terminal, a card pushed over the shell, animates and swipes at this level.
 */
export const ROOT_CARD_OPTIONS = {
  presentation: "card",
  gestureEnabled: false,
  gestureDirection: "horizontal",
  fullScreenGestureEnabled: false,
  animation: "none",
  animationTypeForReplace: "pop",
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
            detail: "This SPAWN D link is invalid or incomplete.",
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
  const cardAnimation = useCardAnimation();

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
            // The same clipped corner every other pushed card has: a root card is
            // dragged away from the screen edge too, and a square corner there cuts
            // across the display's own curve.
            contentStyle: {
              backgroundColor: theme.colors.background,
              borderRadius: theme.radii.device,
              overflow: "hidden",
            },
            headerShown: false,
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="onboarding" />
          <Stack.Screen name="(drawer)" />
          <Stack.Screen
            name="terminal/[sessionId]"
            options={{ ...TERMINAL_ROUTE_OPTIONS, animation: cardAnimation }}
          />
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
