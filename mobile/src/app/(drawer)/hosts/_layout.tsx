import { DrawerActions } from "@react-navigation/native";
import { Stack } from "expo-router";

import { DrawerHeaderButton } from "@/components/nav/drawer-header-button";
import { useTheme } from "@/theme";

export default function HostsLayout(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: theme.colors.background },
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.foreground,
        headerTitleAlign: "center",
        headerTitleStyle: theme.type.typeStyles.uiSmMedium,
      }}
    >
      <Stack.Screen
        name="index"
        options={({ navigation }) => ({
          headerLeft: () => (
            <DrawerHeaderButton onPress={() => navigation.dispatch(DrawerActions.openDrawer())} />
          ),
          title: "Hosts",
        })}
      />
    </Stack>
  );
}
