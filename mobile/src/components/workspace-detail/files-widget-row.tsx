import { memo, useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { type SwipeAction, SwipeableRow } from "@/components/gestures/swipeable-row";
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
  onMove: () => void;
  onRemove: () => void;
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
  onMove,
  onRemove,
}: FilesWidgetRowProps) {
  const theme = useTheme();
  const title = `Files — ${pathLeaf(path)}`;
  const status = hostOnline ? "Online" : "Offline";
  const leadingActions = useMemo<SwipeAction[]>(
    () => [
      {
        key: "move",
        label: "Move",
        icon: <Icon name="ArrowRightLeft" />,
        onPress: onMove,
      },
    ],
    [onMove],
  );
  const trailingActions = useMemo<SwipeAction[]>(
    () => [
      {
        key: "remove",
        label: "Remove",
        icon: <Icon color="destructiveForeground" name="Trash2" />,
        tone: "destructive",
        onPress: onRemove,
      },
    ],
    [onRemove],
  );

  return (
    <SwipeableRow
      contentStyle={paneRowStyles.swipeContent}
      leadingActions={leadingActions}
      testID={`files-swipe-${paneId}`}
      trailingActions={trailingActions}
    >
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
          style={paneRowStyles.action}
        />
      </View>
    </SwipeableRow>
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
