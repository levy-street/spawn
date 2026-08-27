import { resolveAgentIcon } from "@/lib/agent-identity";
import type { Agent, Session } from "@/lib/api";
import { sessionTitle } from "@/lib/sessions";

/**
 * Attention events: what the `/ws/alerts` socket carries, and the pure
 * derivations that turn one into something worth showing a person.
 *
 * Detection itself is deliberately NOT here. It lives beside the writes in
 * `server/spawn_server/ws/daemon.py`, where the previous foreground command is
 * still in hand — which is both the only place it can be done correctly and
 * the reason an alert arrives in about a second rather than on the next poll.
 * The browser's job is to render what it is told, mute what the owner muted,
 * and never show the same event twice.
 */

export const ALERTS_WS_SUBPROTOCOL = "spawn.alerts.v1";

export type AlertEventKind = "agent.finished" | "agent.awaiting_input" | "session.died";

export interface AlertEvent {
  event: AlertEventKind;
  session_id: string;
  /** Foreground basename that finished, or that went down with the session.
   *  Null when nothing was running — an idle shell that died. */
  command: string | null;
  exit_code?: number | null;
  signal?: string | null;
  /** Server-stamped ISO 8601. Used for dedupe identity, not for display. */
  at: string;
}

/**
 * Trust events share this socket because they have the same shape of problem:
 * something happened that the operator must see on whichever device they are
 * looking at, which is not the device it happened on. They are a separate
 * frame `type` so the alert validation below stays exactly as narrow.
 */
export type DeviceTrustEventKind = "device.approval_requested" | "device.approval_resolved";

export interface DeviceTrustEvent {
  event: DeviceTrustEventKind;
  request_id: string;
  browser_device_id: string;
  label: string | null;
  /** Present on a request; the operator compares it against the asking device. */
  fingerprint: string | null;
  status: "approved" | "denied" | null;
  at: string;
}

export interface HostPinUndeliveredEvent {
  event: "host.pin_undelivered";
  host_id: string;
  browser_device_id: string;
  reason: "pin_limit" | "invalid_chain" | "other";
  at: string;
}

export type TrustEvent = DeviceTrustEvent | HostPinUndeliveredEvent;

/** Frames the socket can deliver. `alerts.ping` is an idle keepalive. */
export type AlertFrame =
  | ({ type: "alert" } & AlertEvent)
  | ({ type: "trust" } & TrustEvent)
  | { type: "alerts.ping" };

const TRUST_EVENT_KINDS = new Set<string>([
  "device.approval_requested",
  "device.approval_resolved",
  "host.pin_undelivered",
]);

function parseTrustFrame(record: Record<string, unknown>): AlertFrame | null {
  const event = record.event;
  if (typeof event !== "string" || !TRUST_EVENT_KINDS.has(event)) return null;
  if (event === "host.pin_undelivered") {
    if (
      typeof record.host_id !== "string" ||
      !record.host_id ||
      typeof record.browser_device_id !== "string" ||
      !record.browser_device_id ||
      (record.reason !== "pin_limit" &&
        record.reason !== "invalid_chain" &&
        record.reason !== "other")
    ) {
      return null;
    }
    return {
      type: "trust",
      event,
      host_id: record.host_id,
      browser_device_id: record.browser_device_id,
      reason: record.reason,
      at: typeof record.at === "string" ? record.at : "",
    };
  }
  const requestId = record.request_id;
  const deviceId = record.browser_device_id;
  if (typeof requestId !== "string" || !requestId) return null;
  if (typeof deviceId !== "string" || !deviceId) return null;
  const status = record.status;
  return {
    type: "trust",
    event: event as DeviceTrustEventKind,
    request_id: requestId,
    browser_device_id: deviceId,
    label: typeof record.label === "string" ? record.label : null,
    fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : null,
    status: status === "approved" || status === "denied" ? status : null,
    at: typeof record.at === "string" ? record.at : "",
  };
}

const EVENT_KINDS = new Set<string>(["agent.finished", "agent.awaiting_input", "session.died"]);

/**
 * Parse and validate one socket frame. Anything unrecognized returns null
 * rather than throwing: a frame this build does not know about is a future
 * server talking, not an error worth surfacing.
 */
export function parseAlertFrame(raw: string): AlertFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  if (frame.type === "alerts.ping") return { type: "alerts.ping" };
  if (frame.type === "trust") return parseTrustFrame(frame);
  if (frame.type !== "alert") return null;
  if (typeof frame.event !== "string" || !EVENT_KINDS.has(frame.event)) return null;
  if (typeof frame.session_id !== "string" || !frame.session_id) return null;
  const command = frame.command;
  // Absent and explicitly null both mean "nothing was running". Only a wrong
  // type is a malformed frame.
  if (command != null && typeof command !== "string") return null;
  return {
    type: "alert",
    event: frame.event as AlertEventKind,
    session_id: frame.session_id,
    command: command ?? null,
    exit_code: typeof frame.exit_code === "number" ? frame.exit_code : null,
    signal: typeof frame.signal === "string" ? frame.signal : null,
    at: typeof frame.at === "string" ? frame.at : "",
  };
}

/**
 * Identity for "this is the same event". Two tabs on one browser receive the
 * same publish and must not both buzz; the server's `at` stamp is what makes
 * the key stable across them without any coordination.
 */
export function alertKey(event: AlertEvent): string {
  return `${event.event}:${event.session_id}:${event.at}`;
}

/** The headline: what happened, to what. Where it happened is `alertBody`. */
export function alertTitle(
  event: AlertEvent,
  agents: readonly Pick<Agent, "command" | "name">[] = [],
): string {
  const what = alertSubject(event, agents);
  if (event.event === "session.died") {
    return event.signal ? `${what} was killed` : `${what} exited`;
  }
  // "Waiting for you" rather than "finished": for an agent CLI this is the
  // end of a turn, not the end of the process — it is still sitting there.
  if (event.event === "agent.awaiting_input") return `${what} is waiting for you`;
  return `${what} finished`;
}

/**
 * Where it happened: workspace, then window, then the folder if the window's
 * name does not already say it.
 *
 * Each part is dropped when it would only repeat another. A default session
 * name is already "<host> - <folder>", so naively appending the host and the
 * folder produced "Laptop - spawn · Laptop · spawn" — three facts, one of
 * them said three times.
 */
export function alertBody(
  event: AlertEvent,
  session: Session | undefined,
  workspaceName?: string | null,
): string {
  const window = session ? sessionTitle(session) : `Session ${event.session_id.slice(0, 8)}`;
  const parts: string[] = [];
  const workspace = workspaceName?.trim();
  if (workspace && !sameWords(workspace, window)) parts.push(workspace);
  parts.push(window);
  const folder = session?.cwd ? lastPathSegment(session.cwd) : "";
  if (folder && !mentions(window, folder) && !mentions(workspace ?? "", folder)) {
    parts.push(folder);
  }
  const detail = parts.join(" · ");
  if (event.event === "session.died" && typeof event.exit_code === "number") {
    return `${detail} · exit ${event.exit_code}`;
  }
  if (event.event === "session.died" && event.signal) {
    return `${detail} · ${event.signal}`;
  }
  return detail;
}

function lastPathSegment(cwd: string): string {
  const normalized = cwd.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").at(-1) ?? "";
}

/**
 * Whether `haystack` already names `needle` as a word of its own.
 *
 * Token-wise rather than substring: a workspace called "Spawnd" contains the
 * letters of a folder called "spawn" without being about it, and dropping the
 * folder on that basis loses a real fact. "Laptop - spawn" genuinely does name
 * it, and that is the case worth collapsing.
 */
function mentions(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const target = needle.toLowerCase();
  return haystack
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => token === target);
}

function sameWords(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** One line for a toast, where there is no separate title and body. */
export function alertToastMessage(
  event: AlertEvent,
  session: Session | undefined,
  agents: readonly Pick<Agent, "command" | "name">[] = [],
  workspaceName?: string | null,
): string {
  return `${alertTitle(event, agents)} — ${alertBody(event, session, workspaceName)}`;
}

/**
 * What to call the thing the event is about, in prose a person would use.
 *
 * The brand name wins over the installed definition's name, which is the
 * opposite of what you might expect — but the built-in definitions are
 * slugs (`claude-code`, `aider-sonnet`, see `agents_builtin.py`), and
 * "claude-code is waiting for you" reads like a log line. A definition name
 * is only better than the brand when there is no brand to use: a custom
 * agent someone added and named themselves.
 */
function alertSubject(
  event: AlertEvent,
  agents: readonly Pick<Agent, "command" | "name">[],
): string {
  if (!event.command) return "Session";
  const resolved = resolveAgentIcon(null, event.command);
  if (resolved.icon !== "monogram" && resolved.icon !== "shell") return resolved.label;
  return matchAgentName(event.command, agents) ?? resolved.label;
}

function matchAgentName(
  command: string,
  agents: readonly Pick<Agent, "command" | "name">[],
): string | null {
  const name = (command.startsWith("-") ? command.slice(1) : command).toLowerCase();
  for (const agent of agents) {
    const first = agent.command
      .trim()
      .split(/\s+/)
      .find((part) => part !== "" && !part.includes("="));
    const basename = first?.split(/[\\/]/).at(-1)?.toLowerCase();
    if (basename && basename === name) return agent.name;
  }
  return null;
}
