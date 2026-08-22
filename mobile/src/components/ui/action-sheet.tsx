import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, chrome, opacity, useTheme } from "@/theme";

export interface ActionSheetAction {
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
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

export function ActionSheet({
  visible,
  onDismiss,
  actions,
  title,
  message,
  cancelLabel = "Cancel",
}: ActionSheetProps): React.JSX.Element {
  const theme = useTheme();

  const handleAction = (action: ActionSheetAction) => {
    haptics.selection();
    action.onPress();
    onDismiss();
  };

  return (
    <Sheet enableDynamicSizing onDismiss={onDismiss} visible={visible}>
      {title ? <SheetHeader title={title} /> : null}
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
            {index > 0 ? (
              <View
                style={{
                  backgroundColor: theme.colors.popoverBorder,
                  height: borderWidth.hairline,
                  marginHorizontal: theme.space(4),
                }}
              />
            ) : null}
            <Pressable
              accessibilityLabel={action.accessibilityLabel ?? action.label}
              accessibilityRole="button"
              accessibilityState={{ disabled: action.disabled }}
              disabled={action.disabled}
              onPress={() => handleAction(action)}
              style={({ pressed }) => [
                styles.action,
                {
                  backgroundColor: pressed
                    ? action.destructive
                      ? theme.colors.destructiveSoft
                      : theme.colors.popoverAccent
                    : "transparent",
                  gap: theme.space(3),
                  minHeight: chrome.touchTarget,
                  opacity: action.disabled ? opacity.disabled : opacity.opaque,
                  paddingHorizontal: theme.space(4),
                  paddingVertical: theme.space(2.5),
                },
              ]}
            >
              {action.icon}
              <View style={styles.actionCopy}>
                <Text
                  color={action.destructive ? "destructive" : "popoverForeground"}
                  variant="body"
                >
                  {action.label}
                </Text>
                {action.detail ? (
                  <Text color="mutedForeground" variant="caption">
                    {action.detail}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          </View>
        ))}
      </View>
      <View
        style={{
          borderTopColor: theme.colors.popoverBorder,
          borderTopWidth: borderWidth.hairline,
          marginTop: theme.space(2),
          padding: theme.space(2),
          paddingBottom: theme.space(3),
        }}
      >
        <Pressable
          accessibilityLabel={cancelLabel}
          accessibilityRole="button"
          onPress={() => {
            haptics.selection();
            onDismiss();
          }}
          style={({ pressed }) => [
            styles.cancel,
            {
              backgroundColor: pressed ? theme.colors.popoverAccent : "transparent",
              borderRadius: theme.radii.md,
              minHeight: chrome.touchTarget,
              paddingHorizontal: theme.space(4),
              paddingVertical: theme.space(2.5),
            },
          ]}
        >
          <Text variant="label">{cancelLabel}</Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    flexDirection: "row",
  },
  actionCopy: {
    flex: 1,
    minWidth: 0,
  },
  cancel: {
    alignItems: "center",
    justifyContent: "center",
  },
});
