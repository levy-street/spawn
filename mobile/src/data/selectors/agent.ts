import type { AgentDef, AgentIdentity, AgentLogoKey, Session } from "@/data/types/domain";

const SHELL_COMMANDS = new Set(["bash", "zsh", "fish", "sh", "dash", "powershell", "pwsh", "cmd"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * The daemon reports the kernel's own name for the foreground process, and on
 * Windows that carries the executable extension — "claude.exe", "pwsh.exe" —
 * which no agent definition or shell list spells out. Stripped before every
 * comparison so the same program reads the same on every platform.
 */
const WINDOWS_EXECUTABLE_SUFFIX = /\.(exe|com|bat|cmd|ps1)$/i;
const SAFE_SHELL_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Brand {
  kind: string;
  displayName: string;
  logoKey: AgentLogoKey;
}

const BRANDS: Array<{ needle: string; brand: Brand }> = [
  {
    needle: "claude",
    brand: { kind: "claude-code", displayName: "Claude Code", logoKey: "claude-code" },
  },
  { needle: "codex", brand: { kind: "codex", displayName: "Codex", logoKey: "codex" } },
  { needle: "opencode", brand: { kind: "opencode", displayName: "OpenCode", logoKey: "opencode" } },
  { needle: "aider", brand: { kind: "aider", displayName: "Aider Sonnet", logoKey: "aider" } },
  { needle: "hermes", brand: { kind: "hermes", displayName: "Hermes Agent", logoKey: "hermes" } },
];

export function commandBasename(command: string | null | undefined): string | null {
  const tokens = command?.trim().split(/\s+/).filter(Boolean) ?? [];
  const executable = tokens.find((token) => !ENV_ASSIGNMENT.test(token));
  if (!executable) return null;
  const normalized = executable.replace(/^-+/, "").split(/[\\/]/).pop()?.trim();
  return normalized || null;
}

/** The basename lowered and shorn of a Windows executable extension. */
function normalizedBasename(command: string | null | undefined): string | null {
  const basename = commandBasename(command)?.toLowerCase();
  return basename ? basename.replace(WINDOWS_EXECUTABLE_SUFFIX, "") : null;
}

export function isShellCommand(command: string | null | undefined): boolean {
  const basename = normalizedBasename(command);
  return basename ? SHELL_COMMANDS.has(basename) : false;
}

export function runningAgent(
  foregroundCommand: string | null,
  agents: readonly AgentDef[],
): AgentDef | null {
  const reported = normalizedBasename(foregroundCommand);
  if (!reported || SHELL_COMMANDS.has(reported)) return null;
  return agents.find((agent) => normalizedBasename(agent.command) === reported) ?? null;
}

/**
 * What kind of window this is: the agent it was opened as, else whatever its
 * foreground process says is running in it.
 *
 * The recorded type comes first because it is the durable answer. The
 * foreground is a snapshot of one process: it says "shell" for a window whose
 * agent has been quit or is between runs, and it names the interpreter rather
 * than the tool for any CLI that ships as a script — a Hermes window reports
 * "python3", which matches no agent's command and used to duplicate as a bare
 * shell. A window someone typed an agent into by hand has nothing recorded, so
 * the foreground is still asked.
 */
export function sessionAgent(
  session: Pick<Session, "foreground_command" | "agent_id"> | undefined,
  agents: readonly AgentDef[],
): AgentDef | null {
  const recorded = session?.agent_id;
  const known = recorded ? agents.find((agent) => agent.id === recorded) : undefined;
  // A recorded id no agent claims — a custom definition deleted since — is a
  // type nothing can launch any more, so the live process answers instead.
  return known ?? runningAgent(session?.foreground_command ?? null, agents);
}

function brandFor(value: string | null | undefined): Brand | null {
  const normalized = value?.toLowerCase() ?? "";
  return BRANDS.find(({ needle }) => normalized.includes(needle))?.brand ?? null;
}

export function identifyAgent(
  foregroundCommand: string | null,
  agents: readonly AgentDef[],
): AgentIdentity {
  const basename = commandBasename(foregroundCommand);
  if (!basename || isShellCommand(foregroundCommand)) {
    return { kind: "shell", displayName: "Shell", logoKey: "shell", monogramSeed: "Shell" };
  }

  const definition = runningAgent(foregroundCommand, agents);
  const brand = brandFor(definition?.kind) ?? brandFor(basename);
  if (brand) return { ...brand, monogramSeed: brand.displayName };

  const displayName = definition?.name.trim() || basename;
  return {
    kind: definition?.kind.trim() || basename.toLowerCase(),
    displayName,
    logoKey: null,
    monogramSeed: displayName,
  };
}

export function sortAgents(agents: readonly AgentDef[]): AgentDef[] {
  return [...agents].sort((a, b) => {
    const ownership = Number(a.owner_user_id !== null) - Number(b.owner_user_id !== null);
    return ownership || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function agentYoloAvailable(agent: AgentDef): boolean {
  return Boolean(agent.yolo_args?.trim()) || Object.keys(agent.yolo_env).length > 0;
}

function quoteShell(value: string): string {
  return SAFE_SHELL_VALUE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function envPrefix(env: Readonly<Record<string, string>>): string {
  const assignments = Object.entries(env)
    .filter(([key]) => SAFE_ENV_KEY.test(key))
    .map(([key, value]) => `${key}=${quoteShell(value)}`);
  return assignments.length > 0 ? `${assignments.join(" ")} ` : "";
}

export function agentRunCommand(agent: AgentDef): string {
  const useYolo = agent.yolo && agentYoloAvailable(agent);
  const env = useYolo ? { ...agent.env, ...agent.yolo_env } : agent.env;
  const args = useYolo ? agent.yolo_args?.trim() : "";
  return `${envPrefix(env)}${agent.command}${args ? ` ${args}` : ""}`;
}

export function agentInstallAndRunCommand(agent: AgentDef): string | null {
  const install = agent.install?.trim();
  return install ? `${install} && ${agentRunCommand(agent)}` : null;
}

export interface RunningAgentGroup {
  /** Stable identity of the group, for keys. */
  key: string;
  count: number;
  identity: AgentIdentity;
}

/**
 * What is running on a host, one entry per agent and most-first.
 *
 * Shells are kept rather than dropped: on a phone the answer "four shells" is
 * as much of an answer as "two Claude", and a host row that showed nothing for
 * a machine with work on it would read as idle.
 *
 * Ties break by name so the row does not reshuffle between polls.
 */
export function groupRunningAgents(
  sessions: readonly Session[],
  agents: readonly AgentDef[],
): RunningAgentGroup[] {
  const groups = new Map<string, RunningAgentGroup>();
  for (const session of sessions) {
    const identity = identifyAgent(session.foreground_command, agents);
    const key = `${identity.logoKey ?? "custom"}:${identity.kind}:${identity.displayName}`;
    const current = groups.get(key);
    groups.set(key, { key, identity, count: (current?.count ?? 0) + 1 });
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.count - left.count ||
      left.identity.displayName.localeCompare(right.identity.displayName),
  );
}

/**
 * How an agent CLI names a conversation, by agent kind. Every tool spells it
 * differently, and most have no spelling at all: a launch that can be handed
 * an id up front is what lets a later restart come back to the same thread.
 * The same grammar the web app types, spelled once per client.
 */
export interface AgentConversationGrammar {
  /** Flags that start a fresh conversation under an id SPAWN D chose. Null
   *  when the CLI names its own conversations. */
  launch: ((conversationId: string) => string) | null;
  /** Flags that reopen a known conversation. Null when the CLI cannot. */
  resume: ((conversationId: string) => string) | null;
  /** Flags that reopen the most recent conversation in this folder, for a
   *  window whose conversation id was never recorded. Null when it cannot. */
  continueLatest: string | null;
}

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
export function newAgentConversationId(
  kind: string | null | undefined,
  randomUUID: () => string,
): string | null {
  return agentConversationGrammar(kind)?.launch ? randomUUID() : null;
}

/**
 * What starting an agent types when the window is to remember its
 * conversation: the run command with the id the CLI is told to use. Without
 * a grammar for the kind, or without an id, exactly the run command.
 */
export function agentLaunchCommand(agent: AgentDef, conversationId: string | null): string {
  const run = agentRunCommand(agent);
  const launch = agentConversationGrammar(agent.kind)?.launch;
  return launch && conversationId ? `${run} ${launch(conversationId)}` : run;
}

/** `install && launch`, or null when the agent has no install command. */
export function agentInstallAndLaunchCommand(
  agent: AgentDef,
  conversationId: string | null,
): string | null {
  const install = agent.install?.trim();
  return install ? `${install} && ${agentLaunchCommand(agent, conversationId)}` : null;
}

/**
 * What a restart types to bring the agent back where it was: resume the
 * recorded conversation, or the latest one in this folder when none was
 * recorded. Null when this kind of agent cannot be resumed at all, so the
 * caller falls back to a plain relaunch and says so.
 */
export function agentResumeCommand(agent: AgentDef, conversationId: string | null): string | null {
  const grammar = agentConversationGrammar(agent.kind);
  if (!grammar) return null;
  const run = agentRunCommand(agent);
  if (conversationId && grammar.resume) return `${run} ${grammar.resume(conversationId)}`;
  if (grammar.continueLatest) return `${run} ${grammar.continueLatest}`;
  return null;
}

/**
 * What a restart of this window promises, for the row that offers it: the
 * agent back in its conversation where the CLI can resume one, a plain
 * relaunch where it cannot, the login shell for a shell window.
 */
export function restartDetail(
  session: Pick<Session, "foreground_command" | "agent_id"> | undefined,
  agents: readonly AgentDef[],
): string {
  const agent = sessionAgent(session, agents);
  if (!agent) return "Restart the login shell";
  return agentCanResume(agent.kind)
    ? `Relaunch ${agent.name} and resume its conversation`
    : `Relaunch ${agent.name}`;
}
