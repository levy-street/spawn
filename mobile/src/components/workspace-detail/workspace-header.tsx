import { StyleSheet, View } from "react-native";

import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import type { Workspace } from "@/data/types/domain";
import { borderWidth, chrome, spacing, useTheme } from "@/theme";

export interface WorkspaceHeaderProps {
  workspace: Workspace;
  canAddPane: boolean;
  topInset: number;
  onBack: () => void;
  onAddPane: () => void;
  onActions: () => void;
}

export function WorkspaceHeader({
  workspace,
  canAddPane,
  topInset,
  onBack,
  onAddPane,
  onActions,
}: WorkspaceHeaderProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.header,
        {
          borderBottomColor: theme.colors.border,
          borderBottomWidth: borderWidth.hairline,
          minHeight: spacing[12] + topInset,
          paddingHorizontal: spacing[1.5],
          paddingTop: topInset,
        },
      ]}
      testID="workspace-header"
    >
      <View style={[styles.side, styles.sideStart]}>
        <IconButton accessibilityLabel="Back to workspaces" icon="ChevronLeft" onPress={onBack} />
      </View>
      <View style={styles.title}>
        <Text accessibilityRole="header" numberOfLines={1} variant="label" weight="medium">
          {workspace.name}
        </Text>
      </View>
      <View style={[styles.side, styles.sideEnd]}>
        <IconButton
          accessibilityLabel="Add terminal or files"
          disabled={!canAddPane}
          icon="Plus"
          onPress={onAddPane}
          testID="header-add-pane"
        />
        <IconButton
          accessibilityLabel="Workspace actions"
          icon="Ellipsis"
          onPress={onActions}
          testID="workspace-actions-button"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: "center",
    flexDirection: "row",
  },
  side: {
    alignItems: "center",
    flexDirection: "row",
    width: chrome.touchTarget * 2,
  },
  sideEnd: {
    justifyContent: "flex-end",
  },
  sideStart: {
    justifyContent: "flex-start",
  },
  title: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
  },
});
