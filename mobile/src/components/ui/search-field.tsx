import { type ForwardedRef, forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, type TextInput, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import { Input, type InputProps } from "@/components/ui/input";
import { useTheme } from "@/theme";
import { alpha } from "@/theme/effects";
import { sizing } from "@/theme/sizing";
import { chrome, radii, spacing } from "@/theme/spacing";

export const DEFAULT_SEARCH_DEBOUNCE_MS = 250;

export type SearchFieldVariant = "default" | "sidebar" | "inline";

export interface SearchFieldProps
  extends Omit<InputProps, "leading" | "purpose" | "showFocusHalo" | "trailing"> {
  debounceMs?: number;
  onDebouncedChange?: (value: string) => void;
  variant?: SearchFieldVariant;
}

function colorWithAlpha(color: string, channelAlpha: number): string {
  if (!/^#[\dA-Fa-f]{6}$/.test(color)) return color;
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `rgba(${red},${green},${blue},${channelAlpha})`;
}

function assignRef(ref: ForwardedRef<TextInput>, value: TextInput | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref !== null) {
    ref.current = value;
  }
}

export const SearchField = forwardRef<TextInput, SearchFieldProps>(function SearchField(
  {
    debounceMs = DEFAULT_SEARCH_DEBOUNCE_MS,
    onDebouncedChange,
    onChangeText,
    value,
    defaultValue,
    editable = true,
    accessibilityLabel,
    placeholder,
    containerStyle,
    style,
    variant = "default",
    ...props
  },
  forwardedRef,
) {
  const theme = useTheme();
  const inputRef = useRef<TextInput | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? "");
  const displayedValue = value ?? uncontrolledValue;
  const isSidebar = variant === "sidebar";

  useEffect(
    () => () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    },
    [],
  );

  const setInputRef = useCallback(
    (node: TextInput | null) => {
      inputRef.current = node;
      assignRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  const updateValue = (nextValue: string) => {
    if (value === undefined) setUncontrolledValue(nextValue);
    onChangeText?.(nextValue);

    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    if (onDebouncedChange !== undefined) {
      debounceTimer.current = setTimeout(() => {
        onDebouncedChange(nextValue);
        debounceTimer.current = null;
      }, debounceMs);
    }
  };

  return (
    <Input
      {...props}
      ref={setInputRef}
      purpose="search"
      editable={editable}
      accessibilityLabel={accessibilityLabel ?? placeholder ?? "Search"}
      containerStyle={[
        isSidebar && styles.sidebarContainer,
        isSidebar && {
          backgroundColor: colorWithAlpha(theme.colors.muted, alpha.a50),
          borderColor: "transparent",
        },
        containerStyle,
      ]}
      placeholder={placeholder}
      showFocusHalo={!isSidebar}
      style={[styles.input, style]}
      value={displayedValue}
      onChangeText={updateValue}
      leading={
        <Icon color="mutedForeground" name="Search" size={isSidebar ? spacing[3.5] : spacing[4]} />
      }
      trailing={
        displayedValue.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            disabled={!editable}
            onPress={() => {
              updateValue("");
              inputRef.current?.focus();
            }}
            style={styles.clearButton}
          >
            <View pointerEvents="none" style={styles.clearVisual}>
              <Icon color="mutedForeground" name="X" size={spacing[3.5]} />
            </View>
          </Pressable>
        ) : undefined
      }
    />
  );
});

const styles = StyleSheet.create({
  clearButton: {
    alignItems: "center",
    height: chrome.touchTarget,
    justifyContent: "center",
    width: chrome.touchTarget,
  },
  clearVisual: {
    alignItems: "center",
    height: spacing[6],
    justifyContent: "center",
    width: spacing[6],
  },
  input: {
    lineHeight: sizing.type.componentLabel.lineHeight,
    paddingLeft: spacing[2],
    paddingVertical: spacing[0],
    textAlignVertical: "center",
  },
  sidebarContainer: {
    borderRadius: radii.lg,
  },
});
