import { memo, useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { type SwipeAction, SwipeableRow } from "@/components/gestures/swipeable-row";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
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
  const detail = hostName ? `${hostName} · ${path}` : path;
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
      contentStyle={{ backgroundColor: theme.colors.background }}
      leadingActions={leadingActions}
      style={{ borderRadius: theme.radii.lg }}
      testID={`files-swipe-${paneId}`}
      trailingActions={trailingActions}
    >
      <View style={styles.frame} testID={`files-row-${paneId}`}>
        <ListRow
          height="tall"
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
          subtitle={detail}
          title={title}
          trailing={
            <View style={styles.status}>
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
          style={styles.action}
        />
      </View>
    </SwipeableRow>
  );
});

const styles = StyleSheet.create({
  action: {
    height: sizing.listRow.trailingTarget,
    position: "absolute",
    right: 0,
    top: (sizing.listRow.tall - sizing.listRow.trailingTarget) / 2,
    width: sizing.listRow.trailingTarget,
  },
  frame: {
    position: "relative",
  },
  iconPlate: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    height: sizing.listRow.leading.rich,
    justifyContent: "center",
    width: sizing.listRow.leading.rich,
  },
  status: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.space.peer,
    paddingRight: sizing.listRow.trailingTarget,
  },
});
