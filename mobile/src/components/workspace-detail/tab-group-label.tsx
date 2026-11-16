import { Pressable, StyleSheet, View } from "react-native";

import { attentionAccessibilityLabel } from "@/components/alerts/attention-badge";
import { Text } from "@/components/ui/text";
import { labelTextColor } from "@/data/color";
import { groupLabel } from "@/data/layout/tab-groups";
import type { AttentionSummary } from "@/data/queries/alerts";
import type { TabGroup } from "@/data/types/layout";
import { borderWidth, opacity, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface TabGroupLabelProps {
  group: TabGroup;
  /** The group's colour as drawn: a preset already resolved against the theme. */
  color: string;
  width: number;
  /** How many of the group's tabs a collapse is hiding. */
  hiddenCount: number;
  /** What the hidden tabs need, which a collapsed label carries as a dot. */
  attention: AttentionSummary | null;
  onToggle: () => void;
  onManage: () => void;
}

export function groupAccessibilityLabel(
  group: TabGroup,
  attention: AttentionSummary | null = null,
): string {
  const count = group.tab_ids.length;
  const base = `${groupLabel(group)}, tab group, ${count} ${count === 1 ? "tab" : "tabs"}`;
  return attention ? `${base}, ${attentionAccessibilityLabel(attention)}` : base;
}

/**
 * A group's label in the tab strip: a chip in the group's colour before its
 * first tab. Tapping it collapses or expands the group; holding it opens the
 * group's sheet. Collapsed, it counts what it hides (`+N`) and wears a dot
 * while any hidden tab needs attention, since that tab's own badge is gone.
 */
export function TabGroupLabel({
  group,
  color,
  width,
  hiddenCount,
  attention,
  onToggle,
  onManage,
}: TabGroupLabelProps) {
  const theme = useTheme();
  const ink = labelTextColor(color);
  const showCount = group.collapsed && hiddenCount > 0;
  const dotColor = attention?.highest === "dead" ? theme.colors.destructive : theme.colors.warning;

  return (
    <Pressable
      accessibilityActions={[
        group.collapsed
          ? { name: "expand", label: "Expand group" }
          : { name: "collapse", label: "Collapse group" },
        { name: "edit", label: "Manage tab group" },
      ]}
      accessibilityLabel={groupAccessibilityLabel(group, showCount ? attention : null)}
      accessibilityRole="button"
      accessibilityState={{ expanded: !group.collapsed }}
      onAccessibilityAction={(event) => {
        switch (event.nativeEvent.actionName) {
          case "expand":
          case "collapse":
          case "activate":
            onToggle();
            break;
          case "edit":
          case "longpress":
            onManage();
            break;
        }
      }}
      onLongPress={onManage}
      onPress={onToggle}
      style={[styles.slot, { width }]}
      testID={`tab-group-label-${group.id}`}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.chip,
            {
              backgroundColor: color,
              borderRadius: theme.radii.md,
              opacity: pressed ? opacity.pressedContent : opacity.opaque,
            },
          ]}
          testID={`tab-group-chip-${group.id}`}
        >
          {group.name ? (
            <Text
              numberOfLines={1}
              style={[styles.name, { color: ink }]}
              variant="caption"
              weight="semibold"
            >
              {group.name}
            </Text>
          ) : null}
          {showCount ? (
            <Text
              style={[styles.count, { color: ink }]}
              testID={`tab-group-count-${group.id}`}
              variant="caption"
              weight="semibold"
            >
              {`+${hiddenCount}`}
            </Text>
          ) : null}
          {showCount && attention ? (
            <View
              style={[
                styles.attention,
                {
                  backgroundColor: dotColor,
                  borderColor: theme.colors.shell,
                  borderRadius: theme.radii.pill,
                },
              ]}
              testID={`tab-group-attention-${group.id}`}
            />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  attention: {
    borderWidth: borderWidth.emphasis,
    height: sizing.tab.groupAttentionDot + borderWidth.emphasis * 2,
    position: "absolute",
    right: -borderWidth.emphasis * 2,
    top: -borderWidth.emphasis * 2,
    width: sizing.tab.groupAttentionDot + borderWidth.emphasis * 2,
  },
  chip: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.space.tight,
    height: sizing.tab.groupLabelHeight,
    justifyContent: "center",
    paddingHorizontal: sizing.tab.groupLabelPadding,
    position: "relative",
    width: "100%",
  },
  count: {
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  name: {
    flexShrink: 1,
  },
  slot: {
    alignItems: "center",
    height: sizing.tab.visualHeight,
    justifyContent: "center",
    marginBottom: sizing.tab.connectionOverlap,
  },
});
