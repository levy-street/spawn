import type { ReactNode } from "react";
import { ActionSheetIOS, Platform, View } from "react-native";

import { DrawerRow, DrawerSeparator } from "@/components/ui/drawer-row";
import { Icon } from "@/components/ui/icon";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/theme";

export interface ActionSheetAction {
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  /** Marks the row that answers a choice, the way a Select's current value does. */
  selected?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: "button" | "menuitem" | "radio";
  onPress: () => void;
}

export interface ActionSheetProps {
  visible: boolean;
  onDismiss: () => void;
  actions: readonly ActionSheetAction[];
  title?: string;
  message?: string;
  cancelLabel?: string;
}

export type NativeActionSheetOptions = Omit<ActionSheetProps, "visible">;

/**
 * Opens UIKit's bottom action sheet when that presentation is intentional.
 * Icons and detail copy are omitted because ActionSheetIOS only accepts button labels.
 */
export function showNativeActionSheet({
  actions,
  onDismiss,
  title,
  message,
  cancelLabel = "Cancel",
}: NativeActionSheetOptions): boolean {
  if (Platform.OS !== "ios") return false;

  const cancelButtonIndex = actions.length;
  const destructiveButtonIndex = actions.flatMap((action, index) =>
    action.destructive ? [index] : [],
  );
  const disabledButtonIndices = actions.flatMap((action, index) =>
    action.disabled ? [index] : [],
  );

  ActionSheetIOS.showActionSheetWithOptions(
    {
      cancelButtonIndex,
      disabledButtonIndices,
      destructiveButtonIndex,
      options: [...actions.map((action) => action.label), cancelLabel],
      ...(message === undefined ? {} : { message }),
      ...(title === undefined ? {} : { title }),
    },
    (buttonIndex) => {
      if (buttonIndex === cancelButtonIndex) {
        onDismiss();
        return;
      }

      const action = actions[buttonIndex];
      if (!action || action.disabled) return;
      if (action.destructive) haptics.warning();
      else haptics.selection();
      action.onPress();
      onDismiss();
    },
  );

  return true;
}

export function ActionSheet({
  visible,
  onDismiss,
  actions,
  message,
}: ActionSheetProps): React.JSX.Element {
  const theme = useTheme();

  const handleAction = (action: ActionSheetAction) => {
    if (action.destructive) haptics.warning();
    else haptics.selection();
    action.onPress();
    onDismiss();
  };

  return (
    <Sheet onDismiss={onDismiss} visible={visible}>
      {message ? (
        <Text
          color="mutedForeground"
          style={{ paddingBottom: theme.space(3), paddingHorizontal: theme.space(4) }}
          variant="body"
        >
          {message}
        </Text>
      ) : null}
      <View>
        {actions.map((action, index) => (
          <View key={action.id}>
            {/* A drawer's actions read as one group; only the destructive one is
                set apart, which is the rule menus already followed. */}
            {index > 0 && action.destructive === true ? <DrawerSeparator /> : null}
            <DrawerRow
              destructive={action.destructive ?? false}
              disabled={action.disabled ?? false}
              label={action.label}
              onPress={() => handleAction(action)}
              {...(action.accessibilityLabel === undefined
                ? {}
                : { accessibilityLabel: action.accessibilityLabel })}
              {...(action.accessibilityRole === undefined
                ? {}
                : { accessibilityRole: action.accessibilityRole })}
              {...(action.detail === undefined ? {} : { detail: action.detail })}
              {...(action.icon === undefined ? {} : { icon: action.icon })}
              {...(action.selected === undefined
                ? {}
                : {
                    selected: action.selected,
                    ...(action.selected
                      ? { trailing: <Icon color="popoverForeground" name="Check" /> }
                      : {}),
                  })}
            />
          </View>
        ))}
      </View>
    </Sheet>
  );
}
