import type { Agent } from "@/lib/api";

/**
 * Pure command construction for the agent shortcut bar (§5.5). Everything the
 * bar types into the PTY is built here so it can be unit-tested byte-for-byte:
 * env dicts become `KEY=value ` prefixes with shell-quoted values, and missing
 * agents get a fully visible `install && run` compound.
 */

/** Characters that never need quoting in a POSIX shell word. */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Single-quote a value for POSIX shells; safe words pass through bare. */
export function shellQuote(value: string): string {
  if (value !== "" && SAFE_WORD.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `KEY=value ` prefix string (trailing space included when non-empty) in the
 * dict's own order. Keys that aren't valid shell identifiers are dropped —
 * there is no way to type them safely.
 */
export function envPrefix(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([key]) => ENV_KEY.test(key))
    .map(([key, value]) => `${key}=${shellQuote(value)} `)
    .join("");
}

/** What clicking an installed agent pill types (before the newline). */
export function agentRunCommand(agent: Pick<Agent, "command" | "env">): string {
  return `${envPrefix(agent.env)}${agent.command}`;
}

/**
 * What clicking a missing agent's "install & run" pill types: the install
 * command, visibly chained into the run command. Null when the agent has no
 * install command (the pill then falls back to the plain run command, letting
 * the shell report command-not-found honestly).
 */
export function agentInstallAndRunCommand(
  agent: Pick<Agent, "command" | "env" | "install">,
): string | null {
  const install = agent.install?.trim();
  if (!install) return null;
  return `${install} && ${agentRunCommand(agent)}`;
}
