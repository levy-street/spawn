import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { type SharedValue, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { attentionAccessibilityLabel } from "@/components/alerts/attention-badge";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { TabAttentionBadge } from "@/components/workspace-detail/tab-attention-badge";
import { tabDestinationIndex } from "@/components/workspace-detail/tab-reorder";
import type { AttentionSummary } from "@/data/queries/alerts";
import type { WorkspaceTab } from "@/data/types/layout";
import { duration, layer, shadow, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export const TAB_WIDTH = sizing.tab.minWidth;
export const TAB_GAP = sizing.tab.itemGap;
export const TAB_STEP = TAB_WIDTH + TAB_GAP;
export const TAB_STRIP_HEIGHT = sizing.tab.stripHeight;
const TAB_VISUAL_HEIGHT = sizing.tab.visualHeight;
export const TAB_CONNECTED_HEIGHT = TAB_VISUAL_HEIGHT + sizing.tab.connectionOverlap;
export const TAB_ACTION_TARGET = sizing.tab.actionTarget;
const TAB_PICKUP_SCALE = 1.02;
export const TAB_GEOMETRY = { tabGap: TAB_GAP, tabWidth: TAB_WIDTH } as const;

export interface TabDragValues {
  activeFrom: SharedValue<number>;
  activeTo: SharedValue<number>;
  contentWidth: SharedValue<number>;
  dragMoved: SharedValue<boolean>;
  pointerAbsoluteX: SharedValue<number>;
  pointerOffset: SharedValue<number>;
  scrollX: SharedValue<number>;
  stripWindowLeft: SharedValue<number>;
  translationX: SharedValue<number>;
  viewportWidth: SharedValue<number>;
}

interface DraggableTabProps {
  active: boolean;
  attention: AttentionSummary | null;
  canClose: boolean;
  dragValues: TabDragValues;
  dragging: boolean;
  index: number;
  onAccessibleReorder: (toIndex: number) => void;
  onActions: () => void;
  onBeginDrag: (tabId: string, name: string, index: number, count: number) => void;
  onCancelDrag: (name: string) => void;
  onClose: () => void;
  onFinishDrag: (
    tabId: string,
    name: string,
    fromIndex: number,
    toIndex: number,
    moved: boolean,
  ) => void;
  onIndexChange: (index: number, count: number) => void;
  onSelect: () => void;
  reducedMotion: boolean;
  surfaces: { empty: string; focused: string; dimmed: string };
  tab: WorkspaceTab;
  tabCount: number;
}

export function DraggableTab({
  active,
  attention,
  canClose,
  dragValues,
  dragging,
  index,
  onAccessibleReorder,
  onActions,
  onBeginDrag,
  onCancelDrag,
  onClose,
  onFinishDrag,
  onIndexChange,
  onSelect,
  reducedMotion,
  surfaces,
  tab,
  tabCount,
}: DraggableTabProps) {
  const theme = useTheme();
  const connected = active && tab.layout.tiles.length > 0;
  const dragEnabled = tabCount > 1;
  const tabAccessibilityLabel = attention
    ? `${tab.name}, ${attentionAccessibilityLabel(attention)}`
    : tab.name;

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(dragEnabled)
        .activateAfterLongPress(duration.overlay)
        .maxPointers(1)
        .hitSlop({ right: -TAB_ACTION_TARGET })
        .onStart((event) => {
          dragValues.activeFrom.value = index;
          dragValues.activeTo.value = index;
          dragValues.dragMoved.value = false;
          dragValues.pointerAbsoluteX.value = event.absoluteX;
          const contentPointer =
            event.absoluteX - dragValues.stripWindowLeft.value + dragValues.scrollX.value;
          dragValues.pointerOffset.value = contentPointer - index * TAB_STEP;
          dragValues.translationX.value = 0;
          scheduleOnRN(onBeginDrag, tab.id, tab.name, index, tabCount);
        })
        .onUpdate((event) => {
          dragValues.pointerAbsoluteX.value = event.absoluteX;
          const contentPointer =
            event.absoluteX - dragValues.stripWindowLeft.value + dragValues.scrollX.value;
          const sourceLeft = index * TAB_STEP;
          const translation = contentPointer - dragValues.pointerOffset.value - sourceLeft;
          dragValues.translationX.value = translation;
          if (Math.abs(translation) >= spacing[1]) dragValues.dragMoved.value = true;
          const destination = tabDestinationIndex(index, translation, tabCount, TAB_GEOMETRY);
          if (destination !== dragValues.activeTo.value) {
            dragValues.activeTo.value = destination;
            scheduleOnRN(onIndexChange, destination, tabCount);
          }
        })
        .onEnd(() => {
          const destination = dragValues.activeTo.value;
          const moved = dragValues.dragMoved.value;
          dragValues.activeFrom.value = -1;
          dragValues.activeTo.value = -1;
          dragValues.translationX.value = 0;
          scheduleOnRN(onFinishDrag, tab.id, tab.name, index, destination, moved);
        })
        .onFinalize((_event, success) => {
          if (success || dragValues.activeFrom.value !== index) return;
          dragValues.activeFrom.value = -1;
          dragValues.activeTo.value = -1;
          dragValues.translationX.value = 0;
          scheduleOnRN(onCancelDrag, tab.name);
        }),
    [
      dragEnabled,
      dragValues,
      index,
      onBeginDrag,
      onCancelDrag,
      onFinishDrag,
      onIndexChange,
      tab.id,
      tab.name,
      tabCount,
    ],
  );

  const animatedStyle = useAnimatedStyle(() => {
    const from = dragValues.activeFrom.value;
    const to = dragValues.activeTo.value;
    let siblingTranslation = 0;
    if (from >= 0 && index !== from) {
      if (from < to && index > from && index <= to) siblingTranslation = -TAB_STEP;
      if (from > to && index >= to && index < from) siblingTranslation = TAB_STEP;
    }
    const translateX =
      index === from
        ? dragValues.translationX.value
        : reducedMotion
          ? siblingTranslation
          : withTiming(siblingTranslation, {
              duration: duration.base,
              easing: theme.motion.easing.out,
            });
    const scale =
      index === from && !reducedMotion
        ? withTiming(TAB_PICKUP_SCALE, {
            duration: duration.medium,
            easing: theme.motion.easing.out,
          })
        : 1;
    return {
      transform: [{ translateX }, { scale }],
      zIndex: index === from ? layer.launcherDragGhost : layer.base,
    };
  });

  return (
    <Animated.View
      style={[
        styles.tabSlot,
        connected ? undefined : styles.restingSlot,
        dragging ? styles.dragging : undefined,
        animatedStyle,
      ]}
      testID={`workspace-tab-${tab.id}`}
    >
      {connected ? (
        <>
          <View
            pointerEvents="none"
            style={[
              styles.connection,
              styles.connectionLeft,
              { backgroundColor: surfaces.focused },
            ]}
            testID={`tab-connection-left-${tab.id}`}
          >
            <View
              style={[
                styles.connectionCutout,
                styles.connectionCutoutLeft,
                { backgroundColor: theme.colors.shell },
              ]}
            />
          </View>
          <View
            pointerEvents="none"
            style={[
              styles.connection,
              styles.connectionRight,
              { backgroundColor: surfaces.focused },
            ]}
            testID={`tab-connection-right-${tab.id}`}
          >
            <View
              style={[
                styles.connectionCutout,
                styles.connectionCutoutRight,
                { backgroundColor: theme.colors.shell },
              ]}
            />
          </View>
        </>
      ) : null}
      <GestureDetector gesture={gesture}>
        <Pressable
          accessibilityActions={[
            { name: "activate", label: "Select tab" },
            { name: "showActions", label: "Show tab actions" },
            { name: "decrement", label: "Move left" },
            { name: "increment", label: "Move right" },
          ]}
          accessibilityHint="Long press, then drag to reorder"
          accessibilityLabel={tabAccessibilityLabel}
          accessibilityRole="tab"
          accessibilityState={{ selected: active }}
          onAccessibilityAction={(event) => {
            switch (event.nativeEvent.actionName) {
              case "activate":
                onSelect();
                break;
              case "showActions":
                onActions();
                break;
              case "decrement":
                if (index > 0) {
                  onIndexChange(index - 1, tabCount);
                  onAccessibleReorder(index - 1);
                }
                break;
              case "increment":
                if (index < tabCount - 1) {
                  onIndexChange(index + 1, tabCount);
                  onAccessibleReorder(index + 1);
                }
                break;
            }
          }}
          onLongPress={dragEnabled ? undefined : onActions}
          onPress={onSelect}
          style={({ pressed }) => [
            styles.tabSurface,
            connected ? styles.connectedTab : styles.restingTab,
            {
              backgroundColor: pressed
                ? theme.colors.accent
                : active
                  ? connected
                    ? surfaces.focused
                    : surfaces.empty
                  : surfaces.dimmed,
              borderBottomLeftRadius: connected ? 0 : theme.radii.md,
              borderBottomRightRadius: connected ? 0 : theme.radii.md,
              borderTopLeftRadius: theme.radii.md,
              borderTopRightRadius: theme.radii.md,
              paddingLeft: sizing.tab.horizontalPadding,
              paddingRight: canClose ? TAB_ACTION_TARGET : sizing.tab.horizontalPadding,
            },
          ]}
          testID={`workspace-tab-surface-${tab.id}`}
        >
          <TabAttentionBadge summary={attention} testID={`tab-attention-${tab.id}`} />
          <Text
            color={active ? "foreground" : "mutedForeground"}
            numberOfLines={1}
            style={styles.tabLabel}
            variant="label"
            weight="medium"
          >
            {tab.name}
          </Text>
        </Pressable>
      </GestureDetector>
      {canClose ? (
        <Pressable
          accessibilityLabel={`Close ${tab.name}`}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.closeButton}
          testID={`close-tab-${tab.id}`}
        >
          {({ pressed }) => (
            <View
              style={[
                styles.closePlate,
                {
                  backgroundColor: pressed ? theme.colors.accent : "transparent",
                  borderRadius: theme.radii.sm,
                },
              ]}
              testID={`close-tab-plate-${tab.id}`}
            >
              <Icon color="mutedForeground" name="X" size={sizing.tab.closeGlyph} />
            </View>
          )}
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  closeButton: {
    alignItems: "center",
    height: TAB_ACTION_TARGET,
    justifyContent: "center",
    position: "absolute",
    right: 0,
    top: 0,
    width: TAB_ACTION_TARGET,
    zIndex: layer.mobileChrome,
  },
  closePlate: {
    alignItems: "center",
    height: sizing.tab.closePlate,
    justifyContent: "center",
    width: sizing.tab.closePlate,
  },
  connection: {
    bottom: 0,
    height: sizing.tab.connectionRadius,
    overflow: "hidden",
    position: "absolute",
    width: sizing.tab.connectionRadius,
  },
  connectionCutout: {
    borderRadius: sizing.tab.connectionRadius,
    height: sizing.tab.connectionRadius * 2,
    position: "absolute",
    top: -sizing.tab.connectionRadius,
    width: sizing.tab.connectionRadius * 2,
  },
  connectionCutoutLeft: {
    left: -sizing.tab.connectionRadius,
  },
  connectionCutoutRight: {
    right: -sizing.tab.connectionRadius,
  },
  connectionLeft: {
    left: -sizing.tab.connectionRadius,
  },
  connectionRight: {
    right: -sizing.tab.connectionRadius,
  },
  connectedTab: {
    height: TAB_CONNECTED_HEIGHT,
    paddingBottom: sizing.tab.connectionOverlap,
  },
  dragging: {
    boxShadow: shadow.sm,
  },
  restingTab: {
    height: TAB_VISUAL_HEIGHT,
  },
  restingSlot: {
    paddingBottom: sizing.tab.connectionOverlap,
  },
  tabLabel: {
    flex: 1,
    textAlignVertical: "center",
  },
  tabSlot: {
    height: TAB_CONNECTED_HEIGHT,
    justifyContent: "flex-end",
    position: "relative",
    width: TAB_WIDTH,
  },
  tabSurface: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.tab.labelGap,
    width: TAB_WIDTH,
  },
});
