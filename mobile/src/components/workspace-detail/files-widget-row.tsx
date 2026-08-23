import { memo } from "react";
import { StyleSheet, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { paneRowStyles } from "@/components/workspace-detail/pane-row-styles";
import { haptics } from "@/lib/haptics";
import { borderWidth, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface FilesWidgetRowProps {
  paneId: string;
  hostName: string | null;
  hostOnline: boolean;
  path: string;
  onOpen: () => void;
  onActions: () => void;
}

function pathLeaf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || path;
}

export const FilesWidgetRow = memo(function FilesWidgetRow({
  paneId,
  hostName,
  hostOnline,
  path,
  onOpen,
  onActions,
}: FilesWidgetRowProps) {
  const theme = useTheme();
  const title = `Files — ${pathLeaf(path)}`;
  const status = hostOnline ? "Online" : "Offline";

  // Move and remove live in the row's ... menu; the swipe layer was a second
  // hidden path to the same actions.
  return (
    <View style={paneRowStyles.frame} testID={`files-row-${paneId}`}>
      <ListRow
        leading={
          <View
            style={[
              styles.iconPlate,
              {
                backgroundColor: theme.colors.muted,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.lg,
              },
            ]}
          >
            <Icon color="mutedForeground" name="FolderTree" size={sizing.control.icon} />
          </View>
        }
        onLongPress={() => {
          haptics.impact("medium");
          onActions();
        }}
        onPress={() => {
          haptics.selection();
          onOpen();
        }}
        shape="fullBleed"
        {...(hostName ? { subtitle: hostName } : {})}
        title={title}
        trailing={
          <View style={paneRowStyles.status}>
            <StatusDot pulse={false} tone={hostOnline ? "active" : "offline"} />
            <Text color="mutedForeground" variant="caption">
              {status}
            </Text>
          </View>
        }
      />
      <IconButton
        accessibilityLabel={`Actions for ${title}`}
        icon="Ellipsis"
        onPress={onActions}
        size="lg"
        style={paneRowStyles.action}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  iconPlate: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    height: sizing.listRow.leading.rich,
    justifyContent: "center",
    width: sizing.listRow.leading.rich,
  },
});
