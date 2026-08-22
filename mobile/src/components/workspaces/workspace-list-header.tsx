import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect } from "react";
import { StyleSheet, View } from "react-native";

import { HeaderDestinations } from "@/components/nav/header-destinations";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { sizing } from "@/theme/sizing";

export interface WorkspaceListHeaderProps {
  canCreate: boolean;
  onCreate: () => void;
}

/** Keeps feature actions in the native header without restoring an in-content title bar. */
export function WorkspaceListHeader({ canCreate, onCreate }: WorkspaceListHeaderProps) {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <WorkspaceListHeaderActions canCreate={canCreate} onCreate={onCreate} />,
    });
  }, [canCreate, navigation, onCreate]);

  return null;
}

function WorkspaceListHeaderActions({ canCreate, onCreate }: WorkspaceListHeaderProps) {
  return (
    <View style={styles.actions}>
      {canCreate ? (
        <Button
          accessibilityLabel="New workspace"
          onPress={onCreate}
          size="sm"
          style={styles.create}
          testID="new-workspace-button"
          variant="ghost"
        >
          <Icon color="foreground" name="Plus" size={sizing.control.icon} variant="chrome" />
        </Button>
      ) : null}
      <HeaderDestinations destinations={["hosts", "settings"]} />
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.space.tight,
  },
  create: {
    width: sizing.control.iconButton.default,
  },
});
