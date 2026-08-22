import { type Href, usePathname, useRouter } from "expo-router";
import { useContext } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { Icon, type IconName } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

const DESTINATIONS = [
  { href: "/workspaces", icon: "Shapes", label: "Workspaces" },
  { href: "/hosts", icon: "Server", label: "Hosts" },
  { href: "/settings", icon: "Settings", label: "Settings" },
] as const satisfies readonly { href: Href; icon: IconName; label: string }[];

export type BottomNavRoute = (typeof DESTINATIONS)[number]["href"];

export function isBottomNavRoute(pathname: string): pathname is BottomNavRoute {
  return DESTINATIONS.some((destination) => destination.href === pathname);
}

export function BottomNav(): React.JSX.Element {
  const insets = useContext(SafeAreaInsetsContext) ?? {
    bottom: spacing[0],
    left: spacing[0],
    right: spacing[0],
    top: spacing[0],
  };
  const pathname = usePathname();
  const router = useRouter();
  const theme = useTheme();

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
        const active = pathname === destination.href;
        const color = active ? "foreground" : "mutedForeground";

        return (
          <Pressable
            accessibilityLabel={destination.label}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            key={destination.href}
            onPress={() => {
              haptics.selection();
              router.replace(destination.href);
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

const styles = StyleSheet.create({
  item: {
    alignItems: "center",
    flex: 1,
    gap: sizing.bottomNav.itemGap,
    justifyContent: "center",
    minHeight: sizing.bottomNav.contentHeight,
  },
  root: {
    alignItems: "center",
    borderTopWidth: borderWidth.hairline,
    flexDirection: "row",
    width: "100%",
  },
});
