import { useEffect, useRef, useState } from "react";
import { StyleSheet, type TextInput, View } from "react-native";

import { IconButton } from "@/components/ui/icon-button";
import { SearchField } from "@/components/ui/search-field";
import { borderWidth, useTheme } from "@/theme";

export interface TerminalSearchBarProps {
  visible: boolean;
  onSearch: (query: string, direction: "next" | "prev") => void;
  onDismiss: () => void;
}

export function TerminalSearchBar({
  visible,
  onSearch,
  onDismiss,
}: TerminalSearchBarProps): React.JSX.Element | null {
  const theme = useTheme();
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  if (!visible) return null;
  const search = (direction: "next" | "prev"): void => {
    if (query.length > 0) onSearch(query, direction);
  };

  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: theme.colors.background,
          borderBottomColor: theme.colors.border,
          borderBottomWidth: borderWidth.hairline,
          gap: theme.space(1),
          padding: theme.space(2),
        },
      ]}
      testID="terminal-search-bar"
    >
      <SearchField
        accessibilityLabel="Search terminal output"
        containerStyle={styles.input}
        onChangeText={setQuery}
        onSubmitEditing={() => search("next")}
        placeholder="Search terminal"
        ref={inputRef}
        returnKeyType="search"
        value={query}
      />
      <IconButton
        accessibilityLabel="Previous match"
        disabled={query.length === 0}
        icon="ChevronUp"
        onPress={() => search("prev")}
      />
      <IconButton
        accessibilityLabel="Next match"
        disabled={query.length === 0}
        icon="ChevronDown"
        onPress={() => search("next")}
      />
      <IconButton accessibilityLabel="Close search" icon="X" onPress={onDismiss} />
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    flex: 1,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
  },
});
