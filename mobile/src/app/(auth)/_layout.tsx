import { Stack } from "expo-router";
import { useReducedMotion } from "@/lib/motion/reduced-motion";
import { useTheme } from "@/theme";

export default function AuthLayout() {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  return (
    <Stack
      screenOptions={{
        animation: reducedMotion ? "none" : "fade",
        animationDuration: theme.motion.duration.base,
        contentStyle: { backgroundColor: theme.colors.background },
        headerShown: false,
      }}
    />
  );
}
