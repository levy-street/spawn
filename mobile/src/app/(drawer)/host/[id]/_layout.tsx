import { DrawerActions } from "@react-navigation/native";
import { Stack } from "expo-router";

import { DrawerHeaderButton } from "@/components/nav/drawer-header-button";
import { useTheme } from "@/theme";

export default function HostDetailLayout(): React.JSX.Element {
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
          title: "Host",
        })}
      />
      <Stack.Screen name="agents" options={{ title: "Agents" }} />
      <Stack.Screen name="files" options={{ title: "Files" }} />
    </Stack>
  );
}
