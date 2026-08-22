import { Stack } from "expo-router";

// Declared so the root navigator's `onboarding` screen resolves to a real
// child group. Without it Expo Router flattens these into sibling routes.
export default function OnboardingLayout(): React.JSX.Element {
  return <Stack screenOptions={{ headerShown: false }} />;
}
