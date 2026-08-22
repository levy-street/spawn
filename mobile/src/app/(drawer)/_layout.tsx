import { Stack, usePathname, useRouter } from "expo-router";
import type { ReactNode } from "react";

import { AdminAccessBoundary, resolveAdminAccess } from "@/components/admin/admin-access";
import { HeaderDestinations } from "@/components/nav/header-destinations";
import { useMeQuery } from "@/data/queries/auth";
import { useAuthenticatedAccount } from "@/lib/auth-gate";
import { useTheme } from "@/theme";

export const FULL_SCREEN_BACK_OPTIONS = {
  presentation: "card",
  gestureEnabled: true,
  gestureDirection: "horizontal",
  fullScreenGestureEnabled: true,
} as const;

export const APP_ROUTE_MAP = {
  "/workspaces": "workspaces/index",
  "/workspaces/archived": "workspaces/archived",
  "/workspace/[id]": "workspace/[id]",
  "/hosts": "hosts/index",
  "/host/[id]": "host/[id]/index",
  "/host/[id]/agents": "host/[id]/agents",
  "/host/[id]/files": "host/[id]/files",
  "/legion": "legion",
  "/settings": "settings/index",
  "/settings/account": "settings/account",
  "/settings/appearance": "settings/appearance",
  "/settings/notifications": "settings/notifications",
  "/settings/hosts": "settings/hosts",
  "/settings/agents": "settings/agents",
  "/settings/skills": "settings/skills",
  "/settings/templates": "settings/templates",
  "/settings/devices": "settings/devices",
  "/settings/trust": "settings/trust",
  "/settings/profile": "settings/profile",
  "/settings/server": "settings/server",
  "/settings/about": "settings/about",
  "/admin": "admin/index",
  "/admin/invites": "admin/invites",
  "/admin/users": "admin/users",
  "/admin/emails": "admin/emails",
} as const;

function AdminRouteBoundary({ children }: { children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const adminRoute = pathname === "/admin" || pathname.startsWith("/admin/");
  const me = useMeQuery(adminRoute);
  const state = adminRoute
    ? resolveAdminAccess({ error: me.error, loading: me.isLoading, user: me.data?.user })
    : "allowed";

  return (
    <AdminAccessBoundary
      errorMessage={me.error instanceof Error ? me.error.message : undefined}
      onBack={() => router.replace("/settings")}
      onRetry={() => void me.refetch()}
      state={state}
    >
      {children}
    </AdminAccessBoundary>
  );
}

export default function AppStackLayout(): React.JSX.Element | null {
  const theme = useTheme();
  const account = useAuthenticatedAccount();

  if (!account.ready) return null;

  return (
    <AdminRouteBoundary>
      <Stack
        initialRouteName="workspaces/index"
        screenOptions={{
          ...FULL_SCREEN_BACK_OPTIONS,
          contentStyle: { backgroundColor: theme.colors.background },
          headerBackButtonDisplayMode: "minimal",
          headerShadowVisible: false,
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.foreground,
          headerTitleAlign: "center",
        }}
      >
        <Stack.Screen
          name="workspaces/index"
          options={{
            headerBackVisible: false,
            headerRight: () => <HeaderDestinations destinations={["hosts", "settings"]} />,
            title: "Workspaces",
          }}
        />
        <Stack.Screen name="workspaces/archived" options={{ title: "Archived workspaces" }} />
        <Stack.Screen name="workspace/[id]" options={{ title: "Workspace" }} />
        <Stack.Screen
          name="hosts/index"
          options={{
            headerRight: () => <HeaderDestinations destinations={["legion", "settings"]} />,
            title: "Hosts",
          }}
        />
        <Stack.Screen name="host/[id]/index" options={{ title: "Host" }} />
        <Stack.Screen name="host/[id]/agents" options={{ title: "Agents" }} />
        <Stack.Screen name="host/[id]/files" options={{ title: "Files" }} />
        <Stack.Screen
          name="legion"
          options={{
            headerRight: () => <HeaderDestinations destinations={["hosts", "settings"]} />,
            title: "Legion",
          }}
        />
        <Stack.Screen
          name="settings/index"
          options={{
            headerRight: () => <HeaderDestinations destinations={["hosts", "admin"]} />,
            title: "Settings",
          }}
        />
        <Stack.Screen name="settings/account" options={{ title: "Account" }} />
        <Stack.Screen name="settings/appearance" options={{ title: "Appearance" }} />
        <Stack.Screen name="settings/notifications" options={{ title: "Notifications" }} />
        <Stack.Screen name="settings/hosts" options={{ title: "Hosts" }} />
        <Stack.Screen name="settings/agents" options={{ title: "Agents" }} />
        <Stack.Screen name="settings/skills" options={{ title: "Skills" }} />
        <Stack.Screen name="settings/templates" options={{ title: "Templates" }} />
        <Stack.Screen name="settings/devices" options={{ title: "Browser devices" }} />
        <Stack.Screen name="settings/trust" options={{ title: "Device trust" }} />
        <Stack.Screen name="settings/profile" options={{ title: "Profile" }} />
        <Stack.Screen name="settings/server" options={{ title: "Server" }} />
        <Stack.Screen name="settings/about" options={{ title: "About & security" }} />
        <Stack.Screen
          name="admin/index"
          options={{
            headerRight: () => <HeaderDestinations destinations={["hosts", "settings"]} />,
            title: "Admin",
          }}
        />
        <Stack.Screen name="admin/invites" options={{ title: "Invites" }} />
        <Stack.Screen name="admin/users" options={{ title: "Users" }} />
        <Stack.Screen name="admin/emails" options={{ title: "Email" }} />
      </Stack>
    </AdminRouteBoundary>
  );
}
