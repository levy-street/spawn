import { useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { type SwipeAction, SwipeableRow } from "@/components/gestures/swipeable-row";
import { Icon } from "@/components/ui/icon";
import { ListRow } from "@/components/ui/list-row";
import { Menu, type MenuEntry } from "@/components/ui/menu";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { WorkspaceIcon } from "@/components/workspaces/workspace-icon";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import type { WorkspaceStats } from "@/data/types/domain";
import { haptics } from "@/lib/haptics";
import { opacity } from "@/theme";
import { sizing } from "@/theme/sizing";

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
        icon: <Icon color="popoverForeground" name="Pencil" size={sizing.control.icon} />,
        disabled: busy,
        onPress: onRename,
      },
      {
        id: "icon",
        label: iconLabel,
        icon: <Icon color="popoverForeground" name="ImagePlus" size={sizing.control.icon} />,
        disabled: busy,
        onPress: onChangeIcon,
      },
      {
        id: "duplicate",
        label: duplicateLabel,
        icon: <Icon color="popoverForeground" name="Copy" size={sizing.control.icon} />,
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
            size={sizing.control.icon}
          />
        ),
        disabled: busy,
        onPress: archived ? onUnarchive : onArchive,
      },
      { id: "destructive-separator", type: "separator" },
      {
        id: "delete",
        label: deleteLabel,
        icon: <Icon color="destructive" name="Trash2" size={sizing.control.icon} />,
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
        icon: <Icon color="foreground" name="Pencil" size={sizing.control.icon} />,
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
          <Icon
            color="foreground"
            name={archived ? "RotateCcw" : "Archive"}
            size={sizing.control.icon}
          />
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
        <View
          pointerEvents={busy ? "none" : "auto"}
          style={[
            styles.rowContainer,
            {
              opacity: busy ? opacity.disabled : opacity.opaque,
            },
          ]}
          testID={`workspace-row-touch-${workspace.id}`}
        >
          <ListRow
            {...(busy
              ? {}
              : {
                  onLongPress: () => {
                    haptics.impact("medium");
                    setMenuVisible(true);
                  },
                  onPress: onOpen,
                })}
            height="tall"
            leading={
              <WorkspaceIcon
                icon={workspace.icon}
                name={workspace.name}
                size={sizing.listRow.leading.workspace}
              />
            }
            subtitle={rollup}
            shape="fullBleed"
            title={workspace.name}
            trailing={
              <View style={styles.trailing}>
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
                  hitSlop={sizing.space.tight}
                  onPress={(event) => {
                    event.stopPropagation();
                    setMenuVisible(true);
                  }}
                  style={({ pressed }) => [
                    styles.more,
                    // A tinted plate appearing under a bare glyph reads as a stray
                    // box, so the press dims the glyph the way every icon button does.
                    { opacity: pressed ? opacity.pressedContent : opacity.opaque },
                  ]}
                >
                  <Icon color="mutedForeground" name="MoreHorizontal" size={sizing.control.icon} />
                </Pressable>
              </View>
            }
          />
        </View>
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
    gap: sizing.space.tight,
  },
  more: {
    alignItems: "center",
    height: sizing.listRow.trailingTarget,
    justifyContent: "center",
    // Pulled out of the row's gutter so the glyph sits where a row's trailing
    // control belongs — near the edge — rather than a full gutter inside it.
    marginRight: -(sizing.listRow.horizontalPadding - sizing.listRow.trailingActionInset),
    width: sizing.listRow.trailingTarget,
  },
  rowContainer: {
    width: "100%",
  },
  trailing: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.space.peer,
  },
});
