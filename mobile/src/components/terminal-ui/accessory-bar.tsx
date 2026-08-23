import { useRef } from "react";
import { Keyboard, ScrollView, StyleSheet, View } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { encodeKey } from "@/terminal/key-encoder";
import type { KeySpec } from "@/terminal/transport/types";
import { borderWidth, radii, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

type KeyEncoder = (key: KeySpec) => string;

interface KeyCapProps {
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}

function KeyCap({
  label,
  accessibilityLabel,
  disabled = false,
  onPress,
  onLongPress,
}: KeyCapProps): React.JSX.Element {
  const theme = useTheme();
  const longPressed = useRef(false);
  return (
    <Button
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      delayLongPress={theme.motion.duration.successHold}
      disabled={disabled}
      onLongPress={
        onLongPress
          ? () => {
              longPressed.current = true;
              onLongPress();
            }
          : undefined
      }
      onPress={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onPress();
      }}
      size="sm"
      style={styles.key}
      variant="secondary"
    >
      <Text variant="mono">{label}</Text>
    </Button>
  );
}

export interface TerminalAccessoryBarProps {
  disabled?: boolean;
  onSend: (sequence: string, spec: KeySpec) => void;
  /** Opens the attach-or-paste drawer; everything that inserts content lives there. */
  onAttach: () => void;
  /** Opens the drawer holding every key this row does not carry. */
  onMore: () => void;
  onDismissKeyboard: () => void;
  encode?: KeyEncoder;
}

/**
 * The strip above the keyboard.
 *
 * It carries only what an agent session reaches for constantly — interrupt,
 * complete, cancel — because a phone keyboard already leaves little room and a
 * wall of key caps reads as clutter rather than as help. Everything else is one
 * tap into More, and everything that inserts content is one tap into the plus.
 */
export function TerminalAccessoryBar({
  disabled = false,
  onSend,
  onAttach,
  onMore,
  onDismissKeyboard,
  encode = encodeKey,
}: TerminalAccessoryBarProps): React.JSX.Element {
  const theme = useTheme();

  const send = (key: KeySpec, impact: "selection" | "light" = "selection"): void => {
    const sequence = encode(key);
    if (sequence.length === 0) {
      haptics.warning();
      return;
    }
    if (impact === "light") haptics.impact("light");
    else haptics.selection();
    onSend(sequence, key);
  };

  const dismissKeyboard = (): void => {
    onDismissKeyboard();
    void KeyboardController.dismiss().catch(() => Keyboard.dismiss());
  };

  // The overlay holds the foot of the terminal against the keyboard (or the nav
  // bar), so the bar is an ordinary last row rather than something that
  // translates itself over the surface and leaves a hole behind.
  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.background,
          borderTopColor: theme.colors.border,
          borderTopWidth: borderWidth.hairline,
          paddingBottom: sizing.terminalAccessory.verticalPadding,
          paddingTop: sizing.terminalAccessory.verticalPadding,
        },
      ]}
      testID="terminal-accessory-bar"
    >
      <View style={styles.row}>
        <IconButton
          accessibilityLabel="Attach or paste"
          disabled={disabled}
          icon="Plus"
          onPress={() => {
            haptics.selection();
            onAttach();
          }}
          size="sm"
          style={styles.round}
          testID="accessory-attach"
          variant="secondary"
        />
        <ScrollView
          bounces={false}
          contentContainerStyle={styles.scrollContent}
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
        >
          <KeyCap
            disabled={disabled}
            label="Esc"
            onPress={() => send({ kind: "named", key: "Escape" })}
          />
          <KeyCap
            accessibilityLabel="Tab, hold for Shift Tab"
            disabled={disabled}
            label="Tab"
            onLongPress={() => send({ kind: "named", key: "BackTab" })}
            onPress={() => send({ kind: "named", key: "Tab" })}
          />
          <KeyCap
            accessibilityLabel="Control C"
            disabled={disabled}
            label="^C"
            onPress={() => send({ kind: "text", text: "c", modifiers: { ctrl: true } }, "light")}
          />
          <KeyCap
            disabled={disabled}
            label="More"
            onPress={() => {
              haptics.selection();
              onMore();
            }}
          />
        </ScrollView>
        <IconButton
          accessibilityLabel="Dismiss keyboard"
          icon="ChevronDown"
          onPress={dismissKeyboard}
          size="sm"
          style={styles.round}
        />
        <IconButton
          accessibilityLabel="Send"
          disabled={disabled}
          icon="SendHorizontal"
          onPress={() => send({ kind: "named", key: "Enter" }, "light")}
          size="sm"
          style={styles.round}
          testID="accessory-send"
          variant="default"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    width: "100%",
  },
  key: {
    alignItems: "center",
    height: sizing.terminalAccessory.controlHeight,
    justifyContent: "center",
    minHeight: sizing.terminalAccessory.controlHeight,
    minWidth: sizing.terminalAccessory.keyMinWidth,
    paddingHorizontal: sizing.terminalAccessory.keyHorizontalPadding,
  },
  round: {
    borderRadius: radii.pill,
    height: sizing.terminalAccessory.controlHeight,
    minHeight: sizing.terminalAccessory.controlHeight,
    width: sizing.terminalAccessory.controlHeight,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.terminalAccessory.gap,
    paddingHorizontal: sizing.terminalAccessory.horizontalPadding,
  },
  scrollContent: {
    alignItems: "center",
    gap: sizing.terminalAccessory.gap,
  },
});
