import type { AlertEvent } from "@/data/realtime/alert-socket";
import { identifyAgent } from "@/data/selectors/agent";
import { sessionTitle } from "@/data/selectors/session";
import type { AgentDef, Session } from "@/data/types/domain";

export interface AlertContentContext {
  session?: Session;
  agents?: readonly AgentDef[];
  workspaceName?: string | null;
}

function alertSubject(event: AlertEvent, agents: readonly AgentDef[]): string {
  if (!event.command) return "Session";
  return identifyAgent(event.command, agents).displayName;
}

export function alertTitle(event: AlertEvent, agents: readonly AgentDef[] = []): string {
  const subject = alertSubject(event, agents);
  if (event.event === "session.died") {
    return event.signal ? `${subject} was killed` : `${subject} exited`;
  }
  if (event.event === "agent.awaiting_input") return `${subject} is waiting for you`;
  return `${subject} finished`;
}

function lastPathSegment(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").at(-1) ?? "";
}

function mentions(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const target = needle.toLocaleLowerCase();
  return haystack
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => token === target);
}

function sameWords(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

export function alertBody(event: AlertEvent, context: AlertContentContext = {}): string {
  const agents = context.agents ?? [];
  const session = context.session;
  const title = session ? sessionTitle(session, agents) : `Session ${event.session_id.slice(0, 8)}`;
  const workspace = context.workspaceName?.trim();
  const parts: string[] = [];
  if (workspace && !sameWords(workspace, title)) parts.push(workspace);
  parts.push(title);

  const folder = session?.cwd ? lastPathSegment(session.cwd) : "";
  if (folder && !mentions(title, folder) && !mentions(workspace ?? "", folder)) {
    parts.push(folder);
  }

  const detail = parts.join(" · ");
  if (event.event === "session.died" && typeof event.exit_code === "number") {
    return `${detail} · exit ${event.exit_code}`;
  }
  if (event.event === "session.died" && event.signal) return `${detail} · ${event.signal}`;
  return detail;
}

export function alertToastMessage(event: AlertEvent, context: AlertContentContext = {}): string {
  return `${alertTitle(event, context.agents)}: ${alertBody(event, context)}`;
}
