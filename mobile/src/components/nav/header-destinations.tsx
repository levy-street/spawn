import { type Href, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import type { IconName } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { spacing } from "@/theme";

export type HeaderDestination = "hosts" | "legion" | "settings" | "admin";

const DESTINATIONS: Record<
  HeaderDestination,
  { accessibilityLabel: string; href: Href; icon: IconName }
> = {
  hosts: { accessibilityLabel: "Open hosts", href: "/hosts", icon: "Server" },
  legion: { accessibilityLabel: "Open Legion", href: "/legion", icon: "RadioTower" },
  settings: { accessibilityLabel: "Open settings", href: "/settings", icon: "Settings" },
  admin: { accessibilityLabel: "Open admin", href: "/admin", icon: "ShieldCheck" },
};

export function HeaderDestinations({
  destinations,
}: {
  destinations: readonly HeaderDestination[];
}): React.JSX.Element {
  const router = useRouter();

  return (
    <View style={styles.actions}>
      {destinations.map((destination) => {
        const item = DESTINATIONS[destination];
        return (
          <IconButton
            accessibilityLabel={item.accessibilityLabel}
            icon={item.icon}
            key={destination}
            onPress={() => router.push(item.href)}
            size="lg"
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: spacing[1],
  },
});
