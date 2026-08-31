/**
 * Pure identity resolution for agents and running commands: which brand mark
 * to draw, and what to call the thing in prose. Lives in `lib` so both the
 * icon component and the session-title helpers can read it.
 */
const SHELL_RE = /^(bash|zsh|fish|sh|dash|powershell|pwsh|cmd)$/;

/**
 * The daemon reports the kernel's own name for the foreground process, and on
 * Windows that carries the executable extension — "claude.exe", "pwsh.exe" —
 * which no agent definition or shell list spells out. Strip it before any
 * comparison so the same program reads the same on every platform.
 */
export function stripExecutableSuffix(name: string): string {
  return name.replace(/\.(exe|com|bat|cmd|ps1)$/i, "");
}

export type ResolvedAgentIcon = {
  icon: "claude-code" | "codex" | "opencode" | "aider" | "shell" | "monogram";
  /** Tooltip / accessible name: brand name, shell name, or the raw input. */
  label: string;
  /** Monogram letter (only for `icon: "monogram"`). */
  letter?: string;
};

/** First non-`KEY=value` token of a command string, path stripped. */
export function commandBasename(command: string): string {
  const token = command
    .trim()
    .split(/\s+/)
    .find((part) => part !== "" && !part.includes("="));
  return token?.split(/[\\/]/).at(-1) ?? "";
}

function matchName(name: string): ResolvedAgentIcon | null {
  const lower = stripExecutableSuffix(name.toLowerCase());
  if (lower.includes("claude")) return { icon: "claude-code", label: "Claude Code" };
  if (lower.includes("codex")) return { icon: "codex", label: "Codex" };
  if (lower.includes("opencode")) return { icon: "opencode", label: "OpenCode" };
  if (lower.includes("aider")) return { icon: "aider", label: "Aider" };
  if (SHELL_RE.test(lower)) return { icon: "shell", label: lower };
  return null;
}

export function resolveAgentIcon(kind?: string | null, command?: string | null): ResolvedAgentIcon {
  const fromKind = kind?.trim() ? matchName(kind.trim()) : null;
  if (fromKind) return fromKind;
  const basename = command ? commandBasename(command) : "";
  const fromCommand = basename ? matchName(basename) : null;
  if (fromCommand) return fromCommand;
  const raw = kind?.trim() || basename;
  // Nothing reported at all means the worker has not seen a foreground
  // process yet — by the same convention as `sessionAtShell`, that is a
  // shell prompt, not an unknown app.
  if (!raw) return { icon: "shell", label: "Shell" };
  const letter = raw.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? "?";
  return { icon: "monogram", label: raw, letter };
}

/**
 * What to call a running command in prose: the brand name when the command is
 * a known agent, else whatever the daemon reported. Keeps version-named
 * executables and bare basenames from showing up in sentences.
 */
export function agentDisplayName(command?: string | null): string {
  return resolveAgentIcon(null, command).label;
}
