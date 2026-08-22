import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Animated, {
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import {
  DraggableTab,
  TAB_ACTION_TARGET,
  TAB_GAP,
  TAB_GEOMETRY,
  TAB_STEP,
  TAB_STRIP_HEIGHT,
  type TabDragValues,
} from "@/components/workspace-detail/draggable-tab";
import { tabDestinationIndex, tabInsertionX } from "@/components/workspace-detail/tab-reorder";
import { tabAttentionSummary } from "@/data/queries/alerts";
import type { Session } from "@/data/types/domain";
import type { WorkspaceTab } from "@/data/types/layout";
import { haptics } from "@/lib/haptics";
import { useReducedMotion } from "@/lib/motion/reduced-motion";
import { borderWidth, duration, layer, opacity, spacing, tabSurfaces, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

const TAB_EDGE_SCROLL_BAND = spacing[12];
const TAB_DROP_INDICATOR_HEIGHT = spacing[7];
const TAB_SCROLL_BREATHING_ROOM = spacing[3];
const AUTO_SCROLL_MAX_POINTS_PER_SECOND = 720;
const MILLISECONDS_PER_SECOND = 1_000;

export interface TabStripProps {
  tabs: readonly WorkspaceTab[];
  sessionsById: ReadonlyMap<string, Session>;
  activeIndex: number;
  canAdd: boolean;
  addBusy?: boolean;
  onSelect: (index: number) => void;
  onActions: (tab: WorkspaceTab) => void;
  onClose: (tab: WorkspaceTab) => void;
  onReorder: (tabId: string, toIndex: number) => void;
  onAdd: () => void;
}

function announce(message: string): void {
  AccessibilityInfo.announceForAccessibility(message);
}

function beginDragFeedback(name: string, index: number, count: number): void {
  haptics.impact("medium");
  announce(`Moving ${name}, position ${index + 1} of ${count}`);
}

function indexDragFeedback(index: number, count: number): void {
  haptics.selection();
  announce(`Position ${index + 1} of ${count}`);
}

function endDragFeedback(name: string, index: number, count: number): void {
  haptics.impact("light");
  announce(`Moved ${name} to position ${index + 1} of ${count}`);
}

export function TabStrip({
  tabs,
  sessionsById,
  activeIndex,
  canAdd,
  addBusy = false,
  onSelect,
  onActions,
  onClose,
  onReorder,
  onAdd,
}: TabStripProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const scrollRef = useAnimatedRef<ComponentRef<typeof Animated.ScrollView>>();
  const stripRef = useRef<View>(null);
  const suppressPressRef = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const surfaces = theme.isDark ? tabSurfaces.dark : tabSurfaces.light;
  const activeFrom = useSharedValue(-1);
  const activeTo = useSharedValue(-1);
  const contentWidth = useSharedValue(0);
  const dragMoved = useSharedValue(false);
  const pointerAbsoluteX = useSharedValue(0);
  const pointerOffset = useSharedValue(0);
  const scrollX = useSharedValue(0);
  const stripWindowLeft = useSharedValue(0);
  const translationX = useSharedValue(0);
  const viewportWidth = useSharedValue(0);
  const dragValues = useMemo<TabDragValues>(
    () => ({
      activeFrom,
      activeTo,
      contentWidth,
      dragMoved,
      pointerAbsoluteX,
      pointerOffset,
      scrollX,
      stripWindowLeft,
      translationX,
      viewportWidth,
    }),
    [
      activeFrom,
      activeTo,
      contentWidth,
      dragMoved,
      pointerAbsoluteX,
      pointerOffset,
      scrollX,
      stripWindowLeft,
      translationX,
      viewportWidth,
    ],
  );

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollX.value = event.contentOffset.x;
  });

  const measureStrip = useCallback(
    (event: LayoutChangeEvent) => {
      viewportWidth.value = event.nativeEvent.layout.width;
      stripRef.current?.measureInWindow((x: number) => {
        stripWindowLeft.value = x;
      });
    },
    [stripWindowLeft, viewportWidth],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({
      animated: !reducedMotion,
      x: Math.max(0, activeIndex * TAB_STEP - TAB_SCROLL_BREATHING_ROOM),
    });
  }, [activeIndex, reducedMotion, scrollRef]);

  const beginDrag = useCallback((tabId: string, name: string, index: number, count: number) => {
    suppressPressRef.current = true;
    setDraggingId(tabId);
    setScrollEnabled(false);
    beginDragFeedback(name, index, count);
  }, []);

  const finishDrag = useCallback(
    (tabId: string, name: string, fromIndex: number, toIndex: number, moved: boolean) => {
      setDraggingId(null);
      setScrollEnabled(true);
      if (fromIndex !== toIndex) {
        endDragFeedback(name, toIndex, tabs.length);
        onReorder(tabId, toIndex);
      } else if (!moved) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (tab) onActions(tab);
      }
      setTimeout(() => {
        suppressPressRef.current = false;
      }, duration.instant);
    },
    [onActions, onReorder, tabs],
  );

  const cancelDrag = useCallback((name: string) => {
    setDraggingId(null);
    setScrollEnabled(true);
    announce(`Cancelled moving ${name}`);
    setTimeout(() => {
      suppressPressRef.current = false;
    }, duration.instant);
  }, []);

  useFrameCallback((frame) => {
    if (activeFrom.value < 0 || viewportWidth.value <= 0) return;
    const localPointerX = pointerAbsoluteX.value - stripWindowLeft.value;
    let speed = 0;
    if (localPointerX < TAB_EDGE_SCROLL_BAND) {
      speed =
        -AUTO_SCROLL_MAX_POINTS_PER_SECOND *
        (1 - Math.max(0, localPointerX) / TAB_EDGE_SCROLL_BAND);
    } else if (localPointerX > viewportWidth.value - TAB_EDGE_SCROLL_BAND) {
      speed =
        AUTO_SCROLL_MAX_POINTS_PER_SECOND *
        (1 - Math.max(0, viewportWidth.value - localPointerX) / TAB_EDGE_SCROLL_BAND);
    }
    if (speed === 0) return;

    const elapsed = frame.timeSincePreviousFrame ?? duration.base;
    const maxScroll = Math.max(0, contentWidth.value - viewportWidth.value);
    const nextScroll = Math.min(
      Math.max(0, scrollX.value + (speed * elapsed) / MILLISECONDS_PER_SECOND),
      maxScroll,
    );
    if (nextScroll === scrollX.value) return;

    scrollX.value = nextScroll;
    scrollTo(scrollRef, nextScroll, 0, false);
    const contentPointer = pointerAbsoluteX.value - stripWindowLeft.value + nextScroll;
    const sourceLeft = activeFrom.value * TAB_STEP;
    const translation = contentPointer - pointerOffset.value - sourceLeft;
    translationX.value = translation;
    const destination = tabDestinationIndex(
      activeFrom.value,
      translation,
      tabs.length,
      TAB_GEOMETRY,
    );
    if (destination !== activeTo.value) {
      activeTo.value = destination;
      scheduleOnRN(indexDragFeedback, destination, tabs.length);
    }
  });

  const indicatorStyle = useAnimatedStyle(() => ({
    opacity:
      activeFrom.value >= 0 && activeFrom.value !== activeTo.value
        ? opacity.opaque
        : opacity.hidden,
    transform: [
      {
        translateX: tabInsertionX(activeFrom.value, activeTo.value, TAB_GEOMETRY),
      },
    ],
  }));

  const handleSelect = (index: number) => {
    if (suppressPressRef.current) return;
    haptics.selection();
    onSelect(index);
  };

  return (
    <View
      ref={stripRef}
      style={[styles.frame, { backgroundColor: theme.colors.shell }]}
      testID="workspace-tab-strip-frame"
    >
      <Animated.ScrollView
        contentContainerStyle={styles.content}
        horizontal
        onContentSizeChange={(width) => {
          contentWidth.value = width;
        }}
        onLayout={measureStrip}
        onScroll={scrollHandler}
        ref={scrollRef}
        scrollEnabled={scrollEnabled}
        scrollEventThrottle={spacing[4]}
        showsHorizontalScrollIndicator={false}
        testID="workspace-tab-strip"
      >
        <View style={styles.tabs}>
          {tabs.map((tab, index) => (
            <DraggableTab
              active={index === activeIndex}
              attention={tabAttentionSummary(tab, sessionsById)}
              canClose={tabs.length > 1}
              dragValues={dragValues}
              dragging={draggingId === tab.id}
              index={index}
              key={tab.id}
              onAccessibleReorder={(toIndex) => onReorder(tab.id, toIndex)}
              onActions={() => onActions(tab)}
              onBeginDrag={beginDrag}
              onCancelDrag={cancelDrag}
              onClose={() => {
                haptics.impact("light");
                onClose(tab);
              }}
              onFinishDrag={finishDrag}
              onIndexChange={indexDragFeedback}
              onSelect={() => handleSelect(index)}
              reducedMotion={reducedMotion}
              surfaces={surfaces}
              tab={tab}
              tabCount={tabs.length}
            />
          ))}
          <Animated.View
            pointerEvents="none"
            style={[styles.dropIndicator, { backgroundColor: theme.colors.ring }, indicatorStyle]}
            testID="tab-drop-indicator"
          />
        </View>
        <Pressable
          accessibilityHint={canAdd ? undefined : "A workspace can have up to 8 tabs"}
          accessibilityLabel="New tab"
          accessibilityRole="button"
          accessibilityState={{ busy: addBusy, disabled: !canAdd || addBusy }}
          disabled={!canAdd || addBusy}
          onPress={() => {
            haptics.impact("light");
            onAdd();
          }}
          style={({ pressed }) => [
            styles.addButton,
            {
              backgroundColor: pressed ? theme.colors.accent : "transparent",
              borderRadius: theme.radii.md,
              opacity: !canAdd || addBusy ? opacity.disabled : opacity.opaque,
            },
          ]}
          testID="add-tab-button"
        >
          {addBusy ? <Spinner size={spacing[4]} /> : <Icon name="Plus" size={spacing[4]} />}
        </Pressable>
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  addButton: {
    alignItems: "center",
    height: TAB_ACTION_TARGET,
    justifyContent: "center",
    marginBottom: sizing.tab.connectionOverlap,
    width: TAB_ACTION_TARGET,
  },
  content: {
    alignItems: "flex-end",
    gap: TAB_GAP,
    minHeight: TAB_STRIP_HEIGHT,
    paddingLeft: sizing.tab.connectionRadius,
    paddingRight: TAB_GAP,
  },
  dropIndicator: {
    borderRadius: borderWidth.hairline,
    height: TAB_DROP_INDICATOR_HEIGHT,
    left: 0,
    position: "absolute",
    top: (sizing.tab.visualHeight - TAB_DROP_INDICATOR_HEIGHT) / 2,
    width: borderWidth.emphasis,
    zIndex: layer.launcherDropPreview,
  },
  frame: {
    flexShrink: 0,
    height: TAB_STRIP_HEIGHT,
    marginBottom: -sizing.tab.connectionOverlap,
    zIndex: layer.mobileChrome,
  },
  tabs: {
    flexDirection: "row",
    gap: TAB_GAP,
    position: "relative",
  },
});
