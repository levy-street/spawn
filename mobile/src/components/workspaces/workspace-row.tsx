import { useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { type SwipeAction, SwipeableRow } from "@/components/gestures/swipeable-row";
import { Icon } from "@/components/ui/icon";
import { Menu, type MenuEntry } from "@/components/ui/menu";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { WorkspaceIcon } from "@/components/workspaces/workspace-icon";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import type { WorkspaceStats } from "@/data/types/domain";
import { borderWidth, chrome, opacity, spacing, useTheme } from "@/theme";

export interface WorkspaceRowProps {
  workspace: WorkspaceOut;
  stats: WorkspaceStats;
  busy?: boolean;
  onOpen: () => void;
  onRename: () => void;
  onChangeIcon: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}

export function workspaceRollupLabel(stats: WorkspaceStats): string {
  const tabs = `${stats.tabs} ${stats.tabs === 1 ? "tab" : "tabs"}`;
  const running = `${stats.running} running`;
  const attention = stats.attention > 0 ? ` · ${stats.attention} need attention` : "";
  return `${tabs} · ${running}${attention}`;
}

export function workspaceActionLabels(
  archived: boolean,
): readonly [string, string, string, string, string] {
  return ["Rename", "Change icon", "Duplicate", archived ? "Restore" : "Archive", "Delete"];
}

export function WorkspaceRow({
  workspace,
  stats,
  busy = false,
  onOpen,
  onRename,
  onChangeIcon,
  onDuplicate,
  onArchive,
  onUnarchive,
  onDelete,
}: WorkspaceRowProps) {
  const theme = useTheme();
  const anchorRef = useRef<View>(null);
  const [menuVisible, setMenuVisible] = useState(false);
  const archived = workspace.archived_at !== null;
  const rollup = workspaceRollupLabel(stats);
  const [renameLabel, iconLabel, duplicateLabel, lifecycleLabel, deleteLabel] =
    workspaceActionLabels(archived);

  const entries = useMemo<MenuEntry[]>(
    () => [
      {
        id: "rename",
        label: renameLabel,
        icon: <Icon color="popoverForeground" name="Pencil" size={spacing[4]} />,
        disabled: busy,
        onPress: onRename,
      },
      {
        id: "icon",
        label: iconLabel,
        icon: <Icon color="popoverForeground" name="ImagePlus" size={spacing[4]} />,
        disabled: busy,
        onPress: onChangeIcon,
      },
      {
        id: "duplicate",
        label: duplicateLabel,
        icon: <Icon color="popoverForeground" name="Copy" size={spacing[4]} />,
        disabled: busy,
        onPress: onDuplicate,
      },
      {
        id: archived ? "restore" : "archive",
        label: lifecycleLabel,
        icon: (
          <Icon
            color="popoverForeground"
            name={archived ? "RotateCcw" : "Archive"}
            size={spacing[4]}
          />
        ),
        disabled: busy,
        onPress: archived ? onUnarchive : onArchive,
      },
      { id: "destructive-separator", type: "separator" },
      {
        id: "delete",
        label: deleteLabel,
        icon: <Icon color="destructive" name="Trash2" size={spacing[4]} />,
        destructive: true,
        disabled: busy,
        onPress: onDelete,
      },
    ],
    [
      archived,
      busy,
      deleteLabel,
      duplicateLabel,
      iconLabel,
      lifecycleLabel,
      onArchive,
      onChangeIcon,
      onDelete,
      onDuplicate,
      onRename,
      onUnarchive,
      renameLabel,
    ],
  );

  const leadingActions = useMemo<SwipeAction[]>(
    () => [
      {
        key: "rename",
        label: renameLabel,
        icon: <Icon color="foreground" name="Pencil" size={spacing[4]} />,
        onPress: onRename,
      },
    ],
    [onRename, renameLabel],
  );
  const trailingActions = useMemo<SwipeAction[]>(
    () => [
      {
        key: archived ? "restore" : "archive",
        label: lifecycleLabel,
        icon: (
          <Icon color="foreground" name={archived ? "RotateCcw" : "Archive"} size={spacing[4]} />
        ),
        onPress: archived ? onUnarchive : onArchive,
      },
    ],
    [archived, lifecycleLabel, onArchive, onUnarchive],
  );

  return (
    <View ref={anchorRef}>
      <SwipeableRow
        leadingActions={busy ? [] : leadingActions}
        trailingActions={busy ? [] : trailingActions}
        testID={`workspace-row-${workspace.id}`}
      >
        <Pressable
          accessibilityLabel={`${workspace.name}. ${rollup}`}
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: busy }}
          disabled={busy}
          onLongPress={() => setMenuVisible(true)}
          onPress={onOpen}
          style={({ pressed }) => [
            styles.row,
            {
              backgroundColor: pressed ? theme.colors.accent : theme.colors.background,
              borderBottomColor: theme.colors.border,
              opacity: busy ? opacity.disabled : opacity.opaque,
            },
          ]}
        >
          <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={spacing[11]} />
          <View style={styles.copy}>
            <Text numberOfLines={1} variant="title">
              {workspace.name}
            </Text>
            <Text color="mutedForeground" numberOfLines={1} variant="caption">
              {rollup}
            </Text>
          </View>
          {stats.attention > 0 ? (
            <View style={styles.attention}>
              <StatusDot
                accessibilityLabel={`${stats.attention} need attention`}
                pulse={false}
                tone="waiting"
              />
              <Text color="mutedForeground" variant="micro">
                {stats.attention}
              </Text>
            </View>
          ) : null}
          <Pressable
            accessibilityLabel={`${workspace.name} actions`}
            accessibilityRole="button"
            disabled={busy}
            onPress={(event) => {
              event.stopPropagation();
              setMenuVisible(true);
            }}
            style={({ pressed }) => [
              styles.more,
              {
                backgroundColor: pressed ? theme.colors.accent : "transparent",
                borderRadius: theme.radii.md,
              },
            ]}
          >
            <Icon color="mutedForeground" name="MoreHorizontal" size={spacing[4]} />
          </Pressable>
          <Icon color="mutedForeground" name="ChevronRight" size={spacing[4]} />
        </Pressable>
      </SwipeableRow>
      <Menu
        accessibilityLabel={`${workspace.name} actions`}
        align="end"
        anchorRef={anchorRef}
        entries={entries}
        onDismiss={() => setMenuVisible(false)}
        visible={menuVisible}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  attention: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[1],
  },
  copy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
  more: {
    alignItems: "center",
    height: chrome.touchTarget,
    justifyContent: "center",
    width: chrome.touchTarget,
  },
  row: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    minHeight: spacing[16] + spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
});
