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
import { haptics } from "@/lib/haptics";
import { chrome, opacity, spacing, useTheme } from "@/theme";

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
          onLongPress={() => {
            haptics.impact("medium");
            setMenuVisible(true);
          }}
          onPress={onOpen}
          style={[
            styles.touchRow,
            {
              opacity: busy ? opacity.disabled : opacity.opaque,
            },
          ]}
          testID={`workspace-row-touch-${workspace.id}`}
        >
          {({ pressed }) => (
            <View
              style={[
                styles.visualRow,
                {
                  backgroundColor: pressed ? theme.colors.accent : theme.colors.background,
                  borderRadius: theme.radii.lg,
                },
              ]}
              testID={`workspace-row-visual-${workspace.id}`}
            >
              <View style={styles.iconSlot}>
                <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={spacing[6]} />
              </View>
              <View style={styles.copy}>
                <Text numberOfLines={1} variant="label">
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
                hitSlop={spacing[1]}
                onPress={(event) => {
                  event.stopPropagation();
                  setMenuVisible(true);
                }}
                style={({ pressed: actionsPressed }) => [
                  styles.more,
                  {
                    backgroundColor: actionsPressed ? theme.colors.accent : "transparent",
                    borderRadius: theme.radii.md,
                  },
                ]}
              >
                <Icon color="mutedForeground" name="MoreHorizontal" size={spacing[4]} />
              </Pressable>
            </View>
          )}
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
    minWidth: 0,
  },
  iconSlot: {
    alignItems: "center",
    height: spacing[9],
    justifyContent: "center",
    width: spacing[9],
  },
  more: {
    alignItems: "center",
    height: spacing[9],
    justifyContent: "center",
    width: spacing[9],
  },
  touchRow: {
    height: chrome.touchTarget,
    justifyContent: "center",
  },
  visualRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    height: chrome.rowHeight,
    paddingRight: spacing[1],
  },
});
