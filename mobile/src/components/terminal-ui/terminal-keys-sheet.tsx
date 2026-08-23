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
  spec: KeySpec;
}

function named(label: string, accessibilityLabel: string, key: NamedTerminalKey): KeyChoice {
  return { label, accessibilityLabel, spec: { kind: "named", key } };
}

function control(letter: string): KeyChoice {
  return {
    label: `^${letter.toUpperCase()}`,
    accessibilityLabel: `Control ${letter.toUpperCase()}`,
    spec: { kind: "text", text: letter, modifiers: { ctrl: true } },
  };
}

function literal(text: string, accessibilityLabel: string): KeyChoice {
  return { label: text, accessibilityLabel, spec: { kind: "text", text } };
}

/** Trimmed off the accessory row, so this is where they have to be. */
const CONTROL_KEYS: readonly KeyChoice[] = [
  control("d"),
  control("z"),
  control("l"),
  control("r"),
  control("a"),
  control("e"),
  control("k"),
  control("u"),
  control("w"),
];

const SYMBOL_KEYS: readonly KeyChoice[] = [
  literal("|", "Pipe"),
  literal("/", "Slash"),
  literal("\\", "Backslash"),
  literal("-", "Hyphen"),
  literal("_", "Underscore"),
  literal("~", "Tilde"),
  literal("$", "Dollar"),
  literal("*", "Asterisk"),
  literal("&", "Ampersand"),
];

const ARROW_KEYS: readonly KeyChoice[] = [
  named("↑", "Arrow up", "ArrowUp"),
  named("↓", "Arrow down", "ArrowDown"),
  named("←", "Arrow left", "ArrowLeft"),
  named("→", "Arrow right", "ArrowRight"),
];

const NAVIGATION_KEYS: readonly KeyChoice[] = [
  named("⇧↵", "Shift Enter, insert a newline", "ShiftEnter"),
  named("Home", "Home", "Home"),
  named("End", "End", "End"),
  named("PgUp", "Page up", "PageUp"),
  named("PgDn", "Page down", "PageDown"),
  named("Ins", "Insert", "Insert"),
  named("Del", "Delete", "Delete"),
  named("⇧Tab", "Shift Tab", "BackTab"),
];

const FUNCTION_KEYS: readonly KeyChoice[] = Array.from({ length: 12 }, (_, index) =>
  named(`F${index + 1}`, `Function ${index + 1}`, `F${index + 1}` as NamedTerminalKey),
);

const GROUPS: readonly { title: string; keys: readonly KeyChoice[] }[] = [
  { title: "ARROWS", keys: ARROW_KEYS },
  { title: "CONTROL", keys: CONTROL_KEYS },
  { title: "SYMBOLS", keys: SYMBOL_KEYS },
  { title: "NAVIGATION", keys: NAVIGATION_KEYS },
  { title: "FUNCTION KEYS", keys: FUNCTION_KEYS },
];

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
    onKey(choice.spec);
  };

  return (
    <Sheet onDismiss={onDismiss} visible={visible}>
      <SheetHeader title="More keys" />
      <View style={[styles.content, { gap: theme.space(4), padding: theme.space(4) }]}>
        {GROUPS.map((group) => (
          <View key={group.title} style={[styles.group, { gap: theme.space(2) }]}>
            <Text color="mutedForeground" variant="micro">
              {group.title}
            </Text>
            <View style={[styles.grid, { gap: theme.space(2) }]}>
              {group.keys.map((choice) => (
                <SheetKey
                  choice={choice}
                  key={choice.accessibilityLabel}
                  onPress={() => send(choice)}
                />
              ))}
            </View>
          </View>
        ))}
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
