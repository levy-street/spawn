import type { KeyModifiers, KeySpec, NamedTerminalKey } from "@/terminal/transport/types";

const NAMED_KEYS: Readonly<Record<NamedTerminalKey, string>> = {
  Escape: "\u001b",
  Tab: "\t",
  BackTab: "\u001b[Z",
  Enter: "\r",
  ShiftEnter: "\u001b\r",
  MobileReturn: "\u001b[200~\n\u001b[201~",
  Backspace: "\u007f",
  ArrowUp: "\u001b[A",
  ArrowDown: "\u001b[B",
  ArrowRight: "\u001b[C",
  ArrowLeft: "\u001b[D",
  Home: "\u001b[H",
  End: "\u001b[F",
  Insert: "\u001b[2~",
  Delete: "\u001b[3~",
  PageUp: "\u001b[5~",
  PageDown: "\u001b[6~",
  F1: "\u001bOP",
  F2: "\u001bOQ",
  F3: "\u001bOR",
  F4: "\u001bOS",
  F5: "\u001b[15~",
  F6: "\u001b[17~",
  F7: "\u001b[18~",
  F8: "\u001b[19~",
  F9: "\u001b[20~",
  F10: "\u001b[21~",
  F11: "\u001b[23~",
  F12: "\u001b[24~",
};

const CURSOR_SUFFIX: Partial<Record<NamedTerminalKey, string>> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

function ctrlCharacter(text: string): string | null {
  if (text === " " || text === "@") return "\0";
  if (text === "?") return "\u007f";
  if (text.length !== 1) return null;
  const code = text.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : null;
}

function modifierParameter(modifiers: KeyModifiers): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

function encodeNamed(key: NamedTerminalKey, modifiers: KeyModifiers, application: boolean): string {
  const cursorSuffix = CURSOR_SUFFIX[key];
  const modified = modifierParameter(modifiers);
  if (cursorSuffix && modified > 1) return `\u001b[1;${modified}${cursorSuffix}`;
  if (cursorSuffix && application) return `\u001bO${cursorSuffix}`;
  const sequence = NAMED_KEYS[key];
  return modifiers.alt && !cursorSuffix ? `\u001b${sequence}` : sequence;
}

/** Exact byte string for native terminal accessory keys. */
export function encodeKey(key: KeySpec): string {
  const modifiers = key.modifiers ?? {};
  if (key.kind === "named") {
    return encodeNamed(key.key, modifiers, key.applicationCursor ?? false);
  }

  let sequence = key.text;
  if (modifiers.ctrl) {
    const controlled = ctrlCharacter(sequence);
    if (controlled === null) return "";
    sequence = controlled;
  }
  return modifiers.alt && sequence.length > 0 ? `\u001b${sequence}` : sequence;
}
