import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import type { KeySpec, NamedTerminalKey } from "@/terminal/transport/types";
import { useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

interface KeyChoice {
  label: string;
  accessibilityLabel: string;
  key: NamedTerminalKey;
}

const NAVIGATION_KEYS: readonly KeyChoice[] = [
  { label: "Home", accessibilityLabel: "Home", key: "Home" },
  { label: "End", accessibilityLabel: "End", key: "End" },
  { label: "PgUp", accessibilityLabel: "Page up", key: "PageUp" },
  { label: "PgDn", accessibilityLabel: "Page down", key: "PageDown" },
  { label: "Ins", accessibilityLabel: "Insert", key: "Insert" },
  { label: "Del", accessibilityLabel: "Delete", key: "Delete" },
  { label: "⇧Tab", accessibilityLabel: "Shift Tab", key: "BackTab" },
];

const FUNCTION_KEYS: readonly KeyChoice[] = Array.from({ length: 12 }, (_, index) => {
  const number = index + 1;
  return {
    label: `F${number}`,
    accessibilityLabel: `Function ${number}`,
    key: `F${number}` as NamedTerminalKey,
  };
});

export interface TerminalKeysSheetProps {
  visible: boolean;
  onDismiss: () => void;
  onKey: (key: KeySpec) => void;
}

function SheetKey({ choice, onPress }: { choice: KeyChoice; onPress: () => void }) {
  return (
    <Button
      accessibilityLabel={choice.accessibilityLabel}
      onPress={onPress}
      size="sm"
      style={styles.key}
      variant="secondary"
    >
      <Text variant="mono">{choice.label}</Text>
    </Button>
  );
}

export function TerminalKeysSheet({
  visible,
  onDismiss,
  onKey,
}: TerminalKeysSheetProps): React.JSX.Element {
  const theme = useTheme();
  const send = (choice: KeyChoice): void => {
    onKey({ kind: "named", key: choice.key });
  };

  return (
    <Sheet enableDynamicSizing onDismiss={onDismiss} visible={visible}>
      <SheetHeader title="More keys" />
      <View style={[styles.content, { gap: theme.space(4), padding: theme.space(4) }]}>
        <View style={[styles.group, { gap: theme.space(2) }]}>
          <Text color="mutedForeground" variant="micro">
            NAVIGATION
          </Text>
          <View style={[styles.grid, { gap: theme.space(2) }]}>
            {NAVIGATION_KEYS.map((choice) => (
              <SheetKey choice={choice} key={choice.key} onPress={() => send(choice)} />
            ))}
          </View>
        </View>
        <View style={[styles.group, { gap: theme.space(2) }]}>
          <Text color="mutedForeground" variant="micro">
            FUNCTION KEYS
          </Text>
          <View style={[styles.grid, { gap: theme.space(2) }]}>
            {FUNCTION_KEYS.map((choice) => (
              <SheetKey choice={choice} key={choice.key} onPress={() => send(choice)} />
            ))}
          </View>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    flexDirection: "column",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  group: {
    flexDirection: "column",
  },
  key: {
    minWidth: sizing.control.minimumTouchTarget,
  },
});
