import { commandBasename, isShellCommand } from "@/data/selectors/agent";
import type { KeySpec, NamedTerminalKey } from "@/terminal/transport/types";

/**
 * Which key list a session gets.
 *
 * Coding agents are not terminals with a prompt: the keys that matter in one are
 * its own — cycle the permission mode, interrupt the turn, open the slash menu —
 * and they differ per agent. "agent" is anything running that we do not know by
 * name; "shell" is a bare prompt.
 */
export type TerminalAgentKind = "claude-code" | "codex" | "opencode" | "aider" | "agent" | "shell";

export interface TerminalCommand {
  /** Stable across releases: a pinned choice is stored by this. */
  id: string;
  /** What a key plate shows. Short — it sits on a 36pt cap above the keyboard. */
  cap: string;
  /** What the drawer calls it: what it does, not which key it is. */
  label: string;
  spec: KeySpec;
  /**
   * Presses, not bytes. Claude Code and Codex both rewind on a *double* Escape,
   * which their input readers only see as two presses if the bytes arrive apart —
   * one packet of two escapes reads as a single modified key instead.
   */
  presses?: number;
}

export interface TerminalCommandGroup {
  id: string;
  title: string;
  /** Rows name what a key does; caps are a bare grid of plates. */
  presentation: "rows" | "caps";
  commands: readonly TerminalCommand[];
}

/** How far apart repeated presses are sent, so a reader sees two of them. */
export const REPEAT_PRESS_GAP_MS = 60;

function named(key: NamedTerminalKey, cap: string, label: string): TerminalCommand {
  return { id: `key-${key}`, cap, label, spec: { kind: "named", key } };
}

function ctrl(letter: string, label: string): TerminalCommand {
  return {
    id: `ctrl-${letter}`,
    cap: `⌃${letter.toUpperCase()}`,
    label,
    spec: { kind: "text", text: letter, modifiers: { ctrl: true } },
  };
}

function literal(text: string, label: string): TerminalCommand {
  return { id: `text-${text}`, cap: text, label, spec: { kind: "text", text } };
}

function doubleEscape(label: string): TerminalCommand {
  return {
    id: "esc-esc",
    cap: "esc esc",
    label,
    spec: { kind: "named", key: "Escape" },
    presses: 2,
  };
}

const ESCAPE = named("Escape", "esc", "Interrupt");
const CYCLE_MODE = named("BackTab", "⇧⇥", "Cycle mode");
const NEWLINE = named("ShiftEnter", "⇧↵", "Newline");
const SLASH = literal("/", "Slash command");
const MENTION = literal("@", "Mention a file");

/**
 * Per agent, only what an operator actually reaches for on a phone.
 *
 * The list this replaced was every key the encoder could name — twelve function
 * keys, Insert, a symbol rank — which is a keyboard reference rather than a set
 * of choices. Nothing here is included because it exists; each entry is a thing
 * people do several times an hour in that agent.
 */
const AGENT_COMMANDS: Readonly<Record<TerminalAgentKind, readonly TerminalCommand[]>> = {
  "claude-code": [
    ESCAPE,
    CYCLE_MODE,
    doubleEscape("Edit previous"),
    SLASH,
    MENTION,
    NEWLINE,
    ctrl("t", "Todo list"),
    literal("!", "Bash command"),
  ],
  codex: [
    ESCAPE,
    named("BackTab", "⇧⇥", "Cycle approval"),
    doubleEscape("Edit previous"),
    SLASH,
    MENTION,
    NEWLINE,
    ctrl("t", "Transcript"),
  ],
  opencode: [ESCAPE, CYCLE_MODE, SLASH, MENTION, NEWLINE, ctrl("c", "Stop")],
  aider: [SLASH, ESCAPE, NEWLINE, ctrl("c", "Stop"), ctrl("l", "Clear screen")],
  agent: [ESCAPE, CYCLE_MODE, SLASH, MENTION, NEWLINE, ctrl("c", "Stop")],
  shell: [
    named("Tab", "⇥", "Complete"),
    ctrl("c", "Stop"),
    ctrl("d", "End of input"),
    ctrl("r", "Search history"),
    ctrl("l", "Clear screen"),
    ctrl("z", "Suspend"),
  ],
};

/** Held apart from the rest: arrows read as a cluster, so they are never thinned. */
const ARROW_COMMANDS: readonly TerminalCommand[] = [
  named("ArrowUp", "↑", "Up"),
  named("ArrowDown", "↓", "Down"),
  named("ArrowLeft", "←", "Left"),
  named("ArrowRight", "→", "Right"),
];

const SHARED_GROUPS: readonly TerminalCommandGroup[] = [
  {
    id: "control",
    title: "CONTROL",
    presentation: "caps",
    commands: [
      ctrl("c", "Stop"),
      ctrl("d", "End of input"),
      ctrl("z", "Suspend"),
      ctrl("l", "Clear screen"),
      ctrl("r", "Search history"),
    ],
  },
  {
    id: "line",
    title: "EDIT LINE",
    presentation: "caps",
    commands: [
      ctrl("a", "Line start"),
      ctrl("e", "Line end"),
      ctrl("u", "Clear line"),
      ctrl("k", "Clear to end"),
      ctrl("w", "Delete word"),
    ],
  },
  {
    id: "move",
    title: "MOVE",
    presentation: "caps",
    commands: [
      named("Tab", "⇥", "Tab"),
      named("BackTab", "⇧⇥", "Shift Tab"),
      named("Home", "Home", "Home"),
      named("End", "End", "End"),
      named("PageUp", "PgUp", "Page up"),
      named("PageDown", "PgDn", "Page down"),
    ],
  },
  {
    // Only the ones an iOS keyboard buries two layers deep. Anything reachable
    // from the number row is a plate that earns nothing.
    id: "symbols",
    title: "SYMBOLS",
    presentation: "caps",
    commands: [
      literal("|", "Pipe"),
      literal("\\", "Backslash"),
      literal("~", "Tilde"),
      literal("_", "Underscore"),
      literal("^", "Caret"),
      literal("`", "Backtick"),
    ],
  },
];

const AGENT_LABELS: Readonly<Record<TerminalAgentKind, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  aider: "Aider",
  agent: "Agent",
  shell: "Shell",
};

export function agentKindFor(command: string | null): TerminalAgentKind {
  const normalized = command?.toLowerCase() ?? "";
  if (normalized.includes("claude")) return "claude-code";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("opencode")) return "opencode";
  if (normalized.includes("aider")) return "aider";
  if (commandBasename(command) === null || isShellCommand(command)) return "shell";
  return "agent";
}

export function agentLabel(kind: TerminalAgentKind): string {
  return AGENT_LABELS[kind];
}

/**
 * The whole sheet for one agent: its own commands first, then the shared plates
 * with anything already named above dropped, so nothing appears twice.
 */
export function terminalCommandGroups(kind: TerminalAgentKind): readonly TerminalCommandGroup[] {
  const agent = AGENT_COMMANDS[kind];
  const claimed = new Set(agent.map((command) => command.id));
  const shared = SHARED_GROUPS.map((group) => ({
    ...group,
    commands: group.commands.filter((command) => !claimed.has(command.id)),
  })).filter((group) => group.commands.length > 0);

  return [
    { id: "agent", title: AGENT_LABELS[kind].toUpperCase(), presentation: "rows", commands: agent },
    { id: "arrows", title: "ARROWS", presentation: "caps", commands: ARROW_COMMANDS },
    ...shared,
  ];
}

export function terminalCommandsFor(kind: TerminalAgentKind): readonly TerminalCommand[] {
  const seen = new Map<string, TerminalCommand>();
  for (const group of terminalCommandGroups(kind)) {
    for (const command of group.commands) {
      if (!seen.has(command.id)) seen.set(command.id, command);
    }
  }
  return [...seen.values()];
}

/** Pinned ids to commands, in the order they were pinned. Unknown ids drop out. */
export function resolvePinnedCommands(
  kind: TerminalAgentKind,
  pinned: readonly string[],
): readonly TerminalCommand[] {
  const available = new Map(terminalCommandsFor(kind).map((command) => [command.id, command]));
  return pinned
    .map((id) => available.get(id))
    .filter((command): command is TerminalCommand => command !== undefined);
}
