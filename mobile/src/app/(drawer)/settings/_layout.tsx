import { DrawerActions } from "@react-navigation/native";
import { Stack } from "expo-router";

import { DrawerHeaderButton } from "@/components/nav/drawer-header-button";
import { useTheme } from "@/theme";

export default function SettingsLayout(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={({ navigation }) => ({
        contentStyle: { backgroundColor: theme.colors.background },
        headerBackButtonDisplayMode: "minimal",
        headerRight: () => (
          <DrawerHeaderButton onPress={() => navigation.dispatch(DrawerActions.openDrawer())} />
        ),
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.foreground,
        headerTitleAlign: "center",
        headerTitleStyle: theme.type.typeStyles.uiSmMedium,
      })}
    >
      <Stack.Screen
        name="index"
        options={({ navigation }) => ({
          headerLeft: () => (
            <DrawerHeaderButton onPress={() => navigation.dispatch(DrawerActions.openDrawer())} />
          ),
          headerRight: () => null,
          title: "Settings",
        })}
      />
      <Stack.Screen name="account" options={{ title: "Account" }} />
      <Stack.Screen name="appearance" options={{ title: "Appearance" }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="hosts" options={{ title: "Hosts" }} />
      <Stack.Screen name="agents" options={{ title: "Agents" }} />
      <Stack.Screen name="skills" options={{ title: "Skills" }} />
      <Stack.Screen name="templates" options={{ title: "Templates" }} />
      <Stack.Screen name="devices" options={{ title: "Browser devices" }} />
      <Stack.Screen name="trust" options={{ title: "Device trust" }} />
      <Stack.Screen name="profile" options={{ presentation: "modal", title: "Profile" }} />
    </Stack>
  );
}
