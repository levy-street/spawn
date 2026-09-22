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
  agent: Pick<Agent, "command" | "env" | "install"> & Partial<Pick<Agent, "kind">> & AgentYolo,
  conversationId: string | null = null,
): string | null {
  const install = agent.install?.trim();
  if (!install) return null;
  return `${install} && ${agentLaunchCommand(agent, conversationId)}`;
}

/**
 * How an agent CLI names a conversation, by agent kind. Every tool spells it
 * differently, and most have no spelling at all: a launch that can be handed
 * an id up front is what lets a later restart come back to the same thread.
 */
export type AgentConversationGrammar = {
  /** Flags that start a fresh conversation under an id SPAWN D chose. Null when
   *  the CLI names its own conversations. */
  launch: ((conversationId: string) => string) | null;
  /** Flags that reopen a known conversation. Null when the CLI cannot. */
  resume: ((conversationId: string) => string) | null;
  /** Flags that reopen the most recent conversation in this folder, for a
   *  window whose conversation id was never recorded. Null when the CLI cannot. */
  continueLatest: string | null;
};

const CONVERSATION_GRAMMARS: Readonly<Record<string, AgentConversationGrammar>> = {
  "claude-code": {
    launch: (id) => `--session-id ${id}`,
    resume: (id) => `--resume ${id}`,
    continueLatest: "--continue",
  },
  // Codex names its own sessions and takes `resume` as a subcommand after the
  // global flags, so only "the latest one here" can be asked for.
  codex: {
    launch: null,
    resume: null,
    continueLatest: "resume --last",
  },
};

/** The conversation grammar for an agent kind, or null for a CLI SPAWN D
 *  knows no way to resume. */
export function agentConversationGrammar(
  kind: string | null | undefined,
): AgentConversationGrammar | null {
  return (kind && CONVERSATION_GRAMMARS[kind.trim().toLowerCase()]) || null;
}

/** Whether a window of this kind can be brought back to its conversation at all. */
export function agentCanResume(kind: string | null | undefined): boolean {
  const grammar = agentConversationGrammar(kind);
  return Boolean(grammar && (grammar.resume || grammar.continueLatest));
}

/**
 * A fresh conversation id for a launch, or null for a CLI that cannot be
 * handed one. UUIDs: what every agent that takes an id expects, and safe to
 * type at a prompt bare.
 */
export function newAgentConversationId(kind: string | null | undefined): string | null {
  return agentConversationGrammar(kind)?.launch ? crypto.randomUUID() : null;
}

/**
 * What starting an agent types when the window is to remember its
 * conversation: the run command with the id the CLI is told to use. Without a
 * grammar for the kind, or without an id, exactly the run command.
 */
export function agentLaunchCommand(
  agent: Pick<Agent, "command" | "env"> & Partial<Pick<Agent, "kind">> & AgentYolo,
  conversationId: string | null,
): string {
  const run = agentRunCommand(agent);
  const launch = agentConversationGrammar(agent.kind)?.launch;
  return launch && conversationId ? `${run} ${launch(conversationId)}` : run;
}

/**
 * What a restart types to bring the agent back where it was: resume the
 * recorded conversation, or the latest one in this folder when none was
 * recorded. Null when this kind of agent cannot be resumed at all, so the
 * caller falls back to a plain relaunch and says so.
 */
export function agentResumeCommand(
  agent: Pick<Agent, "command" | "env"> & Partial<Pick<Agent, "kind">> & AgentYolo,
  conversationId: string | null,
): string | null {
  const grammar = agentConversationGrammar(agent.kind);
  if (!grammar) return null;
  const run = agentRunCommand(agent);
  if (conversationId && grammar.resume) return `${run} ${grammar.resume(conversationId)}`;
  if (grammar.continueLatest) return `${run} ${grammar.continueLatest}`;
  return null;
}
