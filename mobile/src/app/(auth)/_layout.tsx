import { Stack } from "expo-router";
import { useTheme } from "@/theme";

export default function AuthLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        animation: "fade",
        contentStyle: { backgroundColor: theme.colors.background },
        headerShown: false,
      }}
    />
  );
}
