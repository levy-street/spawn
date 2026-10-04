/**
 * Commands queued for a session that does not exist on screen yet.
 *
 * Agent CLIs are started by typing their command into a shell — the daemon
 * takes no argv (proto/README.md). The menu that creates the session is not
 * the component that owns its terminal, so the command waits here until the
 * pane connects and claims it.
 *
 * A command belongs to one incarnation of its window — one worker on one
 * host, `${id}@${host}` — the shell it was queued for. It is typed into that
 * incarnation or into nothing: once the window is seen running on another
 * host the command is dropped, never typed into whatever runs there, and one
 * nobody could type for {@link PENDING_LAUNCH_TTL_MS} lapses. A launch waits
 * for its view to hold the display, which can take as long as someone takes
 * to press Take control; typed that late, a resume would land in the middle
 * of whatever had been started by hand in the meantime.
 */

/** How long a queued command waits to be typed: the phone's wait too
 *  (mobile `PENDING_LAUNCH_TTL_MS`). */
export const PENDING_LAUNCH_TTL_MS = 15 * 60 * 1_000;

type QueuedLaunch = {
  hostId: string;
  command: string;
  expiresAt: number;
  /** Queued by this device to type itself: its view takes the display. */
  claims: boolean;
};

const queued = new Map<string, QueuedLaunch>();

/** The command waiting for the window as it runs on `hostId`, if one has not
 *  lapsed. One that lapsed is forgotten on the way. */
function waiting(sessionId: string, hostId: string, now: number): QueuedLaunch | null {
  const launch = queued.get(sessionId);
  if (!launch) return null;
  if (launch.expiresAt <= now) {
    queued.delete(sessionId);
    return null;
  }
  return launch.hostId === hostId ? launch : null;
}

export const pendingLaunch = {
  /** Queue `command` for the window as it runs on `hostId` — the host the
   *  caller just created, restarted or moved it on. */
  set(sessionId: string, hostId: string, command: string, now: number = Date.now()): void {
    queued.set(sessionId, {
      hostId,
      command,
      expiresAt: now + PENDING_LAUNCH_TTL_MS,
      claims: false,
    });
  },
  /**
   * Queue `command` for this device to type itself, wherever the display is:
   * what a device that moved a window, or settled a move — finished it, or put
   * it back — owes the window. Its view of the window takes the display as an
   * opening does (`usePendingLaunchDrain`), so the agent comes back even
   * while another device is looking at the window, instead of waiting for
   * someone to press Take control.
   */
  claim(sessionId: string, hostId: string, command: string, now: number = Date.now()): void {
    queued.set(sessionId, {
      hostId,
      command,
      expiresAt: now + PENDING_LAUNCH_TTL_MS,
      claims: true,
    });
  },
  /** Whether the command waiting for the window as it runs on `hostId` was
   *  queued to take the display (`claim`). */
  claims(sessionId: string, hostId: string, now: number = Date.now()): boolean {
    return waiting(sessionId, hostId, now)?.claims === true;
  },
  /** Whether a command is waiting for the window as it runs on `hostId`,
   *  without claiming it. A pane that has no terminal handle yet asks this
   *  before taking, so a command is never claimed by something that cannot
   *  type it. */
  has(sessionId: string, hostId: string, now: number = Date.now()): boolean {
    return waiting(sessionId, hostId, now) !== null;
  },
  /** Forget a queued command — the launch it was queued for never happened. */
  clear(sessionId: string): void {
    queued.delete(sessionId);
  },
  /** Returns the command queued for the window as it runs on `hostId` once,
   *  then forgets it. */
  take(sessionId: string, hostId: string, now: number = Date.now()): string | null {
    const launch = waiting(sessionId, hostId, now);
    if (!launch) return null;
    queued.delete(sessionId);
    return launch.command;
  },
  /**
   * The window has been seen running on `hostId`: a command queued for it as
   * it ran anywhere else belongs to an incarnation that is gone, and is
   * dropped. Called only on evidence the caller trusts — a terminal attached
   * there, or a terminal that followed the window there — never on a list
   * response, which can have left the server before the move it predates.
   */
  observe(sessionId: string, hostId: string): void {
    const launch = queued.get(sessionId);
    if (launch && launch.hostId !== hostId) queued.delete(sessionId);
  },
};

/**
 * The host a view's live terminal is attached to, when that is where the
 * window runs now: its transport is open, to the host the window's row names.
 * Anything else — a transport still opening, or one that still belongs to the
 * host a window has just left, whose shell is being killed — is null.
 */
export function attachedLaunchHost(
  session: { host_id: string } | undefined,
  connInfo: { socketState: string; hostId?: string | null } | null,
): string | null {
  if (session === undefined || connInfo?.socketState !== "open") return null;
  return connInfo.hostId === session.host_id ? session.host_id : null;
}
