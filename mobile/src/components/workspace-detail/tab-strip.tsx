import { useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import type { WorkspaceTab } from "@/data/types/layout";
import { borderWidth, chrome, opacity, spacing, useTheme } from "@/theme";

const TAB_WIDTH = spacing[24];
const INDICATOR_INSET = spacing[2];

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
  const scrollRef = useRef<ScrollView>(null);
  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dragProgress.value * TAB_WIDTH }],
  }));

  useEffect(() => {
    scrollRef.current?.scrollTo({
      animated: true,
      x: Math.max(0, activeIndex * TAB_WIDTH - TAB_WIDTH),
    });
  }, [activeIndex]);

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
          {tabs.map((tab, index) => {
            const selected = index === activeIndex;
            return (
              <Pressable
                accessibilityLabel={`${tab.name} tab`}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                key={tab.id}
                onLongPress={() => onActions(tab)}
                onPress={() => onSelect(index)}
                style={({ pressed }) => [
                  styles.tab,
                  {
                    backgroundColor: pressed ? theme.colors.accent : "transparent",
                    opacity: pressed ? opacity.hoverButton : opacity.opaque,
                    paddingHorizontal: theme.space(2),
                    width: TAB_WIDTH,
                  },
                ]}
                testID={`workspace-tab-${tab.id}`}
              >
                <Text
                  color={selected ? "foreground" : "mutedForeground"}
                  numberOfLines={1}
                  variant="label"
                  weight={selected ? "semibold" : "normal"}
                >
                  {tab.name}
                </Text>
              </Pressable>
            );
          })}
          <Animated.View
            style={[
              styles.indicator,
              {
                backgroundColor: theme.colors.foreground,
                borderRadius: theme.radii.pill,
                left: INDICATOR_INSET,
                width: TAB_WIDTH - INDICATOR_INSET * 2,
              },
              indicatorStyle,
            ]}
            testID="workspace-tab-indicator"
          />
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
    alignItems: "stretch",
  },
  frame: {
    flexShrink: 0,
  },
  indicator: {
    bottom: 0,
    height: borderWidth.emphasis,
    position: "absolute",
  },
  tab: {
    alignItems: "center",
    height: chrome.touchTarget,
    justifyContent: "center",
  },
  tabs: {
    flexDirection: "row",
    position: "relative",
  },
});
