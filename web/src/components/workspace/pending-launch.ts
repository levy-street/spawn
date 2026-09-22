/**
 * Commands queued for a session that does not exist on screen yet.
 *
 * Agent CLIs are started by typing their command into a shell — the daemon
 * takes no argv (proto/README.md). The menu that creates the session is not
 * the component that owns its terminal, so the command waits here until the
 * pane connects and claims it.
 */
const queued = new Map<string, string>();

export const pendingLaunch = {
  set(sessionId: string, command: string): void {
    queued.set(sessionId, command);
  },
  /** Whether a command is waiting, without claiming it. A pane that has no
   *  terminal handle yet asks this before taking, so a command is never
   *  claimed by something that cannot type it. */
  has(sessionId: string): boolean {
    return queued.has(sessionId);
  },
  /** Forget a queued command — the launch it was queued for never happened. */
  clear(sessionId: string): void {
    queued.delete(sessionId);
  },
  /** Returns the command once, then forgets it. */
  take(sessionId: string): string | null {
    const command = queued.get(sessionId) ?? null;
    queued.delete(sessionId);
    return command;
  },
};
