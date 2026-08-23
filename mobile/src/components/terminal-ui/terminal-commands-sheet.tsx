import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  agentLabel,
  type TerminalAgentKind,
  type TerminalCommand,
  terminalCommandGroups,
} from "@/components/terminal-ui/terminal-commands";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Sheet, SheetHeader, SheetScrollView } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface TerminalCommandsSheetProps {
  visible: boolean;
  /** Which key list to show: a coding agent's own keys, or a shell's. */
  kind: TerminalAgentKind;
  pinned: readonly string[];
  onDismiss: () => void;
  onCommand: (command: TerminalCommand) => void;
  /** False when the strip is full, so the drawer can say the pin was refused. */
  onTogglePin: (id: string) => boolean;
}

/**
 * Every key this session actually has a use for, and which of them ride above
 * the keyboard.
 *
 * Two modes rather than a second gesture. At rest a plate sends its key, which
 * is what the drawer is for; "Pin keys" turns the same plates into choices, so
 * customising the strip is a visible mode with a way out rather than a long
 * press nobody discovers.
 */
export function TerminalCommandsSheet({
  visible,
  kind,
  pinned,
  onDismiss,
  onCommand,
  onTogglePin,
}: TerminalCommandsSheetProps): React.JSX.Element {
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const groups = terminalCommandGroups(kind);

  // A drawer opened again is a fresh one: it must never come back mid-edit.
  useEffect(() => {
    if (!visible) setEditing(false);
  }, [visible]);

  const press = (command: TerminalCommand): void => {
    if (!editing) {
      onCommand(command);
      return;
    }
    if (onTogglePin(command.id)) haptics.selection();
    else haptics.warning();
  };

  const isPinned = (command: TerminalCommand): boolean => pinned.includes(command.id);

  return (
    <Sheet onDismiss={onDismiss} size="tall" visible={visible}>
      <SheetHeader
        action={
          <Button
            accessibilityLabel={editing ? "Finish pinning keys" : "Pin keys to the strip"}
            onPress={() => setEditing((current) => !current)}
            size="sm"
            testID="commands-pin-toggle"
            variant={editing ? "default" : "secondary"}
          >
            {editing ? "Done" : "Pin keys"}
          </Button>
        }
        title={`${agentLabel(kind)} keys`}
      />
      <SheetScrollView
        style={styles.scroller}
        contentContainerStyle={[
          styles.content,
          { gap: theme.space(4), paddingBottom: theme.space(4), paddingTop: theme.space(2) },
        ]}
      >
        {editing ? (
          <Text
            color="mutedForeground"
            style={{ paddingHorizontal: theme.space(4) }}
            testID="commands-pin-hint"
            variant="caption"
          >
            Choose the keys that sit above the keyboard.
          </Text>
        ) : null}
        {groups.map((group) => (
          <View key={group.id} style={[styles.group, { gap: theme.space(2) }]}>
            <Text
              color="mutedForeground"
              style={{ paddingHorizontal: theme.space(4) }}
              variant="micro"
            >
              {group.title}
            </Text>
            {group.presentation === "rows" ? (
              <View style={styles.rows}>
                {group.commands.map((command) => (
                  <CommandRow
                    command={command}
                    editing={editing}
                    key={command.id}
                    onPress={() => press(command)}
                    pinned={isPinned(command)}
                  />
                ))}
              </View>
            ) : (
              <View
                style={[styles.grid, { gap: theme.space(2), paddingHorizontal: theme.space(4) }]}
              >
                {group.commands.map((command) => (
                  <CommandCap
                    command={command}
                    editing={editing}
                    key={command.id}
                    onPress={() => press(command)}
                    pinned={isPinned(command)}
                  />
                ))}
              </View>
            )}
          </View>
        ))}
      </SheetScrollView>
    </Sheet>
  );
}

interface CommandControlProps {
  command: TerminalCommand;
  editing: boolean;
  pinned: boolean;
  onPress: () => void;
}

function pinLabel(command: TerminalCommand, editing: boolean, pinned: boolean): string {
  if (!editing) return command.label;
  return `${pinned ? "Unpin" : "Pin"} ${command.label}`;
}

function CommandCap({ command, editing, pinned, onPress }: CommandControlProps): React.JSX.Element {
  const marked = editing && pinned;
  return (
    <Button
      accessibilityLabel={pinLabel(command, editing, pinned)}
      accessibilityState={editing ? { checked: pinned } : {}}
      onPress={onPress}
      size="sm"
      style={styles.cap}
      testID={`command-cap-${command.id}`}
      variant={marked ? "default" : "secondary"}
    >
      <Text color={marked ? "primaryForeground" : "secondaryForeground"} variant="mono">
        {command.cap}
      </Text>
    </Button>
  );
}

function CommandRow({ command, editing, pinned, onPress }: CommandControlProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityLabel={pinLabel(command, editing, pinned)}
      accessibilityRole="button"
      accessibilityState={editing ? { checked: pinned } : {}}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? theme.colors.popoverAccent : "transparent",
          gap: theme.space(3),
        },
      ]}
      testID={`command-row-${command.id}`}
    >
      <View
        style={[
          styles.rowCap,
          {
            backgroundColor: theme.colors.secondary,
            borderColor: theme.colors.popoverBorder,
            borderRadius: theme.radii.sm,
            borderWidth: borderWidth.hairline,
          },
        ]}
      >
        <Text color="secondaryForeground" variant="mono">
          {command.cap}
        </Text>
      </View>
      <Text color="popoverForeground" style={styles.rowLabel} variant="uiBase">
        {command.label}
      </Text>
      {editing ? (
        <Icon
          color={pinned ? "primary" : "mutedForeground"}
          name={pinned ? "CheckCircle2" : "Circle"}
          size={sizing.actionSheet.icon}
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cap: {
    minWidth: sizing.terminalAccessory.keyMinWidth,
    paddingHorizontal: sizing.terminalAccessory.keyHorizontalPadding,
  },
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
  row: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: sizing.control.comfortableTouchTarget,
    paddingHorizontal: sizing.actionSheet.horizontalPadding,
    paddingVertical: sizing.space.peer,
  },
  rowCap: {
    alignItems: "center",
    justifyContent: "center",
    minWidth: sizing.terminalAccessory.keyMinWidth + sizing.terminalAccessory.keyHorizontalPadding,
    paddingHorizontal: sizing.space.peer,
    paddingVertical: sizing.space.tight,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
  },
  rows: {
    flexDirection: "column",
  },
  // The panel claims the available height, so the scroller has to take what the
  // header leaves rather than sizing itself to its content and overflowing it.
  scroller: {
    flex: 1,
  },
});
