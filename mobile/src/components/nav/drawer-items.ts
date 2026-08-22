import type { IconName } from "@/components/ui/icon";

export type DrawerDestinationId = "workspaces" | "hosts" | "legion" | "admin" | "settings";
export type DrawerSection = "main" | "footer";

export interface DrawerDestination {
  href: "/workspaces" | "/hosts" | "/legion" | "/admin" | "/settings";
  icon: IconName;
  id: DrawerDestinationId;
  label: string;
  section: DrawerSection;
}

const PRIMARY_DESTINATIONS: readonly DrawerDestination[] = [
  {
    href: "/workspaces",
    icon: "LayoutTemplate",
    id: "workspaces",
    label: "Workspaces",
    section: "main",
  },
  { href: "/hosts", icon: "Server", id: "hosts", label: "Hosts", section: "main" },
  { href: "/legion", icon: "RadioTower", id: "legion", label: "Legion", section: "footer" },
];

const ADMIN_DESTINATION: DrawerDestination = {
  href: "/admin",
  icon: "ShieldCheck",
  id: "admin",
  label: "Admin",
  section: "footer",
};

const SETTINGS_DESTINATION: DrawerDestination = {
  href: "/settings",
  icon: "Settings",
  id: "settings",
  label: "Settings",
  section: "footer",
};

export function drawerDestinations(isAdmin: boolean): readonly DrawerDestination[] {
  return isAdmin
    ? [...PRIMARY_DESTINATIONS, ADMIN_DESTINATION, SETTINGS_DESTINATION]
    : [...PRIMARY_DESTINATIONS, SETTINGS_DESTINATION];
}

export function activeDrawerDestination(routeName: string): DrawerDestinationId | null {
  if (routeName === "workspaces" || routeName.startsWith("workspace/")) return "workspaces";
  if (routeName === "hosts" || routeName.startsWith("host/")) return "hosts";
  if (routeName === "legion") return "legion";
  if (routeName === "admin" || routeName.startsWith("admin/")) return "admin";
  if (routeName === "settings" || routeName.startsWith("settings/")) return "settings";
  return null;
}
