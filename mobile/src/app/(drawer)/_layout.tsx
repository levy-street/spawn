import { DrawerActions } from "@react-navigation/native";
import { Drawer } from "expo-router/drawer";

import { SpawnDrawerContent } from "@/components/nav/drawer-content";
import { DrawerHeaderButton } from "@/components/nav/drawer-header-button";
import { chrome, spacing, useTheme } from "@/theme";

export const ROOT_DRAWER_ROUTES = ["workspaces", "hosts", "legion", "settings"] as const;
export const DRAWER_SWIPE_EDGE_WIDTH = spacing[5];

const HIDDEN_DRAWER_ITEM = { display: "none" } as const;

export default function DrawerLayout(): React.JSX.Element {
  const theme = useTheme();

  return (
    <Drawer
      backBehavior="history"
      drawerContent={(props) => <SpawnDrawerContent {...props} />}
      screenOptions={({ navigation }) => ({
        drawerPosition: "left",
        drawerStyle: {
          backgroundColor: theme.colors.background,
          width: chrome.drawerMaxWidth,
        },
        drawerType: "back",
        headerBackButtonDisplayMode: "minimal",
        headerLeft: () => (
          <DrawerHeaderButton onPress={() => navigation.dispatch(DrawerActions.openDrawer())} />
        ),
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.foreground,
        headerTitleAlign: "center",
        headerTitleStyle: {
          fontFamily: theme.type.fontFamily.sans,
          fontSize: theme.type.fontSize.sm,
          fontWeight: theme.type.fontWeight.medium,
        },
        keyboardDismissMode: "on-drag",
        overlayColor: "transparent",
        sceneStyle: { backgroundColor: theme.colors.background },
        swipeEdgeWidth: DRAWER_SWIPE_EDGE_WIDTH,
        swipeEnabled: true,
      })}
    >
      <Drawer.Screen name="workspaces" options={{ headerShown: false, title: "Workspaces" }} />
      <Drawer.Screen name="hosts" options={{ headerShown: false, title: "Hosts" }} />
      <Drawer.Screen name="legion" options={{ title: "Legion" }} />
      <Drawer.Screen name="settings" options={{ headerShown: false, title: "Settings" }} />
      <Drawer.Screen
        name="workspace/[id]"
        options={{ drawerItemStyle: HIDDEN_DRAWER_ITEM, title: "Workspace" }}
      />
      <Drawer.Screen
        name="host/[id]"
        options={{ drawerItemStyle: HIDDEN_DRAWER_ITEM, headerShown: false, title: "Host" }}
      />
      <Drawer.Screen
        name="admin"
        options={{ drawerItemStyle: HIDDEN_DRAWER_ITEM, headerShown: false, title: "Admin" }}
      />
    </Drawer>
  );
}
