import type { KeyModifiers, KeySpec } from "@/terminal/transport/types";

export type ModifierName = "ctrl" | "alt";
export type ModifierMode = "off" | "armed" | "locked";

export interface ModifierValue {
  mode: ModifierMode;
  lastTapAt: number | null;
}

export interface ModifierState {
  ctrl: ModifierValue;
  alt: ModifierValue;
}

export type ModifierEvent =
  | { type: "tap"; modifier: ModifierName; now: number }
  | { type: "long-press"; modifier: ModifierName }
  | { type: "key-sent" }
  | { type: "timeout" }
  | { type: "blur" }
  | { type: "session-changed" };

export const MODIFIER_DOUBLE_TAP_MS = 300;
export const MODIFIER_ARM_TIMEOUT_MS = 10_000;

const OFF: ModifierValue = { mode: "off", lastTapAt: null };

export const INITIAL_MODIFIER_STATE: ModifierState = {
  ctrl: OFF,
  alt: OFF,
};

function tapped(value: ModifierValue, now: number): ModifierValue {
  if (value.mode === "locked") return OFF;
  if (
    value.mode === "armed" &&
    value.lastTapAt !== null &&
    now - value.lastTapAt <= MODIFIER_DOUBLE_TAP_MS
  ) {
    return { mode: "locked", lastTapAt: null };
  }
  if (value.mode === "armed") return OFF;
  return { mode: "armed", lastTapAt: now };
}

function clearArmed(value: ModifierValue): ModifierValue {
  return value.mode === "armed" ? OFF : value;
}

export function reduceModifierState(state: ModifierState, event: ModifierEvent): ModifierState {
  switch (event.type) {
    case "tap":
      return { ...state, [event.modifier]: tapped(state[event.modifier], event.now) };
    case "long-press":
      return {
        ...state,
        [event.modifier]: { mode: "locked", lastTapAt: null },
      };
    case "key-sent":
      return { ctrl: clearArmed(state.ctrl), alt: clearArmed(state.alt) };
    case "timeout":
    case "blur":
      return { ctrl: clearArmed(state.ctrl), alt: clearArmed(state.alt) };
    case "session-changed":
      return INITIAL_MODIFIER_STATE;
  }
}

export function activeKeyModifiers(state: ModifierState): KeyModifiers {
  return {
    ...(state.ctrl.mode === "off" ? {} : { ctrl: true }),
    ...(state.alt.mode === "off" ? {} : { alt: true }),
  };
}

export function withActiveModifiers(state: ModifierState, key: KeySpec): KeySpec {
  const active = activeKeyModifiers(state);
  const modifiers = { ...active, ...key.modifiers };
  return key.kind === "text"
    ? { kind: "text", text: key.text, modifiers }
    : {
        kind: "named",
        key: key.key,
        modifiers,
        ...(key.applicationCursor === undefined
          ? {}
          : { applicationCursor: key.applicationCursor }),
      };
}

export function hasArmedModifier(state: ModifierState): boolean {
  return state.ctrl.mode === "armed" || state.alt.mode === "armed";
}
