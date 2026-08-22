import { type Href, router } from "expo-router";

import type { AppHeaderAction } from "@/components/layout/app-header";
import type { IconName } from "@/components/ui/icon";

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

export function headerDestinationActions(
  destinations: readonly HeaderDestination[],
): readonly AppHeaderAction[] {
  return destinations
    .filter((destination) => destination !== "hosts" && destination !== "settings")
    .map((destination) => {
      const item = DESTINATIONS[destination];
      return {
        accessibilityLabel: item.accessibilityLabel,
        icon: item.icon,
        onPress: () => router.push(item.href),
      };
    });
}
