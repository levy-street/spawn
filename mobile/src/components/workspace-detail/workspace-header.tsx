import { Image, StyleSheet, View } from "react-native";

import { IconButton } from "@/components/ui/icon-button";
import { Monogram } from "@/components/ui/monogram";
import { Text } from "@/components/ui/text";
import type { Workspace } from "@/data/types/domain";
import { borderWidth, chrome, useTheme } from "@/theme";

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
  const iconSize = theme.space(8);

  return (
    <View
      style={[
        styles.header,
        {
          borderBottomColor: theme.colors.border,
          borderBottomWidth: borderWidth.hairline,
          gap: theme.space(2),
          minHeight: chrome.touchTarget + topInset,
          paddingBottom: theme.space(2),
          paddingHorizontal: theme.space(2),
          paddingTop: topInset + theme.space(2),
        },
      ]}
      testID="workspace-header"
    >
      <IconButton accessibilityLabel="Back to workspaces" icon="ChevronLeft" onPress={onBack} />
      {workspace.icon ? (
        <Image
          accessibilityLabel={`${workspace.name} icon`}
          source={{ uri: workspace.icon }}
          style={{ borderRadius: theme.radii.lg, height: iconSize, width: iconSize }}
          testID="workspace-icon-image"
        />
      ) : (
        <Monogram seed={workspace.name} size={iconSize} testID="workspace-icon-monogram" />
      )}
      <View style={styles.title}>
        <Text accessibilityRole="header" numberOfLines={1} variant="title">
          {workspace.name}
        </Text>
      </View>
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
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: "center",
    flexDirection: "row",
  },
  title: {
    flex: 1,
    minWidth: 0,
  },
});
