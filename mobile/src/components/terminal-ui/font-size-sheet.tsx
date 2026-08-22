import { StyleSheet, View } from "react-native";

import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { terminalMetrics, useTheme } from "@/theme";

export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 20;

export interface FontSizeSheetProps {
  visible: boolean;
  value: number;
  onChange: (value: number) => void;
  onDismiss: () => void;
}

export function clampTerminalFontSize(value: number): number {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(value)));
}

export function FontSizeSheet({
  visible,
  value,
  onChange,
  onDismiss,
}: FontSizeSheetProps): React.JSX.Element {
  const theme = useTheme();
  const change = (next: number): void => onChange(clampTerminalFontSize(next));
  return (
    <Sheet enableDynamicSizing onDismiss={onDismiss} visible={visible}>
      <SheetHeader title="Terminal font size" />
      <View style={[styles.content, { gap: theme.space(4), padding: theme.space(4) }]}>
        <View style={[styles.stepper, { gap: theme.space(3) }]}>
          <IconButton
            accessibilityLabel="Decrease terminal font size"
            disabled={value <= MIN_TERMINAL_FONT_SIZE}
            icon="ChevronDown"
            onPress={() => change(value - 1)}
          />
          <View style={styles.value}>
            <Text variant="title">{value} px</Text>
            <Text color="mutedForeground" variant="caption">
              Range {MIN_TERMINAL_FONT_SIZE}–{MAX_TERMINAL_FONT_SIZE} px
            </Text>
          </View>
          <IconButton
            accessibilityLabel="Increase terminal font size"
            disabled={value >= MAX_TERMINAL_FONT_SIZE}
            icon="ChevronUp"
            onPress={() => change(value + 1)}
          />
        </View>
        <IconButton
          accessibilityLabel="Reset terminal font size"
          disabled={value === terminalMetrics.fontSize}
          icon="RotateCcw"
          onPress={() => change(terminalMetrics.fontSize)}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
  },
  stepper: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    justifyContent: "center",
  },
  value: {
    alignItems: "center",
    minWidth: "40%",
  },
});
