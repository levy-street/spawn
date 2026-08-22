import { memo, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { type SwipeAction, SwipeableRow } from "@/components/gestures/swipeable-row";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, chrome, opacity, useTheme } from "@/theme";

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
      contentStyle={{ backgroundColor: theme.colors.card }}
      leadingActions={leadingActions}
      style={{ borderRadius: theme.radii.lg }}
      testID={`files-swipe-${paneId}`}
      trailingActions={trailingActions}
    >
      <Pressable
        accessibilityActions={[{ name: "activate" }, { name: "longpress", label: "Show actions" }]}
        accessibilityLabel={`${title}, ${status}`}
        accessibilityRole="button"
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "longpress") onActions();
          else if (event.nativeEvent.actionName === "activate") onOpen();
        }}
        onLongPress={() => {
          haptics.impact("medium");
          onActions();
        }}
        onPress={() => {
          haptics.selection();
          onOpen();
        }}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: pressed ? theme.colors.accent : theme.colors.card,
            borderColor: theme.colors.border,
            borderRadius: theme.radii.lg,
            borderWidth: borderWidth.hairline,
            gap: theme.space(3),
            minHeight: theme.space(18),
            opacity: pressed ? opacity.hoverButton : opacity.opaque,
            paddingHorizontal: theme.space(3),
            paddingVertical: theme.space(2.5),
          },
        ]}
        testID={`files-row-${paneId}`}
      >
        <View
          style={[
            styles.iconPlate,
            {
              backgroundColor: theme.colors.muted,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.lg,
              borderWidth: borderWidth.hairline,
              height: theme.space(8),
              width: theme.space(8),
            },
          ]}
        >
          <Icon color="mutedForeground" name="FolderTree" size={theme.space(4.5)} />
        </View>
        <View style={styles.copy}>
          <Text numberOfLines={1} variant="label" weight="semibold">
            {title}
          </Text>
          <Text color="mutedForeground" numberOfLines={1} variant="caption">
            {detail}
          </Text>
        </View>
        <View style={styles.trailing}>
          <View style={[styles.status, { gap: theme.space(1.5) }]}>
            <StatusDot pulse={false} tone={hostOnline ? "active" : "offline"} />
            <Text color="mutedForeground" variant="caption">
              {status}
            </Text>
          </View>
          <Icon color="mutedForeground" name="Ellipsis" size={theme.space(4)} />
        </View>
      </Pressable>
    </SwipeableRow>
  );
});

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    minWidth: 0,
  },
  iconPlate: {
    alignItems: "center",
    flexShrink: 0,
    justifyContent: "center",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: chrome.touchTarget,
  },
  status: {
    alignItems: "center",
    flexDirection: "row",
  },
  trailing: {
    alignItems: "flex-end",
    alignSelf: "stretch",
    justifyContent: "space-between",
    maxWidth: "34%",
  },
});
