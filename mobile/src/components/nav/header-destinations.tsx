import { type Href, router } from "expo-router";

import type { AppHeaderAction } from "@/components/layout/app-header";
import type { IconName } from "@/components/ui/icon";

/**
 * Places a header can send you. Hosts and Settings are deliberately absent: they
 * are roots of the tab bar, and a header link to a root is what made them open
 * as cards stacked over the screen you were already on.
 */
export type HeaderDestination = "admin";

const DESTINATIONS: Record<
  HeaderDestination,
  { accessibilityLabel: string; href: Href; icon: IconName }
> = {
  admin: { accessibilityLabel: "Open admin", href: "/admin", icon: "ShieldCheck" },
};

export function headerDestinationActions(
  destinations: readonly HeaderDestination[],
): readonly AppHeaderAction[] {
  return destinations.map((destination) => {
    const item = DESTINATIONS[destination];
    return {
      accessibilityLabel: item.accessibilityLabel,
      icon: item.icon,
      onPress: () => router.push(item.href),
    };
  });
}
