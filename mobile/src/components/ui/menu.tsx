import { Link } from "expo-router";
import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { DrawerRow, DrawerSeparator } from "@/components/ui/drawer-row";
import {
  Popover,
  type PopoverAlign,
  type PopoverAnchorRect,
  type PopoverSide,
} from "@/components/ui/popover";
import { SheetScrollView } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

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
  /**
   * Called when this menu comes back after a drawer opened from one of its rows
   * was dismissed. Owners that mirror `visible` elsewhere — a screen standing
   * the keyboard down while a menu is up, say — set it back from here.
   */
  onReturn?: () => void;
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
  onReturn,
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
      {...(onReturn === undefined ? {} : { onReturn })}
      {...(width === undefined ? {} : { width })}
      {...(anchorRect === undefined ? {} : { anchorRect })}
      {...(anchorRef === undefined ? {} : { anchorRef })}
    >
      <View
        style={{
          backgroundColor: theme.colors.popover,
          borderWidth: borderWidth.none,
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
              return <DrawerSeparator key={entry.id} />;
            }
            if (isLabel(entry)) {
              return (
                <Text
                  color="mutedForeground"
                  key={entry.id}
                  style={{
                    paddingHorizontal: sizing.actionSheet.horizontalPadding,
                    paddingVertical: theme.space(1.5),
                  }}
                  variant="micro"
                >
                  {entry.label}
                </Text>
              );
            }

            return (
              <DrawerRow
                accessibilityRole="menuitem"
                destructive={entry.destructive ?? false}
                disabled={entry.disabled ?? false}
                key={entry.id}
                onPress={() => {
                  haptics.selection();
                  entry.onPress();
                  dismiss();
                }}
                {...(entry.accessibilityLabel === undefined
                  ? {}
                  : { accessibilityLabel: entry.accessibilityLabel })}
                {...(entry.detail === undefined ? {} : { detail: entry.detail })}
                {...(entry.icon === undefined ? {} : { icon: entry.icon })}
                label={entry.label}
              />
            );
          })}
        </SheetScrollView>
      </View>
    </Popover>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
  },
});
