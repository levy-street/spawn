import { StyleSheet } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";

import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import type { PaneDragValues } from "@/components/workspace-detail/pane-drag";
import type { AgentIdentity } from "@/data/types/domain";
import { borderWidth, layer, opacity, shadow, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

const GHOST_WIDTH = 220;
const GHOST_ICON = 24;

export interface PaneDragGhostProps {
  drag: PaneDragValues;
  /** Null when nothing is being carried; the ghost stays mounted and hidden. */
  pane: { title: string; identity: AgentIdentity } | null;
  /** Window position of the container the ghost is positioned inside. */
  originX: number;
  originY: number;
}

/**
 * The pane under the finger while it is carried to another tab.
 *
 * It has to be a separate floating thing rather than the row moving: the row is
 * clipped inside the pager, and the strip it is being carried to sits above
 * that. Positioned in the workspace screen's own space, so the window
 * coordinates the gesture reports are shifted by the screen's origin.
 */
export function PaneDragGhost({
  drag,
  pane,
  originX,
  originY,
}: PaneDragGhostProps): React.JSX.Element {
  const theme = useTheme();
  const style = useAnimatedStyle(() => ({
    opacity: drag.active.value,
    transform: [
      { translateX: drag.pointerX.value - originX - GHOST_WIDTH / 2 },
      { translateY: drag.pointerY.value - originY - sizing.listRow.pane / 2 },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ghost,
        {
          backgroundColor: theme.colors.popover,
          borderColor: theme.colors.ring,
          borderRadius: theme.radii.lg,
          boxShadow: shadow.xxl,
        },
        style,
      ]}
      testID="pane-drag-ghost"
    >
      {pane ? (
        <>
          <AgentIcon identity={pane.identity} size={GHOST_ICON} />
          <Text numberOfLines={1} style={styles.label} variant="label">
            {pane.title}
          </Text>
        </>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ghost: {
    alignItems: "center",
    borderWidth: borderWidth.emphasis,
    flexDirection: "row",
    gap: spacing[3],
    left: 0,
    minHeight: sizing.listRow.pane,
    opacity: opacity.hidden,
    paddingHorizontal: spacing[3],
    position: "absolute",
    top: 0,
    width: GHOST_WIDTH,
    zIndex: layer.launcherDragGhost,
  },
  label: { flex: 1 },
});
