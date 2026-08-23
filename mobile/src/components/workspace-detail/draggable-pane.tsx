import type { ReactNode } from "react";
import { useCallback, useMemo, useRef } from "react";
import { StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import type { PaneDragValues } from "@/components/workspace-detail/pane-drag";
import { duration, opacity } from "@/theme";

export interface DraggablePaneProps {
  children: ReactNode;
  drag: PaneDragValues;
  /** False while another pane is being carried. */
  enabled: boolean;
  /** True for the pane being carried: its row stays behind as a shadow of itself. */
  lifted: boolean;
  onBegin: () => void;
  /** The tab index the finger let go over, or -1 for nowhere. */
  onDrop: (tabIndex: number) => void;
}

/**
 * A pane row that can be picked up and carried to another tab.
 *
 * Holding lifts it — the row dims where it sits and a ghost follows the finger
 * (`pane-drag-ghost`) — and the tab it is released over takes it. Only the
 * pointer position crosses to the UI thread; the strip works out which tab that
 * is (`pane-drag.ts`), so the two never have to measure each other.
 *
 * The callbacks are held in a ref rather than closed over: the list re-renders
 * the moment a pane is lifted, and rebuilding the gesture object under a
 * gesture that has already started drops it.
 */
export function DraggablePane({
  children,
  drag,
  enabled,
  lifted,
  onBegin,
  onDrop,
}: DraggablePaneProps): React.JSX.Element {
  const handlers = useRef({ onBegin, onDrop });
  handlers.current = { onBegin, onDrop };
  const begin = useCallback(() => handlers.current.onBegin(), []);
  const drop = useCallback((tabIndex: number) => handlers.current.onDrop(tabIndex), []);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activateAfterLongPress(duration.overlay)
        .maxPointers(1)
        .onStart((event) => {
          drag.active.value = 1;
          drag.hovered.value = -1;
          drag.pointerX.value = event.absoluteX;
          drag.pointerY.value = event.absoluteY;
          scheduleOnRN(begin);
        })
        .onUpdate((event) => {
          drag.pointerX.value = event.absoluteX;
          drag.pointerY.value = event.absoluteY;
        })
        .onEnd(() => {
          const target = drag.hovered.value;
          drag.active.value = 0;
          drag.hovered.value = -1;
          scheduleOnRN(drop, target);
        })
        .onFinalize((_event, success) => {
          // A press that never became a drag has nothing to put down.
          if (success || drag.active.value !== 1) return;
          drag.active.value = 0;
          drag.hovered.value = -1;
          scheduleOnRN(drop, -1);
        }),
    [begin, drag, drop, enabled],
  );

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={lifted ? styles.lifted : undefined}>{children}</Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  lifted: {
    opacity: opacity.disabled,
  },
});
