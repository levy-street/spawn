import { type ReactNode, useState } from "react";
import {
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { ActionSheet, type ActionSheetAction } from "@/components/ui/action-sheet";
import { Icon } from "@/components/ui/icon";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/theme";
import { opacity } from "@/theme/effects";
import { borderWidth, chrome, radii, spacing } from "@/theme/spacing";
import { typeStyles } from "@/theme/typography";

const ACTION_SHEET_OPTION_LIMIT = 6;

export interface SelectOption<Value extends string = string> {
  value: Value;
  label: string;
  detail?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
}

export interface SelectRenderState {
  selected: boolean;
}

export interface SelectProps<Value extends string = string> {
  value: Value | null;
  options: readonly SelectOption<Value>[];
  onChange: (value: Value) => void;
  placeholder: string;
  renderOption?: (option: SelectOption<Value>, state: SelectRenderState) => ReactNode;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Select<Value extends string>({
  value,
  options,
  onChange,
  placeholder,
  renderOption,
  disabled = false,
  accessibilityLabel,
  style,
  testID,
}: SelectProps<Value>) {
  const theme = useTheme();
  const [visible, setVisible] = useState(false);
  const selectedOption = options.find((option) => option.value === value);
  const usesActionSheet = options.length <= ACTION_SHEET_OPTION_LIMIT && renderOption === undefined;

  const choose = (option: SelectOption<Value>) => {
    if (option.disabled === true) return;
    if (option.value !== value) onChange(option.value);
    setVisible(false);
  };

  const actions: ActionSheetAction[] = options.map((option) => ({
    id: option.value,
    label: option.label,
    ...(option.detail === undefined ? {} : { detail: option.detail }),
    ...(option.accessibilityLabel === undefined
      ? {}
      : { accessibilityLabel: option.accessibilityLabel }),
    ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
    ...(option.value === value
      ? { icon: <Icon color="popoverForeground" name="Check" size={spacing[4]} /> }
      : {}),
    onPress: () => choose(option),
  }));

  return (
    <>
      <Pressable
        accessibilityRole="combobox"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled, expanded: visible }}
        accessibilityValue={{ text: selectedOption?.label ?? placeholder }}
        disabled={disabled}
        onPress={() => setVisible(true)}
        style={[styles.touchTarget, disabled && styles.disabled, style]}
        testID={testID}
      >
        {({ pressed }) => (
          <View
            style={[
              styles.control,
              {
                backgroundColor: pressed ? theme.colors.accent : theme.colors.background,
                borderColor: theme.colors.input,
              },
            ]}
          >
            <Text
              color={selectedOption === undefined ? "mutedForeground" : "foreground"}
              numberOfLines={1}
              style={styles.value}
            >
              {selectedOption?.label ?? placeholder}
            </Text>
            <Icon color="mutedForeground" name="ChevronDown" size={spacing[4]} />
          </View>
        )}
      </Pressable>

      {usesActionSheet ? (
        <ActionSheet
          actions={actions}
          onDismiss={() => setVisible(false)}
          title={placeholder}
          visible={visible}
        />
      ) : (
        <Sheet enableDynamicSizing onDismiss={() => setVisible(false)} visible={visible}>
          <SheetHeader title={placeholder} />
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
            {options.map((option, index) => {
              const selected = option.value === value;
              return (
                <View key={option.value}>
                  {index > 0 ? (
                    <View
                      style={[styles.divider, { backgroundColor: theme.colors.popoverBorder }]}
                    />
                  ) : null}
                  <Pressable
                    accessibilityLabel={option.accessibilityLabel ?? option.label}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected, disabled: option.disabled === true }}
                    disabled={option.disabled}
                    onPress={() => {
                      haptics.selection();
                      choose(option);
                    }}
                    style={({ pressed }) => [
                      styles.option,
                      {
                        backgroundColor: pressed
                          ? theme.colors.popoverAccent
                          : theme.colors.popover,
                      },
                      option.disabled === true && styles.disabled,
                    ]}
                  >
                    <View style={styles.optionCopy}>
                      {renderOption?.(option, { selected }) ?? (
                        <>
                          <Text color="popoverForeground" variant="body">
                            {option.label}
                          </Text>
                          {option.detail !== undefined ? (
                            <Text color="mutedForeground" variant="caption">
                              {option.detail}
                            </Text>
                          ) : null}
                        </>
                      )}
                    </View>
                    {selected ? (
                      <Icon color="popoverForeground" name="Check" size={spacing[4]} />
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
        </Sheet>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  touchTarget: {
    justifyContent: "center",
    minHeight: chrome.touchTarget,
    width: "100%",
  },
  disabled: {
    opacity: opacity.disabled,
  },
  control: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    height: spacing[10],
    paddingHorizontal: spacing[3],
  },
  value: {
    ...typeStyles.uiSm,
    flex: 1,
    marginRight: spacing[2],
  },
  divider: {
    height: borderWidth.hairline,
    marginHorizontal: spacing[4],
  },
  option: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    minHeight: chrome.touchTarget,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2.5],
  },
  optionCopy: {
    flex: 1,
    minWidth: 0,
  },
});
