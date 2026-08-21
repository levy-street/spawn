import type { Agent } from "@/lib/api";

/**
 * Pure command construction for the agent switcher (§5.5). Everything the
 * switcher types into the PTY is built here so it can be unit-tested
 * byte-for-byte: env dicts become `KEY=value ` prefixes with shell-quoted
 * values, and missing agents get a fully visible `install && run` compound.
 *
 * Yolo mode folds in here rather than at each call site, so every way of
 * starting an agent — the switcher, the new-session menus, a template replay —
 * types the same thing.
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

/**
 * The yolo half of a definition. Optional throughout: callers hand this
 * around as `Pick<Agent, …>` slices, and an agent from an older payload
 * simply has no yolo mode.
 */
export type AgentYolo = {
  yolo?: boolean;
  yolo_args?: string | null;
  yolo_env?: Record<string, string> | null;
};

/**
 * Whether this agent has a way to skip its permission prompts at all. Some
 * CLIs take a flag, opencode only reads an environment variable, and a custom
 * agent has whatever its owner typed — nothing, usually. The toggle is not
 * offered when this is false, rather than left dead.
 */
export function agentYoloAvailable(agent: AgentYolo): boolean {
  return Boolean(agent.yolo_args?.trim()) || Object.keys(agent.yolo_env ?? {}).length > 0;
}

/** Whether this agent will actually launch in yolo mode. */
function yoloOn(agent: AgentYolo): boolean {
  return agent.yolo === true && agentYoloAvailable(agent);
}

/**
 * What picking an installed agent types (before the newline).
 *
 * In yolo mode the agent's `yolo_env` is merged over its own environment and
 * `yolo_args` appended to the command. Both are visible in the terminal like
 * everything else the switcher types: turning permission prompts off is not
 * something that should happen where the user cannot read it.
 */
export function agentRunCommand(agent: Pick<Agent, "command" | "env"> & AgentYolo): string {
  const yolo = yoloOn(agent);
  const env = yolo ? { ...agent.env, ...(agent.yolo_env ?? {}) } : agent.env;
  const args = yolo ? agent.yolo_args?.trim() : "";
  return `${envPrefix(env)}${agent.command}${args ? ` ${args}` : ""}`;
}

/**
 * What picking a missing agent types: the install command, visibly chained
 * into the run command. Null when the agent has no install command (the menu
 * then falls back to the plain run command, letting the shell report
 * command-not-found honestly).
 */
export function agentInstallAndRunCommand(
  agent: Pick<Agent, "command" | "env" | "install"> & AgentYolo,
): string | null {
  const install = agent.install?.trim();
  if (!install) return null;
  return `${install} && ${agentRunCommand(agent)}`;
}
