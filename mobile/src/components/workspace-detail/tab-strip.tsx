import { useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import type { WorkspaceTab } from "@/data/types/layout";
import { haptics } from "@/lib/haptics";
import { useReducedMotion } from "@/lib/motion/reduced-motion";
import { borderWidth, chrome, opacity, spacing, tabSurfaces, useTheme } from "@/theme";

const TAB_WIDTH = spacing[24];
const TAB_GAP = spacing[1.5];
const TAB_STEP = TAB_WIDTH + TAB_GAP;

export interface TabStripProps {
  tabs: readonly WorkspaceTab[];
  activeIndex: number;
  dragProgress: SharedValue<number>;
  canAdd: boolean;
  onSelect: (index: number) => void;
  onActions: (tab: WorkspaceTab) => void;
  onAdd: () => void;
}

export function TabStrip({
  tabs,
  activeIndex,
  dragProgress,
  canAdd,
  onSelect,
  onActions,
  onAdd,
}: TabStripProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const scrollRef = useRef<ScrollView>(null);
  const surfaces = theme.isDark ? tabSurfaces.dark : tabSurfaces.light;
  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dragProgress.value * TAB_STEP }],
  }));

  useEffect(() => {
    scrollRef.current?.scrollTo({
      animated: !reducedMotion,
      x: Math.max(0, activeIndex * TAB_STEP - TAB_STEP),
    });
  }, [activeIndex, reducedMotion]);

  return (
    <View
      style={[
        styles.frame,
        {
          borderBottomColor: theme.colors.border,
          borderBottomWidth: borderWidth.hairline,
          minHeight: chrome.touchTarget,
        },
      ]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        horizontal
        ref={scrollRef}
        showsHorizontalScrollIndicator={false}
        testID="workspace-tab-strip"
      >
        <View style={styles.tabs}>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.focusedSurface,
              {
                backgroundColor: surfaces.focused,
                borderRadius: theme.radii.md,
              },
              indicatorStyle,
            ]}
            testID="workspace-tab-indicator"
          />
          {tabs.map((tab, index) => {
            const selected = index === activeIndex;
            return (
              <Pressable
                accessibilityLabel={`${tab.name} tab`}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                key={tab.id}
                onLongPress={() => {
                  haptics.impact("medium");
                  onActions(tab);
                }}
                onPress={() => onSelect(index)}
                style={({ pressed }) => [
                  styles.tab,
                  {
                    opacity: pressed ? opacity.hoverButton : opacity.opaque,
                  },
                ]}
                testID={`workspace-tab-${tab.id}`}
              >
                {({ pressed }) => (
                  <View
                    style={[
                      styles.tabSurface,
                      {
                        backgroundColor: pressed
                          ? theme.colors.accent
                          : selected
                            ? "transparent"
                            : surfaces.dimmed,
                        borderRadius: theme.radii.md,
                        paddingHorizontal: spacing[2],
                      },
                    ]}
                    testID={`workspace-tab-surface-${tab.id}`}
                  >
                    <Text
                      color={selected ? "foreground" : "mutedForeground"}
                      numberOfLines={1}
                      variant="label"
                      weight={selected ? "semibold" : "normal"}
                    >
                      {tab.name}
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
        <IconButton
          accessibilityLabel="Add tab"
          disabled={!canAdd}
          icon="Plus"
          onPress={onAdd}
          size="sm"
          testID="add-tab-button"
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: "center",
    gap: TAB_GAP,
  },
  frame: {
    flexShrink: 0,
  },
  focusedSurface: {
    height: spacing[8],
    left: 0,
    position: "absolute",
    top: spacing[1.5],
    width: TAB_WIDTH,
  },
  tab: {
    alignItems: "center",
    height: chrome.touchTarget,
    justifyContent: "center",
    width: TAB_WIDTH,
  },
  tabSurface: {
    alignItems: "center",
    height: spacing[8],
    justifyContent: "center",
    width: TAB_WIDTH,
  },
  tabs: {
    flexDirection: "row",
    gap: TAB_GAP,
    position: "relative",
  },
});
