import { Link } from "expo-router";
import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  Popover,
  type PopoverAlign,
  type PopoverAnchorRect,
  type PopoverSide,
} from "@/components/ui/popover";
import { SheetScrollView } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, chrome, opacity, useTheme } from "@/theme";

export interface MenuItem {
  type?: "item";
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  onPress: () => void;
}

export interface MenuSeparator {
  type: "separator";
  id: string;
}

export interface MenuLabel {
  type: "label";
  id: string;
  label: string;
}

export type MenuEntry = MenuItem | MenuSeparator | MenuLabel;

/** Native iOS context menu primitives for navigational Links and their long-press previews. */
function UnavailableNativeLinkMenu(): null {
  return null;
}

export const NativeLinkMenu = Link?.Menu ?? UnavailableNativeLinkMenu;
export const NativeLinkMenuAction = Link?.MenuAction ?? UnavailableNativeLinkMenu;

export interface MenuProps {
  visible: boolean;
  onDismiss: () => void;
  anchorRef?: RefObject<View | null>;
  anchorRect?: PopoverAnchorRect;
  entries: readonly MenuEntry[];
  side?: PopoverSide;
  align?: PopoverAlign;
  width?: number;
  accessibilityLabel?: string;
}

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return entry.type === "separator";
}

function isLabel(entry: MenuEntry): entry is MenuLabel {
  return entry.type === "label";
}

export function Menu({
  visible,
  onDismiss,
  anchorRef,
  anchorRect,
  entries,
  side = "bottom",
  align = "start",
  width,
  accessibilityLabel = "Actions",
}: MenuProps): React.JSX.Element {
  const theme = useTheme();
  const wasVisible = useRef(false);

  useEffect(() => {
    if (visible && !wasVisible.current) haptics.overlayOpen();
    wasVisible.current = visible;
  }, [visible]);

  const dismiss = () => {
    haptics.overlayDismiss();
    onDismiss();
  };

  return (
    <Popover
      accessibilityLabel={accessibilityLabel}
      align={align}
      interactive
      onDismiss={dismiss}
      side={side}
      visible={visible}
      {...(width === undefined ? {} : { width })}
      {...(anchorRect === undefined ? {} : { anchorRect })}
      {...(anchorRef === undefined ? {} : { anchorRef })}
    >
      <View
        style={{
          backgroundColor: theme.colors.popover,
          borderWidth: borderWidth.none,
          paddingHorizontal: theme.space(2),
        }}
        testID="menu-surface"
      >
        <SheetScrollView
          bounces={false}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          {entries.map((entry) => {
            if (isSeparator(entry)) {
              return (
                <View
                  key={entry.id}
                  style={{
                    backgroundColor: theme.colors.popoverBorder,
                    height: borderWidth.hairline,
                    marginHorizontal: theme.space(1),
                    marginVertical: theme.space(1),
                  }}
                />
              );
            }
            if (isLabel(entry)) {
              return (
                <Text
                  color="mutedForeground"
                  key={entry.id}
                  style={{ paddingHorizontal: theme.space(2), paddingVertical: theme.space(1.5) }}
                  variant="micro"
                >
                  {entry.label}
                </Text>
              );
            }

            const textColor = entry.destructive ? "destructive" : "popoverForeground";
            return (
              <Pressable
                accessibilityLabel={entry.accessibilityLabel ?? entry.label}
                accessibilityRole="menuitem"
                accessibilityState={{ disabled: entry.disabled }}
                disabled={entry.disabled}
                key={entry.id}
                onPress={() => {
                  haptics.selection();
                  entry.onPress();
                  dismiss();
                }}
                style={({ pressed }) => [
                  styles.item,
                  {
                    backgroundColor: pressed
                      ? entry.destructive
                        ? theme.colors.destructiveSoft
                        : theme.colors.popoverAccent
                      : "transparent",
                    borderRadius: theme.radii.md,
                    gap: theme.space(2),
                    minHeight: chrome.touchTarget,
                    opacity: entry.disabled ? opacity.disabled : opacity.opaque,
                    paddingHorizontal: theme.space(2),
                    paddingVertical: theme.space(2),
                  },
                ]}
              >
                {entry.icon ? (
                  <View style={[styles.icon, { height: theme.space(4), width: theme.space(4) }]}>
                    {entry.icon}
                  </View>
                ) : null}
                <View style={styles.copy}>
                  <Text color={textColor} variant="uiBase">
                    {entry.label}
                  </Text>
                  {entry.detail ? (
                    <Text color="mutedForeground" variant="caption">
                      {entry.detail}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </SheetScrollView>
      </View>
    </Popover>
  );
}

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    minWidth: 0,
  },
  icon: {
    alignItems: "center",
    justifyContent: "center",
  },
  item: {
    alignItems: "center",
    flexDirection: "row",
    width: "100%",
  },
  scrollContent: {
    flexGrow: 1,
  },
});
