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
/**
 * The flow always starts at sign-in. Without an anchor the stack is free to
 * mount whichever auth screen sorts first and push sign-in over it — a slide
 * from the right on a cold start, and a screen underneath to swipe back to.
 */
export const unstable_settings = { initialRouteName: "login" };

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
      >
        {/* The root of the flow: nothing sits under it to swipe back to, and the
            stack's full-screen gesture was taking the sheet's own swipes. */}
        <Stack.Screen
          name="login"
          options={{ fullScreenGestureEnabled: false, gestureEnabled: false }}
        />
      </Stack>
    </>
  );
}
