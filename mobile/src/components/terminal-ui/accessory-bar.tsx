import { Keyboard, ScrollView, StyleSheet, View } from "react-native";
import { KeyboardController, useKeyboardState } from "react-native-keyboard-controller";

import type { TerminalCommand } from "@/components/terminal-ui/terminal-commands";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { encodeKey } from "@/terminal/key-encoder";
import type { KeySpec } from "@/terminal/transport/types";
import { borderWidth, radii, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

type KeyEncoder = (key: KeySpec) => string;

export interface TerminalAccessoryBarProps {
  disabled?: boolean;
  onSend: (sequence: string, spec: KeySpec) => void;
  /** The keys pinned for this agent, in the order they were pinned. */
  commands?: readonly TerminalCommand[];
  onCommand?: (command: TerminalCommand) => void;
  /** Opens the attach-or-paste drawer; everything that inserts content lives there. */
  onAttach: () => void;
  /** Opens the drawer holding every key this agent has a use for. */
  onMore: () => void;
  onDismissKeyboard: () => void;
  encode?: KeyEncoder;
}

/**
 * The strip above the keyboard.
 *
 * Four round controls and, between them, whatever keys the operator pinned for
 * the agent they are talking to. It used to carry a fixed rank of key caps —
 * Esc, Tab, ^C, More — which put a second, partial keyboard above the real one
 * and was the same rank whether a shell or Claude Code was running. The middle
 * is chosen per agent now, and everything else is one drawer away.
 *
 * The keyboard dismissal only appears while there is a keyboard to dismiss; at
 * rest the button is a control that does nothing, and the strip is quieter for
 * losing it.
 */
export function TerminalAccessoryBar({
  disabled = false,
  onSend,
  commands = [],
  onCommand,
  onAttach,
  onMore,
  onDismissKeyboard,
  encode = encodeKey,
}: TerminalAccessoryBarProps): React.JSX.Element {
  const theme = useTheme();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);

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
        <IconButton
          accessibilityLabel="Keyboard shortcuts"
          disabled={disabled}
          icon="Command"
          onPress={() => {
            haptics.selection();
            onMore();
          }}
          size="sm"
          style={styles.round}
          testID="accessory-shortcuts"
          variant="secondary"
        />
        <ScrollView
          contentContainerStyle={[styles.pinned, { gap: sizing.terminalAccessory.gap }]}
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          style={styles.pinnedViewport}
          testID="accessory-pinned"
        >
          {commands.map((command) => (
            <Button
              accessibilityLabel={command.label}
              disabled={disabled}
              key={command.id}
              onPress={() => {
                haptics.selection();
                onCommand?.(command);
              }}
              size="sm"
              style={styles.cap}
              testID={`accessory-command-${command.id}`}
              variant="secondary"
            >
              <Text color="secondaryForeground" variant="mono">
                {command.cap}
              </Text>
            </Button>
          ))}
        </ScrollView>
        {keyboardVisible ? (
          <IconButton
            accessibilityLabel="Dismiss keyboard"
            icon="ChevronDown"
            iconSize={sizing.terminalAccessory.dismissIcon}
            onPress={dismissKeyboard}
            size="sm"
            style={styles.round}
            testID="accessory-dismiss-keyboard"
          />
        ) : null}
        <IconButton
          accessibilityLabel="Send"
          disabled={disabled}
          icon="SendHorizontal"
          iconSize={sizing.terminalAccessory.sendIcon}
          onPress={() => send({ kind: "named", key: "Enter" }, "light")}
          size="sm"
          style={styles.send}
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
  cap: {
    borderRadius: radii.md,
    height: sizing.terminalAccessory.controlHeight,
    minHeight: sizing.terminalAccessory.controlHeight,
    minWidth: sizing.terminalAccessory.keyMinWidth,
    paddingHorizontal: sizing.terminalAccessory.keyHorizontalPadding,
  },
  pinned: {
    alignItems: "center",
    flexDirection: "row",
  },
  // Takes the space the four round controls leave, so an empty pin list simply
  // reads as the gap that was there before.
  pinnedViewport: {
    flex: 1,
  },
  round: {
    borderRadius: radii.pill,
    height: sizing.terminalAccessory.controlHeight,
    minHeight: sizing.terminalAccessory.controlHeight,
    width: sizing.terminalAccessory.controlHeight,
  },
  send: {
    borderRadius: radii.pill,
    height: sizing.terminalAccessory.sendControlHeight,
    minHeight: sizing.terminalAccessory.sendControlHeight,
    width: sizing.terminalAccessory.sendControlHeight,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.terminalAccessory.gap,
    paddingHorizontal: sizing.terminalAccessory.horizontalPadding,
  },
});
