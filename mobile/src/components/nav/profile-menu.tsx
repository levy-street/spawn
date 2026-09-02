import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { THEME_OPTIONS } from "@/components/settings/appearance-panel";
import { DrawerRow, DrawerSeparator } from "@/components/ui/drawer-row";
import { Icon } from "@/components/ui/icon";
import { Monogram } from "@/components/ui/monogram";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { logOut } from "@/data/api/endpoints/auth";
import { useMeQuery } from "@/data/queries/auth";
import { useConnectionStore } from "@/data/stores/connection";
import { useAuthenticatedAccount } from "@/lib/auth-gate";
import { haptics } from "@/lib/haptics";
import { type ThemeMode, useTheme, useThemeMode } from "@/theme";
import { sizing } from "@/theme/sizing";

export function ProfileMenu(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const theme = useTheme();
  const { mode, setMode } = useThemeMode();
  const account = useAuthenticatedAccount();
  const me = useMeQuery();
  const [visible, setVisible] = useState(false);
  const seed = me.data?.user.email ?? account.accountId ?? "Profile";

  const signOut = async (): Promise<void> => {
    await logOut().catch(() => undefined);
    useConnectionStore.getState().reset();
    queryClient.clear();
    router.replace("/login");
  };

  return (
    <>
      <Pressable
        accessibilityLabel="Open profile menu"
        accessibilityRole="button"
        onPress={() => {
          haptics.overlayOpen();
          setVisible(true);
        }}
        style={({ pressed }) => [
          styles.trigger,
          {
            backgroundColor: pressed ? theme.colors.accent : "transparent",
            borderRadius: theme.radii.pill,
          },
        ]}
        testID="profile-menu-trigger"
      >
        <Monogram seed={seed} size={sizing.appHeader.profileAvatar} variant="brand" />
      </Pressable>

      {/* The shared drawer rows, so this menu carries the same row height,
          icon size and spacing as every other one in the app — composed by
          hand rather than through ActionSheet because the theme is a value
          to set, not an action to take, and it sits between the rows as the
          segmented control Appearance uses. Changing it keeps the sheet up:
          the app restyling around the control is the readout. */}
      <Sheet onDismiss={() => setVisible(false)} testID="profile-sheet" visible={visible}>
        <View>
          <DrawerRow
            icon={<Icon color="popoverForeground" name="UserRound" />}
            label="Profile"
            onPress={() => {
              haptics.selection();
              router.push("/profile");
              setVisible(false);
            }}
          />
          <DrawerSeparator />
          <View
            style={{
              gap: theme.space(2),
              paddingHorizontal: sizing.actionSheet.horizontalPadding,
              paddingVertical: theme.space(3),
            }}
          >
            <Text color="mutedForeground" variant="caption">
              Theme
            </Text>
            <SegmentedControl<ThemeMode>
              accessibilityLabel="Theme"
              onChange={setMode}
              options={THEME_OPTIONS}
              testID="profile-theme-mode"
              value={mode}
            />
          </View>
          <DrawerSeparator />
          <DrawerRow
            destructive
            icon={<Icon color="destructive" name="LogOut" />}
            label="Log out"
            onPress={() => {
              haptics.warning();
              setVisible(false);
              void signOut();
            }}
          />
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    alignItems: "center",
    height: sizing.appHeader.actionTarget,
    justifyContent: "center",
    minHeight: sizing.appHeader.actionTarget,
    minWidth: sizing.appHeader.actionTarget,
    width: sizing.appHeader.actionTarget,
  },
});
