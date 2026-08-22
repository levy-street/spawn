import { Tabs } from "expo-router";
import { useMemo } from "react";

import { Icon, type IconName } from "@/components/ui/icon";
import { attentionSummaryFromCounts, sessionAttentionSummary } from "@/data/queries/alerts";
import { useWorkspaceSessionsQuery } from "@/data/queries/workspaces";
import { haptics } from "@/lib/haptics";
import { borderWidth, useTheme } from "@/theme";

export const ROOT_TABS = [
  { name: "workspaces", title: "Workspaces", icon: "LayoutTemplate" },
  { name: "hosts", title: "Hosts", icon: "Server" },
  { name: "files", title: "Files", icon: "Folder" },
  { name: "settings", title: "Settings", icon: "Settings" },
] as const satisfies readonly { name: string; title: string; icon: IconName }[];

export default function TabsLayout(): React.JSX.Element {
  const theme = useTheme();
  const sessions = useWorkspaceSessionsQuery();
  const attention = useMemo(() => {
    let waiting = 0;
    let dead = 0;
    for (const session of sessions.data ?? []) {
      const summary = sessionAttentionSummary(session);
      waiting += summary?.waiting ?? 0;
      dead += summary?.dead ?? 0;
    }
    return attentionSummaryFromCounts(waiting, dead);
  }, [sessions.data]);
  const workspacesBadge = attention ? (attention.total > 99 ? "99+" : attention.total) : undefined;

  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.foreground,
        tabBarHideOnKeyboard: true,
        tabBarInactiveTintColor: theme.colors.mutedForeground,
        tabBarLabelStyle: {
          fontFamily: theme.type.fontFamily.sans,
          fontSize: theme.type.fontSize.micro,
          fontWeight: theme.type.fontWeight.medium,
        },
        tabBarStyle: {
          backgroundColor: theme.colors.card,
          borderTopColor: theme.colors.border,
          borderTopWidth: borderWidth.hairline,
        },
      }}
    >
      {ROOT_TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          listeners={({ navigation }) => ({
            tabPress: () => {
              if (!navigation.isFocused()) haptics.selection();
            },
          })}
          name={tab.name}
          options={{
            tabBarAccessibilityLabel: `${tab.title} tab`,
            ...(tab.name === "workspaces" && workspacesBadge !== undefined
              ? { tabBarBadge: workspacesBadge }
              : {}),
            tabBarBadgeStyle: {
              backgroundColor:
                attention?.highest === "dead" ? theme.colors.destructive : theme.colors.warning,
              color: theme.colors.background,
            },
            tabBarIcon: ({ focused }) => (
              <Icon
                color={focused ? "foreground" : "mutedForeground"}
                name={tab.icon}
                size={theme.space(5)}
              />
            ),
            title: tab.title,
          }}
        />
      ))}
    </Tabs>
  );
}
