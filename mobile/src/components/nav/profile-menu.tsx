import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { Monogram } from "@/components/ui/monogram";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
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
  const sheetTitle = me.data?.user.email ?? "Account";

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
        <Monogram seed={seed} size={sizing.appHeader.profileAvatar} />
      </Pressable>

      <Sheet enableDynamicSizing onDismiss={() => setVisible(false)} visible={visible}>
        <SheetHeader title={sheetTitle} />
        <View style={styles.sheetContent}>
          <ListRow
            leading={<Icon color="popoverForeground" name="UserRound" />}
            onPress={() => {
              haptics.selection();
              setVisible(false);
              router.push("/settings/profile");
            }}
            shape="fullBleed"
            title="Profile"
          />
          <ListSeparator inset={false} />
          <ListRow
            leading={<Icon color="destructive" name="LogOut" />}
            onPress={() => void signOut()}
            shape="fullBleed"
            title="Log out"
          />
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  sheetContent: {
    paddingBottom: sizing.space.peer,
  },
  trigger: {
    alignItems: "center",
    height: sizing.appHeader.actionTarget,
    justifyContent: "center",
    minHeight: sizing.appHeader.actionTarget,
    minWidth: sizing.appHeader.actionTarget,
    width: sizing.appHeader.actionTarget,
  },
});
