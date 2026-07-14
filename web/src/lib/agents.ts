import type { Agent } from "@/lib/api";

export type AgentKind = "codex" | "claude" | "opencode" | "aider" | "shell" | "custom";

export function agentKind(agent: Agent): AgentKind {
  const binary = agent.argv[0]?.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (binary.includes("codex")) return "codex";
  if (binary.includes("claude")) return "claude";
  if (binary.includes("opencode")) return "opencode";
  if (binary.includes("aider")) return "aider";
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
    case "shell":
      return "Shell";
    default:
      return "Custom";
  }
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
