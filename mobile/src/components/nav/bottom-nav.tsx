import { type Href, usePathname, useRouter } from "expo-router";
import { useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";
import { dismissNavigationOverlays } from "@/components/nav/overlay-dismiss";
import { switchToTab } from "@/components/nav/tab-switcher";
import { Icon, type IconName } from "@/components/ui/icon";
import { dismissAllSheets } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, opacity, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

const DESTINATIONS = [
  { href: "/workspaces", icon: "Shapes", label: "Workspaces", rootRoute: "workspaces" },
  { href: "/hosts", icon: "Server", label: "Legion", rootRoute: "hosts" },
  { href: "/settings", icon: "Settings", label: "Settings", rootRoute: "settings" },
] as const satisfies readonly {
  href: Href;
  icon: IconName;
  label: string;
  rootRoute: string;
}[];

export type BottomNavRoute = (typeof DESTINATIONS)[number]["href"];

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

export function BottomNav(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();
  const theme = useTheme();
  // A card pushed over the tabs — profile, the terminal — belongs to no root, and
  // blanking the bar there reads as having left the app. It stays on whichever
  // root the card was opened from until a nav tap moves it.
  const destinationForPath = bottomNavDestinationForPath(pathname);
  const lastDestination = useRef<BottomNavRoute>(DESTINATIONS[0].href);
  if (destinationForPath !== null) lastDestination.current = destinationForPath;
  const activeDestination = destinationForPath ?? lastDestination.current;

  // A raised keyboard takes the bar with it. The bar is portalled to window
  // level and the system keyboard is translucent, so leaving it where it is
  // shows the tab labels ghosted through the key rows — and there is nothing to
  // tap there anyway while the keyboard covers it. Driven off the keyboard's own
  // progress rather than a visibility flag, so it leaves and comes back on the
  // keyboard's curve, an interactive drag-to-dismiss included.
  const keyboard = useReanimatedKeyboardAnimation();
  const barHeight = useSharedValue(0);
  const keyboardSlide = useAnimatedStyle(
    () => ({ transform: [{ translateY: keyboard.progress.value * barHeight.value }] }),
    [barHeight, keyboard.progress],
  );

  return (
    <Animated.View
      accessibilityLabel="Primary navigation"
      accessibilityRole="tablist"
      onLayout={(event) => {
        barHeight.value = event.nativeEvent.layout.height;
      }}
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
        keyboardSlide,
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
              // A nav tap always lands on a root, so anything covering the tabs —
              // sheets, a pushed detail, the terminal — is cleared first. The
              // check matters: dispatching a pop with nothing to pop is an
              // unhandled action, which React Navigation reports on every tap.
              dismissAllSheets();
              dismissNavigationOverlays();
              if (router.canDismiss()) router.dismissAll();
              // Switching roots is a tab jump, not a push: routing to the href
              // from out here appends a card and slides the destination in over
              // the app, which is not what a nav bar does.
              switchToTab(destination.rootRoute, () => router.navigate(destination.href));
            }}
            style={({ pressed }) => [
              styles.item,
              // Matches every other icon control: the content dims on press
              // rather than a plate appearing behind the glyph and its label.
              { opacity: pressed ? opacity.pressedContent : opacity.opaque },
            ]}
          >
            <Icon color={color} name={destination.icon} size={sizing.bottomNav.icon} />
            <Text color={color} variant="micro" weight={active ? "semibold" : "medium"}>
              {destination.label}
            </Text>
          </Pressable>
        );
      })}
    </Animated.View>
  );
}

/**
 * The bar itself, portalled to window level so it stays above pushed detail
 * screens, the terminal, sheets and modals. Mounted once by the signed-in
 * layout; nothing holds its footprint open in the layout flow, so `Screen`
 * reserves it via BottomChromeProvider.
 */
export function PersistentBottomNav(): React.JSX.Element {
  return (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal={false}>
      <View pointerEvents="box-none" style={styles.portal}>
        <BottomNav />
      </View>
    </FullWindowOverlay>
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
