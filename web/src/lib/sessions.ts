import {
  agentDisplayName,
  commandBasename,
  SHELL_COMMANDS,
  stripExecutableSuffix,
} from "@/lib/agent-identity";
import type { Agent, Session, Workspace } from "@/lib/api";
import { tabOfSession } from "@/lib/tabs";

/**
 * Pure derivation helpers for sessions: display titles, activity labels and
 * tones, attention states, and the shell matcher the shortcut bar keys off.
 */

/** Status-dot tone; maps 1:1 to the `--tone-*` design tokens. */
export type SessionActivityTone = "active" | "waiting" | "idle" | "offline";

/**
 * Display title: the explicit name when there is one, else the folder the
 * session sits in and what is running there — "spawn · Claude Code" — which
 * is what tells two panes apart at a glance. The host lives in the header's
 * tooltip instead; it rarely differs between panes.
 */
export function sessionTitle(session: Session): string {
  const name = session.name?.trim();
  if (name) return name;
  const folder = session.cwd.trim() ? lastCwdDir(session.cwd) : null;
  const running = agentDisplayName(session.foreground_command);
  if (folder) return `${folder} · ${running}`;
  return `${session.id.slice(0, 8)} · ${running}`;
}

/** Full context for a title's tooltip: host, path, and what is running. */
export function sessionTitleDetail(session: Session): string {
  const host = session.host_name?.trim();
  const cwd = session.cwd.trim() || "unknown folder";
  const running = agentDisplayName(session.foreground_command);
  return `${host ? `${host} · ` : ""}${cwd} · ${running}`;
}

function lastCwdDir(cwd: string): string {
  const trimmed = cwd.trim();
  const normalized = trimmed.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized) return trimmed || "/";
  return normalized.split("/").at(-1) || normalized;
}

export function sessionStatusLabel(session: Session): string {
  return session.status.toUpperCase();
}

export function sessionActivityLabel(session: Session): string {
  return session.activity_label || sessionStatusLabel(session);
}

export function sessionActivityDetail(session: Session): string {
  const label = sessionActivityLabel(session);
  const age = relativeTime(session.last_activity_at);
  return age ? `${label} · ${age}` : label;
}

export function sessionActivityTone(session: Session): SessionActivityTone {
  switch (session.activity_state) {
    case "active":
      return "active";
    case "waiting":
    case "input_sent":
    case "starting":
      return "waiting";
    case "quiet":
      return "idle";
    default:
      return session.status === "running" ? "idle" : "offline";
  }
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

/** Attention states a multi-pane workspace should surface at a glance. */
export function sessionNeedsAttention(session: Session): "waiting" | "dead" | null {
  if (session.status === "exited" || session.status === "killed") return "dead";
  if (session.activity_state === "waiting") return "waiting";
  return null;
}

/**
 * True when a reported foreground command is a shell. The daemon reports the
 * process basename only; login shells prefix argv[0] with "-" (e.g. "-zsh"),
 * which the kernel-derived name can carry through, and Windows carries the
 * executable extension ("pwsh.exe").
 */
export function isShellCommand(command: string | null | undefined): boolean {
  if (!command) return false;
  const name = command.startsWith("-") ? command.slice(1) : command;
  return SHELL_COMMANDS.has(stripExecutableSuffix(name.toLowerCase()));
}

/**
 * Whether the session currently shows a shell prompt: the shell itself is in
 * the foreground, or the worker predates foreground reporting (null).
 */
export function sessionAtShell(session: Session): boolean {
  return session.foreground_command === null || isShellCommand(session.foreground_command);
}

/**
 * Where opening a session should land: the workspace tab holding it, focused
 * on it — or the standalone session page, which exists even for a session no
 * workspace references. Same rule the alert toasts navigate by.
 */
export function sessionHref(
  sessionId: string,
  workspaces: readonly Pick<Workspace, "id" | "layout">[],
): string {
  for (const workspace of workspaces) {
    const tab = tabOfSession(workspace.layout, sessionId);
    if (tab) return `/w/${workspace.id}?tab=${tab.id}&focus=${sessionId}`;
  }
  return `/sessions/${sessionId}`;
}

/**
 * Which installed agent a session is running, matched on the daemon-reported
 * foreground process: its basename against the first real word of an agent's
 * command (env assignments skipped, path stripped). Null for a shell prompt,
 * or for a foreground process no agent claims — the caller then treats the
 * session as a plain shell.
 *
 * Both sides are compared with the Windows executable extension stripped: a
 * Windows host reports "claude.exe" for the agent the registry spells
 * "claude", and an exact match would call that pane a plain shell — which is
 * how duplicating a Claude Code pane on Windows used to produce an empty one.
 */
export function runningAgent<T extends Pick<Agent, "command">>(
  session: Pick<Session, "foreground_command"> | undefined,
  agents: readonly T[],
): T | null {
  const reported = session?.foreground_command?.trim();
  if (!reported || isShellCommand(reported)) return null;
  // Login shells prefix argv[0] with "-"; the same can reach any basename.
  const name = stripExecutableSuffix(
    (reported.startsWith("-") ? reported.slice(1) : reported).toLowerCase(),
  );
  return (
    agents.find(
      (agent) => stripExecutableSuffix(commandBasename(agent.command).toLowerCase()) === name,
    ) ?? null
  );
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
 * shell. A window opened by hand — someone typed `claude` at the prompt
 * themselves — has nothing recorded, and the foreground is then the only
 * answer there is, so it is still asked.
 */
export function sessionAgent<T extends Pick<Agent, "id" | "command">>(
  session: Pick<Session, "foreground_command" | "agent_id"> | undefined,
  agents: readonly T[],
): T | null {
  const recorded = session?.agent_id;
  const known = recorded ? agents.find((agent) => agent.id === recorded) : undefined;
  // A recorded id no agent claims — a custom definition deleted since — is a
  // type nothing can launch any more, so the live process answers instead.
  return known ?? runningAgent(session, agents);
}
