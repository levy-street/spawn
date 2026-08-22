import { useEffect, useReducer, useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, View } from "react-native";
import {
  KeyboardController,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  hasArmedModifier,
  INITIAL_MODIFIER_STATE,
  MODIFIER_ARM_TIMEOUT_MS,
  type ModifierName,
  type ModifierState,
  reduceModifierState,
  withActiveModifiers,
} from "@/components/terminal-ui/modifier-state";
import { TerminalKeysSheet } from "@/components/terminal-ui/terminal-keys-sheet";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { encodeKey } from "@/terminal/key-encoder";
import type { KeySpec } from "@/terminal/transport/types";
import { borderWidth, chrome, useTheme } from "@/theme";

type KeyEncoder = (key: KeySpec) => string;

export interface ResolvedAccessoryKey {
  spec: KeySpec;
  sequence: string;
}

export function resolveAccessoryKey(
  state: ModifierState,
  key: KeySpec,
  encoder: KeyEncoder = encodeKey,
): ResolvedAccessoryKey {
  const spec = withActiveModifiers(state, key);
  return { spec, sequence: encoder(spec) };
}

interface KeyCapProps {
  label: string;
  accessibilityLabel?: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  testID?: string;
}

function KeyCap({
  label,
  accessibilityLabel,
  active = false,
  disabled = false,
  onPress,
  onLongPress,
  testID,
}: KeyCapProps): React.JSX.Element {
  const theme = useTheme();
  const longPressed = useRef(false);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
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
      style={({ pressed }) => [
        styles.key,
        {
          backgroundColor: active
            ? theme.colors.primary
            : pressed
              ? theme.colors.accent
              : theme.colors.secondary,
          borderColor: active ? theme.colors.primary : theme.colors.border,
          borderRadius: theme.radii.md,
          borderWidth: borderWidth.hairline,
          minHeight: chrome.touchTarget,
          minWidth: chrome.touchTarget,
          opacity: disabled ? 0.5 : 1,
          paddingHorizontal: theme.space(2.5),
        },
      ]}
      {...(testID === undefined ? {} : { testID })}
    >
      <Text color={active ? "primaryForeground" : "foreground"} variant="mono">
        {label}
      </Text>
    </Pressable>
  );
}

export interface ModifierBarProps {
  sessionId: string;
  disabled?: boolean;
  onSend: (sequence: string, spec: KeySpec) => void;
  onPaste: () => void;
  onDismissKeyboard: () => void;
  encode?: KeyEncoder;
}

function modifierAccessibilityLabel(name: ModifierName, state: ModifierState): string {
  const spokenName = name === "ctrl" ? "Control" : "Alt";
  return `${spokenName}, ${state[name].mode}`;
}

export function ModifierBar({
  sessionId,
  disabled = false,
  onSend,
  onPaste,
  onDismissKeyboard,
  encode = encodeKey,
}: ModifierBarProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const [state, dispatch] = useReducer(reduceModifierState, INITIAL_MODIFIER_STATE);
  const [moreVisible, setMoreVisible] = useState(false);
  const previousSessionId = useRef(sessionId);

  useEffect(() => {
    if (previousSessionId.current === sessionId) return;
    previousSessionId.current = sessionId;
    dispatch({ type: "session-changed" });
  }, [sessionId]);

  useEffect(() => {
    if (!hasArmedModifier(state)) return undefined;
    const timer = setTimeout(() => dispatch({ type: "timeout" }), MODIFIER_ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const send = (key: KeySpec, impact: "selection" | "light" = "selection"): void => {
    const resolved = resolveAccessoryKey(state, key, encode);
    if (resolved.sequence.length === 0) {
      haptics.warning();
      return;
    }
    if (impact === "light") haptics.impact("light");
    else haptics.selection();
    onSend(resolved.sequence, resolved.spec);
    dispatch({ type: "key-sent" });
  };

  const toggleModifier = (modifier: ModifierName): void => {
    haptics.selection();
    dispatch({ type: "tap", modifier, now: Date.now() });
  };

  const lockModifier = (modifier: ModifierName): void => {
    haptics.impact("medium");
    dispatch({ type: "long-press", modifier });
  };

  const dismissKeyboard = (): void => {
    dispatch({ type: "blur" });
    onDismissKeyboard();
    void KeyboardController.dismiss().catch(() => Keyboard.dismiss());
  };

  const keyDisabled = disabled;
  return (
    <>
      <KeyboardStickyView
        offset={{ closed: 0, opened: 0 }}
        style={[
          styles.sticky,
          {
            backgroundColor: theme.colors.background,
            borderTopColor: theme.colors.border,
            borderTopWidth: borderWidth.hairline,
            paddingBottom: keyboardVisible
              ? theme.space(1)
              : Math.max(insets.bottom, theme.space(1)),
            paddingTop: theme.space(1),
          },
        ]}
        testID="terminal-modifier-bar"
      >
        <View style={[styles.row, { gap: theme.space(1), paddingHorizontal: theme.space(1) }]}>
          <ScrollView
            bounces={false}
            contentContainerStyle={[styles.scrollContent, { gap: theme.space(1) }]}
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
          >
            <KeyCap disabled={keyDisabled} label="Paste" onPress={onPaste} />
            <KeyCap
              disabled={keyDisabled}
              label="Esc"
              onPress={() => send({ kind: "named", key: "Escape" })}
            />
            <KeyCap
              accessibilityLabel="Tab, hold for Shift Tab"
              disabled={keyDisabled}
              label="Tab"
              onLongPress={() => send({ kind: "named", key: "BackTab" })}
              onPress={() => send({ kind: "named", key: "Tab" })}
            />
            <KeyCap
              accessibilityLabel={modifierAccessibilityLabel("ctrl", state)}
              active={state.ctrl.mode !== "off"}
              disabled={keyDisabled}
              label={state.ctrl.mode === "locked" ? "Ctrl ⌑" : "Ctrl"}
              onLongPress={() => lockModifier("ctrl")}
              onPress={() => toggleModifier("ctrl")}
              testID="modifier-ctrl"
            />
            <KeyCap
              accessibilityLabel={modifierAccessibilityLabel("alt", state)}
              active={state.alt.mode !== "off"}
              disabled={keyDisabled}
              label={state.alt.mode === "locked" ? "Alt ⌑" : "Alt"}
              onLongPress={() => lockModifier("alt")}
              onPress={() => toggleModifier("alt")}
              testID="modifier-alt"
            />
            <KeyCap
              accessibilityLabel="Control C"
              disabled={keyDisabled}
              label="^C"
              onPress={() => send({ kind: "text", text: "c", modifiers: { ctrl: true } }, "light")}
            />
            <KeyCap
              accessibilityLabel="Control D"
              disabled={keyDisabled}
              label="^D"
              onPress={() => send({ kind: "text", text: "d", modifiers: { ctrl: true } }, "light")}
            />
            <KeyCap
              accessibilityLabel="Control Z"
              disabled={keyDisabled}
              label="^Z"
              onPress={() => send({ kind: "text", text: "z", modifiers: { ctrl: true } }, "light")}
            />
            <KeyCap
              accessibilityLabel="Control L"
              disabled={keyDisabled}
              label="^L"
              onPress={() => send({ kind: "text", text: "l", modifiers: { ctrl: true } })}
            />
            <KeyCap
              accessibilityLabel="Control R"
              disabled={keyDisabled}
              label="^R"
              onPress={() => send({ kind: "text", text: "r", modifiers: { ctrl: true } })}
            />
            <KeyCap
              accessibilityLabel="Arrow up"
              disabled={keyDisabled}
              label="↑"
              onLongPress={() => send({ kind: "named", key: "PageUp" })}
              onPress={() => send({ kind: "named", key: "ArrowUp" })}
            />
            <KeyCap
              accessibilityLabel="Arrow down"
              disabled={keyDisabled}
              label="↓"
              onLongPress={() => send({ kind: "named", key: "PageDown" })}
              onPress={() => send({ kind: "named", key: "ArrowDown" })}
            />
            <KeyCap
              accessibilityLabel="Arrow left"
              disabled={keyDisabled}
              label="←"
              onLongPress={() => send({ kind: "named", key: "Home" })}
              onPress={() => send({ kind: "named", key: "ArrowLeft" })}
            />
            <KeyCap
              accessibilityLabel="Arrow right"
              disabled={keyDisabled}
              label="→"
              onLongPress={() => send({ kind: "named", key: "End" })}
              onPress={() => send({ kind: "named", key: "ArrowRight" })}
            />
            {(["|", "/", "-", "~"] as const).map((symbol) => (
              <KeyCap
                disabled={keyDisabled}
                key={symbol}
                label={symbol}
                onPress={() => send({ kind: "text", text: symbol })}
              />
            ))}
            <KeyCap disabled={keyDisabled} label="More" onPress={() => setMoreVisible(true)} />
            <Pressable
              accessibilityLabel="Dismiss keyboard"
              accessibilityRole="button"
              onPress={dismissKeyboard}
              style={[styles.dismiss, { height: chrome.touchTarget, width: chrome.touchTarget }]}
            >
              <Icon color="mutedForeground" name="ChevronDown" size={theme.space(4)} />
            </Pressable>
          </ScrollView>
          <KeyCap
            accessibilityLabel="Send"
            disabled={keyDisabled}
            label="Send"
            onPress={() => send({ kind: "named", key: "Enter" }, "light")}
            testID="modifier-send"
          />
        </View>
      </KeyboardStickyView>
      <TerminalKeysSheet
        onDismiss={() => setMoreVisible(false)}
        onKey={send}
        visible={moreVisible}
      />
    </>
  );
}

const styles = StyleSheet.create({
  dismiss: {
    alignItems: "center",
    justifyContent: "center",
  },
  key: {
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
  },
  scrollContent: {
    alignItems: "center",
  },
  sticky: {
    width: "100%",
  },
});
