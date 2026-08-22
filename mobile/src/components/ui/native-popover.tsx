import type { SFSymbol } from "expo-symbols";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Icon, type IconName, iconSet } from "@/components/ui/icon";
import { Popover } from "@/components/ui/popover";
import { SheetScrollView } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, chrome, opacity, useTheme } from "@/theme";

export interface NativePopoverProps {
  visible: boolean;
  onDismiss: () => void;
  anchor: { x: number; y: number; width: number; height: number };
  items: Array<{
    key: string;
    label: string;
    icon?: string;
    destructive?: boolean;
    disabled?: boolean;
    onPress: () => void;
  }>;
}

function isIconName(value: string): value is IconName {
  return value in iconSet;
}

function PopoverIcon({ name, size }: { name: string; size: number }): React.JSX.Element {
  if (isIconName(name)) return <Icon name={name} size={size} variant="chrome" />;
  return <Icon name="Ellipsis" size={size} symbol={name as SFSymbol} variant="chrome" />;
}

export function NativePopover({
  visible,
  onDismiss,
  items,
}: NativePopoverProps): React.JSX.Element {
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
    <Popover accessibilityLabel="Actions" interactive onDismiss={dismiss} visible={visible}>
      <View
        style={[
          styles.surface,
          {
            backgroundColor: theme.colors.popover,
            borderWidth: borderWidth.none,
            paddingHorizontal: theme.space(2),
          },
        ]}
        testID="native-popover-surface"
      >
        <SheetScrollView
          bounces={false}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          {items.map((item, index) => {
            const textColor = item.destructive ? "destructive" : "popoverForeground";
            return (
              <View key={item.key}>
                {index > 0 ? (
                  <View
                    style={{
                      backgroundColor: theme.colors.popoverBorder,
                      height: borderWidth.hairline,
                      marginHorizontal: theme.space(3),
                    }}
                  />
                ) : null}
                <Pressable
                  accessibilityLabel={item.label}
                  accessibilityRole="menuitem"
                  accessibilityState={{ disabled: item.disabled }}
                  disabled={item.disabled}
                  onPress={() => {
                    haptics.selection();
                    item.onPress();
                    dismiss();
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      backgroundColor: pressed
                        ? item.destructive
                          ? theme.colors.destructiveSoft
                          : theme.colors.popoverAccent
                        : "transparent",
                      borderRadius: theme.radii.lg,
                      gap: theme.space(2.5),
                      minHeight: chrome.touchTarget,
                      opacity: item.disabled ? opacity.disabled : opacity.opaque,
                      paddingHorizontal: theme.space(3),
                      paddingVertical: theme.space(2.5),
                    },
                  ]}
                  testID={`native-popover-item-${item.key}`}
                >
                  {item.icon ? (
                    <View style={[styles.icon, { height: theme.space(5), width: theme.space(6) }]}>
                      <PopoverIcon name={item.icon} size={theme.space(5)} />
                    </View>
                  ) : null}
                  <Text
                    color={textColor}
                    numberOfLines={1}
                    style={[
                      styles.label,
                      {
                        fontSize: theme.type.fontSize.seventeen,
                        lineHeight: theme.type.lineHeight.base,
                      },
                    ]}
                    variant="body"
                  >
                    {item.label}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </SheetScrollView>
      </View>
    </Popover>
  );
}

const styles = StyleSheet.create({
  icon: {
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    flex: 1,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    width: "100%",
  },
  surface: {
    width: "100%",
  },
});
