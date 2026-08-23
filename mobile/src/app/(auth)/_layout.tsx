import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useReducedMotion } from "@/lib/motion/reduced-motion";
import { duration, useTheme } from "@/theme";

/**
 * The account flow follows the app's appearance like every other screen, so its
 * chrome is read from the theme rather than pinned: the ground behind a card is
 * the theme's own background, which is what keeps a push from flashing the
 * wrong colour through the transition.
 */
export default function AuthLayout() {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  return (
    <>
      <StatusBar
        backgroundColor={theme.colors.background}
        style={theme.isDark ? "light" : "dark"}
      />
      <Stack
        screenOptions={{
          presentation: "card",
          gestureEnabled: true,
          gestureDirection: "horizontal",
          fullScreenGestureEnabled: true,
          animation: reducedMotion ? "none" : "slide_from_right",
          animationDuration: duration.panel,
          contentStyle: { backgroundColor: theme.colors.background },
          headerShown: false,
        }}
      />
    </>
  );
}
