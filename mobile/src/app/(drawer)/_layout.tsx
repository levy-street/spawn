import { Stack, usePathname, useRouter } from "expo-router";
import type { ReactNode } from "react";

import { AdminAccessBoundary, resolveAdminAccess } from "@/components/admin/admin-access";
import { AppHeaderLeadingProvider } from "@/components/layout/app-header";
import { BottomChromeProvider } from "@/components/layout/bottom-chrome";
import { PersistentBottomNav } from "@/components/nav/bottom-nav";
import { ROUNDED_CARD_GESTURE_OPTIONS } from "@/components/nav/navigation-options";
import { useCardAnimation } from "@/components/nav/navigation-reset";
import { ProfileMenu } from "@/components/nav/profile-menu";
import { DeviceApprovalPrompt } from "@/components/trust/device-approval-prompt";
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
  "/profile": "profile",
  "/device-approval": "device-approval",
  "/settings": "settings/index",
  "/settings/account": "settings/account",
  "/settings/appearance": "settings/appearance",
  "/settings/notifications": "settings/notifications",
  "/settings/agents": "settings/agents",
  "/settings/skills": "settings/skills",
  "/settings/templates": "settings/templates",
  "/settings/devices": "settings/devices",
  "/settings/trust": "settings/trust",
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
      // Admin sits on a card pushed over the tabs, so a refusal pops back to
      // wherever it was opened from rather than jumping to a hardcoded root.
      onBack={() => {
        if (router.canGoBack()) router.back();
      }}
      onRetry={() => void me.refetch()}
      state={state}
    >
      {children}
    </AdminAccessBoundary>
  );
}

export default function AppStackLayout(): React.JSX.Element | null {
  const theme = useTheme();
  const animation = useCardAnimation();
  const account = useAuthenticatedAccount();

  if (!account.ready) return null;

  return (
    <AdminRouteBoundary>
      <AppHeaderLeadingProvider leading={<ProfileMenu />}>
        <BottomChromeProvider>
          <Stack
            screenOptions={{
              ...ROUNDED_CARD_GESTURE_OPTIONS,
              animation,
              contentStyle: {
                backgroundColor: theme.colors.background,
                borderRadius: theme.radii.device,
                overflow: "hidden",
              },
              headerShown: false,
            }}
          >
            {/* The tab host itself never slides: it is the ground everything else
              is pushed over, so animating it would animate the whole app. */}
            <Stack.Screen name="(tabs)" options={{ animation: "none", gestureEnabled: false }} />
            <Stack.Screen name="workspace/[id]" />
            <Stack.Screen name="host/[id]/index" />
            <Stack.Screen name="host/[id]/agents" />
            <Stack.Screen name="host/[id]/files" />
            <Stack.Screen name="legion" />
            <Stack.Screen name="profile" />
            <Stack.Screen name="device-approval" />
            <Stack.Screen name="admin/index" />
            <Stack.Screen name="admin/invites" />
            <Stack.Screen name="admin/users" />
            <Stack.Screen name="admin/emails" />
          </Stack>
          {/* One mount for the whole signed-in app: the bar has to outlive any card
            pushed over the tabs, and a device knocking has to be seen wherever the
            operator happens to be, not on one screen. */}
          <PersistentBottomNav />
          <DeviceApprovalPrompt />
        </BottomChromeProvider>
      </AppHeaderLeadingProvider>
    </AdminRouteBoundary>
  );
}
