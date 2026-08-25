import type { IconName } from "@/components/ui/icon";

export type SettingsPanelKey =
  | "account"
  | "appearance"
  | "notifications"
  | "hosts"
  | "agents"
  | "skills"
  | "templates"
  | "devices"
  | "trust";

export interface SettingsPanelDefinition {
  key: SettingsPanelKey;
  label: string;
  description: string;
  icon: IconName;
  route: string;
  controls: readonly string[];
}

export const SETTINGS_PANELS = [
  {
    key: "account",
    label: "Account",
    description: "Email, verification, sign out, and account deletion",
    icon: "User",
    route: "/settings/account",
    controls: [
      "Signed in as",
      "Resend verification email",
      "Log out",
      "Delete account…",
      "Type your email to confirm",
      "Password",
      "Permanently delete",
      "Cancel",
    ],
  },
  {
    key: "appearance",
    label: "Appearance",
    description: "Choose how SPAWN D looks on this device",
    icon: "Palette",
    route: "/settings/appearance",
    controls: ["Light", "Dark", "System"],
  },
  {
    key: "notifications",
    label: "Notifications",
    description: "Local alerts from the live host stream",
    icon: "Bell",
    route: "/settings/notifications",
    controls: [
      "An agent finishes",
      "An agent is waiting for you",
      "A session exits or is killed",
      "In-app message",
      "Sound",
      "System notification",
      "Vibration",
    ],
  },
  {
    key: "hosts",
    label: "Hosts",
    description: "Open host settings and connect another machine",
    icon: "Server",
    route: "/settings/hosts",
    controls: ["Open Hosts", "Connect a host"],
  },
  {
    key: "agents",
    label: "Agents",
    description: "Manage account-level command shortcuts",
    icon: "Bot",
    route: "/settings/agents",
    controls: [
      "Add agent",
      "Name",
      "Kind",
      "Command",
      "Install command (optional)",
      "Yolo arguments (optional)",
      "Environment",
      "Add variable",
      "Save changes",
      "Delete agent",
    ],
  },
  {
    key: "skills",
    label: "Skills",
    description: "Manage reusable instructions for agents",
    icon: "Wrench",
    route: "/settings/skills",
    controls: [
      "Name",
      "Description",
      "Content",
      "Grant to new sessions by default",
      "Add skill",
      "Update skill",
      "Edit",
      "Delete",
    ],
  },
  {
    key: "templates",
    label: "Templates",
    description: "Rename, re-icon, or remove saved workspace layouts",
    icon: "LayoutTemplate",
    route: "/settings/templates",
    controls: ["Change icon", "Rename", "Delete template"],
  },
  {
    key: "devices",
    label: "Browser devices",
    description: "Registered device identities and endorsements",
    icon: "MonitorSmartphone",
    route: "/settings/devices",
    controls: ["Rename", "Approve…", "Revoke", "Retry registration", "Clear history"],
  },
  {
    key: "trust",
    label: "Device trust",
    description: "This phone's identity, host pins, and saved trust",
    icon: "ShieldCheck",
    route: "/settings/trust",
    controls: [
      "Set up a passkey",
      "Unlock saved trust here",
      "Add a backup passkey",
      "Revoke",
      "Forget trust on this device",
    ],
  },
] as const satisfies readonly SettingsPanelDefinition[];

export const SETTINGS_PANEL_COUNT = 9;
