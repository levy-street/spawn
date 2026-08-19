import type { Agent } from "@/lib/api";

export type AgentKind =
  | "codex"
  | "claude"
  | "opencode"
  | "aider"
  | "hermes"
  | "grok"
  | "shell"
  | "custom";

export function agentKind(agent: Agent): AgentKind {
  const binary = agent.argv[0]?.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (binary.includes("codex")) return "codex";
  if (binary.includes("claude")) return "claude";
  // Before `code`-ish matches: opencode contains "code", hermes and grok are
  // their own binaries.
  if (binary.includes("opencode")) return "opencode";
  if (binary.includes("aider")) return "aider";
  if (binary.includes("hermes")) return "hermes";
  if (binary.includes("grok")) return "grok";
  if (binary === "bash" || binary === "sh" || binary === "zsh" || binary === "fish") {
    return "shell";
  }
  return "custom";
}

export function agentKindLabel(kind: AgentKind): string {
  switch (kind) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude Code";
    case "opencode":
      return "OpenCode";
    case "aider":
      return "Aider";
    case "hermes":
      return "Hermes Agent";
    case "grok":
      return "Grok Build";
    case "shell":
      return "Shell";
    default:
      return "Custom";
  }
}

/**
 * Flags that mean "this agent does not stop to ask".
 *
 * Deliberately a display heuristic read off the *command that ran*, not off
 * how the agent was created — so a hand-typed `codex --yolo` under Advanced
 * options is marked exactly like one created with the toggle. The server owns
 * argv composition (`preset.yolo_argv`); this only decides whether to draw a
 * badge, and being over-inclusive here is much better than a gated and an
 * ungated agent looking identical.
 */
const AUTONOMY_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--yolo",
  "--yes-always",
  "--full-auto",
  "--dangerously-bypass-approvals-and-sandbox",
]);

export function isYoloArgv(argv: readonly string[]): boolean {
  return argv.some((arg) => AUTONOMY_FLAGS.has(arg));
}

export function agentTitle(agent: Agent): string {
  const name = agent.name?.trim();
  if (name) return name;
  const hostName = agent.host_name?.trim();
  if (hostName) return `${hostName} - ${lastCwdDir(agent.cwd)}`;
  const command = agent.argv.join(" ").trim();
  return command || agent.id.slice(0, 8);
}

function lastCwdDir(cwd: string): string {
  const trimmed = cwd.trim();
  const normalized = trimmed.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized) return trimmed || "/";
  return normalized.split("/").at(-1) || normalized;
}

export function agentCommand(agent: Agent): string {
  return agent.argv.join(" ").trim() || "(no argv)";
}

export function agentStatusLabel(agent: Agent): string {
  return agent.status.toUpperCase();
}

export function agentActivityLabel(agent: Agent): string {
  return agent.activity_label || agentStatusLabel(agent);
}

export function agentActivityDetail(agent: Agent): string {
  const label = agentActivityLabel(agent);
  const age = relativeTime(agent.last_activity_at);
  return age ? `${label} · ${age}` : label;
}

export function isAgentArchived(agent: Agent): boolean {
  return agent.archived_at !== null;
}

export function relativeTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Attention states a multi-pane screen should surface at a glance. */
export function agentNeedsAttention(agent: Agent): "waiting" | "dead" | null {
  if (agent.status === "exited" || agent.status === "killed") return "dead";
  if (agent.activity_state === "waiting") return "waiting";
  return null;
}
