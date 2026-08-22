import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect } from "react";
import { StyleSheet, View } from "react-native";

import { IconButton } from "@/components/ui/icon-button";
import type { Workspace } from "@/data/types/domain";
import { sizing } from "@/theme/sizing";

export interface WorkspaceHeaderProps {
  workspace: Workspace;
  canAddPane: boolean;
  onAddPane: () => void;
  onActions: () => void;
}

/** Configures the owning native-stack header so this screen never charges the top inset twice. */
export function WorkspaceHeader({
  workspace,
  canAddPane,
  onAddPane,
  onActions,
}: WorkspaceHeaderProps) {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    navigation.setOptions({
      title: workspace.name,
      headerRight: () => (
        <WorkspaceHeaderActions
          canAddPane={canAddPane}
          onActions={onActions}
          onAddPane={onAddPane}
        />
      ),
    });
  }, [canAddPane, navigation, onActions, onAddPane, workspace.name]);

  return null;
}

function WorkspaceHeaderActions({
  canAddPane,
  onAddPane,
  onActions,
}: Pick<WorkspaceHeaderProps, "canAddPane" | "onAddPane" | "onActions">) {
  return (
    <View style={styles.actions}>
      <IconButton
        accessibilityHint={
          canAddPane ? undefined : "This tab is full. A tab can contain up to 16 panes."
        }
        accessibilityLabel="Add terminal or files"
        icon="Plus"
        onPress={onAddPane}
        style={styles.action}
        testID="header-add-pane"
      />
      <IconButton
        accessibilityLabel="Workspace actions"
        icon="Ellipsis"
        onPress={onActions}
        style={styles.action}
        testID="workspace-actions-button"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    height: sizing.control.iconButton.default,
    width: sizing.control.iconButton.default,
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
  },
});
