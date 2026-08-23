import { Tabs } from "expo-router";

import { useRegisteredTabNavigator } from "@/components/nav/tab-switcher";

import { useTheme } from "@/theme";

/**
 * The app's three roots. Nothing else lives here.
 *
 * Detail screens — a workspace, a host, the legion, admin — are pushed by the
 * stack *above* this navigator rather than being tabs of their own. When they
 * were siblings here, opening a workspace was a tab switch: it slid the whole
 * app in over itself, skipped the push animation, and left "back" with no real
 * history to pop, so it guessed at a destination. As ordinary pushed cards they
 * get one consistent transition and a back button that returns where you came
 * from.
 *
 * Switching between these three is instant and never grows the back stack.
 */
function TabNavigatorBridge({
  navigation,
}: {
  navigation: { navigate: (name: never) => void };
}): null {
  useRegisteredTabNavigator({
    navigate: (name) => (navigation as unknown as TabNavigate).navigate(name),
  });
  return null;
}

interface TabNavigate {
  navigate: (name: string) => void;
}

export default function TabsLayout(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Tabs
      backBehavior="none"
      initialRouteName="workspaces"
      screenOptions={{
        animation: "none",
        headerShown: false,
        popToTopOnBlur: false,
        sceneStyle: { backgroundColor: theme.colors.background },
      }}
      // The visible bar is mounted once for the whole signed-in app, so it
      // survives a detail screen being pushed over the tabs. This slot only hands
      // the bar the tab navigator it needs in order to switch rather than push.
      tabBar={({ navigation }) => <TabNavigatorBridge navigation={navigation} />}
    >
      <Tabs.Screen name="workspaces" />
      <Tabs.Screen name="hosts" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}
