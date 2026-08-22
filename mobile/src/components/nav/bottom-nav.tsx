import { useBottomSheetModal } from "@gorhom/bottom-sheet";
import { type Href, usePathname, useRouter } from "expo-router";
import { useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";
import { dismissNavigationOverlays } from "@/components/nav/overlay-dismiss";
import { Icon, type IconName } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

const DESTINATIONS = [
  { href: "/workspaces", icon: "Shapes", label: "Workspaces", rootRoute: "workspaces" },
  { href: "/hosts", icon: "Server", label: "Hosts", rootRoute: "hosts" },
  { href: "/settings", icon: "Settings", label: "Settings", rootRoute: "settings" },
] as const satisfies readonly {
  href: Href;
  icon: IconName;
  label: string;
  rootRoute: string;
}[];

export type BottomNavRoute = (typeof DESTINATIONS)[number]["href"];

interface RetainedTabRoute {
  key: string;
  name: string;
  params?: object;
}

export interface BottomNavTabState {
  index: number;
  routes: readonly RetainedTabRoute[];
}

export interface BottomNavTabNavigation {
  navigate: (name: string, params?: object) => void;
}

export interface BottomNavProps {
  navigation: BottomNavTabNavigation;
  state: BottomNavTabState;
}

const ROOT_TAB_ROUTES: Record<BottomNavRoute, string> = {
  "/hosts": "hosts",
  "/settings": "settings",
  "/workspaces": "workspaces",
};

/** Exact roots receive profile chrome; pushed routes still map to a selected destination. */
export function isBottomNavRoute(pathname: string): pathname is BottomNavRoute {
  return DESTINATIONS.some((destination) => destination.href === pathname);
}

export function bottomNavDestinationForPath(pathname: string): BottomNavRoute | null {
  if (
    pathname === "/workspaces" ||
    pathname.startsWith("/workspaces/") ||
    pathname.startsWith("/workspace/")
  ) {
    return "/workspaces";
  }
  if (pathname === "/hosts" || pathname.startsWith("/host/") || pathname === "/legion") {
    return "/hosts";
  }
  if (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/")
  ) {
    return "/settings";
  }
  return null;
}

/** Companion tabs need a route fallback because their first screen has no local stack parent. */
export function companionTabBackDestination(pathname: string): BottomNavRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0] === "workspace") return "/workspaces";
  if (segments.length === 2 && segments[0] === "host") return "/hosts";
  if (pathname === "/legion") return "/hosts";
  if (pathname === "/admin") return "/settings";
  return null;
}

function destinationForTabRoute(routeName: string): BottomNavRoute | null {
  if (routeName === "workspaces" || routeName === "workspace") return "/workspaces";
  if (routeName === "hosts" || routeName === "host" || routeName === "legion") return "/hosts";
  if (routeName === "settings" || routeName === "admin") return "/settings";
  return null;
}

export function BottomNav({ navigation, state }: BottomNavProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();
  const { dismissAll: dismissAllSheets } = useBottomSheetModal();
  const theme = useTheme();
  const activeDestination = bottomNavDestinationForPath(pathname);
  const currentTab = state.routes[state.index];
  const retainedTabs = useRef<Record<BottomNavRoute, RetainedTabRoute | undefined>>({
    "/hosts": undefined,
    "/settings": undefined,
    "/workspaces": undefined,
  });
  const currentTabDestination = currentTab ? destinationForTabRoute(currentTab.name) : null;

  // Companion routes such as `host` and `workspace` remain part of their visible
  // destination. Remembering the actual tab preserves its nested stack on return.
  if (currentTab && currentTabDestination) {
    retainedTabs.current[currentTabDestination] = currentTab;
  }

  return (
    <View
      accessibilityLabel="Primary navigation"
      accessibilityRole="tablist"
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.background,
          borderTopColor: theme.colors.border,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left + sizing.bottomNav.horizontalPadding,
          paddingRight: insets.right + sizing.bottomNav.horizontalPadding,
          paddingTop: sizing.bottomNav.verticalPadding,
        },
      ]}
      testID="bottom-nav"
    >
      {DESTINATIONS.map((destination) => {
        const active = activeDestination === destination.href;
        const color = active ? "foreground" : "mutedForeground";

        return (
          <Pressable
            accessibilityLabel={destination.label}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            key={destination.href}
            onPress={() => {
              haptics.selection();
              dismissAllSheets();
              const dismissedOverlay = dismissNavigationOverlays();
              const shouldResetToRoot =
                activeDestination === null ||
                activeDestination === destination.href ||
                dismissedOverlay;

              if (shouldResetToRoot) {
                // POP_TO_TOP clears a root-stack overlay such as Terminal. `navigate` then
                // focuses the destination root without appending another stack entry.
                router.dismissAll();
                router.navigate(destination.href);
                return;
              }

              const retained = retainedTabs.current[destination.href];
              navigation.navigate(
                retained?.name ?? ROOT_TAB_ROUTES[destination.href],
                retained?.params,
              );
            }}
            style={({ pressed }) => [
              styles.item,
              {
                backgroundColor: pressed ? theme.colors.accent : "transparent",
                borderRadius: theme.radii.md,
              },
            ]}
          >
            <Icon color={color} name={destination.icon} size={sizing.bottomNav.icon} />
            <Text color={color} variant="micro" weight={active ? "semibold" : "medium"}>
              {destination.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Keeps the navigator's layout reservation separate from its window-level control.
 * Screens already reserve the device inset, so the placeholder reserves only nav chrome;
 * the portalled bar owns and paints the physical bottom inset without charging it twice.
 */
export function PersistentBottomNav(props: BottomNavProps): React.JSX.Element {
  return (
    <>
      <View style={styles.layoutReservation} testID="bottom-nav-layout-reservation" />
      <FullWindowOverlay unstable_accessibilityContainerViewIsModal={false}>
        <View pointerEvents="box-none" style={styles.portal}>
          <BottomNav {...props} />
        </View>
      </FullWindowOverlay>
    </>
  );
}

const styles = StyleSheet.create({
  item: {
    alignItems: "center",
    flex: 1,
    gap: sizing.bottomNav.itemGap,
    justifyContent: "center",
    minHeight: sizing.bottomNav.contentHeight,
  },
  layoutReservation: {
    height: sizing.bottomNav.contentHeight + sizing.bottomNav.verticalPadding,
  },
  portal: {
    ...StyleSheet.absoluteFillObject,
  },
  root: {
    alignItems: "center",
    borderTopWidth: borderWidth.hairline,
    bottom: 0,
    flexDirection: "row",
    left: 0,
    position: "absolute",
    right: 0,
  },
});
