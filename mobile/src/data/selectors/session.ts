import { identifyAgent } from "@/data/selectors/agent";
import type {
  ActivityPresentation,
  ActivityTone,
  AgentDef,
  Attention,
  DisplayStatus,
  Host,
  Session,
  TransportPresentation,
  TransportState,
} from "@/data/types/domain";

const ACTIVE_OUTPUT_MS = 3_000;

/** What every device shows on a pane and its terminal while a device moves
 *  the window to another host: the target cannot be named before the commit. */
export const MOVING_STATUS_LABEL = "Moving to another host…";
/** The same window in lists, the host page and the fleet: the server's word. */
export const MOVING_LIST_LABEL = "Moving";

/** A window being carried to another host (`/move/begin`): not live, not
 *  waiting, not dead — and never attached on the host it is leaving. */
export function isMovingSession(session: Pick<Session, "status">): boolean {
  return session.status === "moving";
}

/** Whether a window counts as running somewhere: not stopped, and not in
 *  the middle of a move. */
export function isLiveSession(session: Pick<Session, "status">): boolean {
  return session.status !== "exited" && session.status !== "killed" && session.status !== "moving";
}
const WAITING_OUTPUT_MS = 8_000;

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestActivityAt(session: Session): string | null {
  const values = [
    session.last_output_at,
    session.last_input_at,
    session.exited_at,
    session.started_at,
  ].filter((value): value is string => value !== null);
  return values.sort((a, b) => (timestamp(b) ?? 0) - (timestamp(a) ?? 0))[0] ?? null;
}

export function deriveActivity(session: Session, now = Date.now()): ActivityPresentation {
  const terminal = (state: string, label: string): ActivityPresentation => ({
    state,
    label,
    last_activity_at: latestActivityAt(session),
  });
  if (session.status === "starting") return terminal("starting", "Starting");
  if (session.status === "exited") return terminal("exited", "Exited");
  if (session.status === "killed") return terminal("killed", "Killed");
  if (session.status === "moving") return terminal("moving", MOVING_LIST_LABEL);
  if (session.status !== "running") {
    const label = session.status
      .replaceAll("_", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
    return terminal(session.status, label);
  }

  const outputAt = timestamp(session.last_output_at);
  const inputAt = timestamp(session.last_input_at);
  if (outputAt === null) {
    const startedAt = timestamp(session.started_at) ?? now;
    return now - startedAt >= WAITING_OUTPUT_MS
      ? terminal("quiet", "Quiet")
      : terminal("starting", "Starting");
  }
  if (now - outputAt <= ACTIVE_OUTPUT_MS) return terminal("active", "Active");
  if (inputAt !== null && inputAt > outputAt) return terminal("input_sent", "Input sent");
  if (now - outputAt >= WAITING_OUTPUT_MS) return terminal("waiting", "Awaiting input");
  return terminal("quiet", "Quiet");
}

export function activityTone(session: Session): ActivityTone {
  switch (session.activity_state) {
    case "active":
      return "active";
    case "waiting":
    case "input_sent":
    case "starting":
      return "waiting";
    case "quiet":
    case "moving":
      return "idle";
    default:
      return session.status === "running" ? "idle" : "offline";
  }
}

export function sessionAttention(session: Session): Attention {
  if (session.status === "exited" || session.status === "killed") return "dead";
  if (session.activity_state === "waiting") return "waiting";
  return null;
}

export function attentionRank(session: Session): number {
  const attention = sessionAttention(session);
  return attention === "dead" ? 2 : attention === "waiting" ? 1 : 0;
}

function transportPresentation(transport: TransportState): TransportPresentation {
  if (transport === "ready") return "connected";
  if (transport === "closed" || transport === "failed") return "offline";
  return "connecting";
}

export function displayStatus(
  session: Session,
  host: Host | null,
  transport: TransportState,
): DisplayStatus {
  return {
    process: session.status,
    activity: session.activity_state,
    host: host === null ? "unknown" : host.status === "online" ? "online" : "offline",
    transport,
    transportPresentation: transportPresentation(transport),
    attention: sessionAttention(session),
    // The server's own label for a moving window is "Moving"; every device
    // says where to, as far as it can before the commit.
    label: isMovingSession(session)
      ? MOVING_STATUS_LABEL
      : session.activity_label || session.status.toUpperCase(),
    tone: activityTone(session),
    pulse: session.activity_state === "active",
  };
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() ?? "";
}

/**
 * The name someone gave this window, if any. Servers before 2026-10 named
 * every window "<host> - <folder>" themselves; host and folder are shown
 * beside it already, so a name of exactly that shape counts as no name. The
 * browser applies the same rule (web/src/lib/sessions.ts).
 */
export function sessionOwnName(session: Pick<Session, "name" | "host_name">): string | null {
  const name = session.name?.trim();
  if (!name) return null;
  const host = session.host_name?.trim();
  if (host && name.startsWith(`${host} - `) && !/[\\/]/.test(name.slice(host.length + 3))) {
    return null;
  }
  return name;
}

export function sessionTitle(session: Session, agents: readonly AgentDef[] = []): string {
  const explicit = sessionOwnName(session);
  if (explicit) return explicit;
  const identity = identifyAgent(session.foreground_command, agents);
  const directory = basename(session.cwd);
  return `${directory || session.id.slice(0, 8)} · ${identity.displayName}`;
}

export function sessionTitleDetail(session: Session): string {
  return session.cwd;
}

export function relativeTime(value: string | null, now = Date.now()): string | null {
  const then = timestamp(value);
  if (then === null) return null;
  const seconds = Math.max(0, Math.floor((now - then) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function terminalHasNewOutput(
  overlayMounted: boolean,
  atLiveEdge: boolean,
  outputArrivedSinceLeavingLiveEdge: boolean,
): boolean {
  return overlayMounted && !atLiveEdge && outputArrivedSinceLeavingLiveEdge;
}

/** Alerts are transient; spawn has no durable unread entity. */
export function durableUnreadCount(): 0 {
  return 0;
}
