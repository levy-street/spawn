import { Stack, useRouter } from "expo-router";

import { AdminAccessBoundary, resolveAdminAccess } from "@/components/admin/admin-access";
import { useMeQuery } from "@/data/queries/auth";
import { useTheme } from "@/theme";

export default function AdminLayout(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const me = useMeQuery();
  const state = resolveAdminAccess({
    error: me.error,
    loading: me.isLoading,
    user: me.data?.user,
  });

  return (
    <AdminAccessBoundary
      errorMessage={me.error instanceof Error ? me.error.message : undefined}
      onBack={() => router.replace("/(tabs)/settings")}
      onRetry={() => void me.refetch()}
      state={state}
    >
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: theme.colors.background },
          headerBackButtonDisplayMode: "minimal",
          headerShadowVisible: false,
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.foreground,
        }}
      >
        <Stack.Screen name="index" options={{ title: "Admin" }} />
        <Stack.Screen name="invites" options={{ title: "Invites" }} />
        <Stack.Screen name="users" options={{ title: "Users" }} />
        <Stack.Screen name="emails" options={{ title: "Email" }} />
      </Stack>
    </AdminAccessBoundary>
  );
}
