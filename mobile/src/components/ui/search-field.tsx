import { type ForwardedRef, forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, type TextInput } from "react-native";
import { Icon } from "@/components/ui/icon";
import { Input, type InputProps } from "@/components/ui/input";
import { chrome, spacing } from "@/theme/spacing";

export const DEFAULT_SEARCH_DEBOUNCE_MS = 250;

export interface SearchFieldProps extends Omit<InputProps, "leading" | "purpose" | "trailing"> {
  debounceMs?: number;
  onDebouncedChange?: (value: string) => void;
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
    ...props
  },
  forwardedRef,
) {
  const inputRef = useRef<TextInput | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? "");
  const displayedValue = value ?? uncontrolledValue;

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
      placeholder={placeholder}
      value={displayedValue}
      onChangeText={updateValue}
      leading={<Icon color="mutedForeground" name="Search" size={spacing[4]} />}
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
            <Icon color="mutedForeground" name="X" size={spacing[3.5]} />
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
});
