import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet } from "react-native";

import { ActionSheet } from "@/components/ui/action-sheet";
import { Icon } from "@/components/ui/icon";
import { Monogram } from "@/components/ui/monogram";
import { logOut } from "@/data/api/endpoints/auth";
import { useMeQuery } from "@/data/queries/auth";
import { useConnectionStore } from "@/data/stores/connection";
import { useAuthenticatedAccount } from "@/lib/auth-gate";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export function ProfileMenu(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const theme = useTheme();
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

      {/* Presented through the shared drawer, so this menu carries the same row
          height, icon size and spacing as every other one in the app. */}
      <ActionSheet
        actions={[
          {
            id: "profile",
            label: "Profile",
            icon: <Icon color="popoverForeground" name="UserRound" />,
            onPress: () => router.push("/profile"),
          },
          {
            id: "log-out",
            label: "Log out",
            destructive: true,
            icon: <Icon color="destructive" name="LogOut" />,
            onPress: () => void signOut(),
          },
        ]}
        onDismiss={() => setVisible(false)}
        visible={visible}
      />
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
