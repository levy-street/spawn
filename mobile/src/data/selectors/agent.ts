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
