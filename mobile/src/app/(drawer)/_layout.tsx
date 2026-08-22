import { Tabs, usePathname, useRouter } from "expo-router";
import type { ReactNode } from "react";

import { AdminAccessBoundary, resolveAdminAccess } from "@/components/admin/admin-access";
import { AppHeaderLeadingProvider } from "@/components/layout/app-header";
import {
  companionTabBackDestination,
  isBottomNavRoute,
  PersistentBottomNav,
} from "@/components/nav/bottom-nav";
import { ProfileMenu } from "@/components/nav/profile-menu";
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
  const pathname = usePathname();
  const router = useRouter();

  if (!account.ready) return null;

  const showRootNavigation = isBottomNavRoute(pathname);
  const companionBackDestination = companionTabBackDestination(pathname);

  return (
    <AdminRouteBoundary>
      <AppHeaderLeadingProvider
        {...(companionBackDestination === null
          ? {}
          : { backOverride: () => router.navigate(companionBackDestination) })}
        leading={showRootNavigation ? <ProfileMenu /> : null}
      >
        <Tabs
          backBehavior="none"
          initialRouteName="workspaces"
          screenOptions={{
            animation: "none",
            headerShown: false,
            popToTopOnBlur: false,
            sceneStyle: { backgroundColor: theme.colors.background },
          }}
          tabBar={({ navigation, state }) => (
            <PersistentBottomNav
              navigation={{
                navigate: (name, params) => navigation.navigate(name, params),
              }}
              state={{
                index: state.index,
                routes: state.routes.map((route) => ({
                  key: route.key,
                  name: route.name,
                  ...(route.params === undefined ? {} : { params: route.params }),
                })),
              }}
            />
          )}
        >
          <Tabs.Screen name="workspaces" />
          <Tabs.Screen name="workspace" />
          <Tabs.Screen name="hosts" />
          <Tabs.Screen name="host" />
          <Tabs.Screen name="legion" />
          <Tabs.Screen name="settings" />
          <Tabs.Screen name="admin" />
        </Tabs>
      </AppHeaderLeadingProvider>
    </AdminRouteBoundary>
  );
}
