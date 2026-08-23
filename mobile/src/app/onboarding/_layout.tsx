import { Stack } from "expo-router";

import { useTheme } from "@/theme";

// Declared so the root navigator's `onboarding` screen resolves to a real
// child group. Without it Expo Router flattens these into sibling routes.
export default function OnboardingLayout(): React.JSX.Element {
  const theme = useTheme();

  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: theme.colors.background },
        presentation: "card",
        gestureEnabled: true,
        gestureDirection: "horizontal",
        fullScreenGestureEnabled: true,
        headerShown: false,
      }}
    />
  );
}
