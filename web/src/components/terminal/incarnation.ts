/**
 * A window is a session row and it lasts; an incarnation is one run of it —
 * one worker and PTY on one host. A window moved to another host keeps its
 * id and gets a new incarnation, so the terminal showing it is keyed by both:
 * the old host's terminal is let go whole and a fresh one attaches over the new
 * host's connection, instead of one terminal being re-pointed with the old
 * worker's replay offsets, display lease and screen still inside it.
 */
export function incarnationKey(sessionId: string, hostId: string | null): string {
  return `${sessionId}@${hostId ?? ""}`;
}

/** Long enough for a moved window's terminal to mount on the new host; short
 *  enough that an intent nobody consumed cannot surface on a later move. */
const OPEN_INTENT_TTL_MS = 60_000;

const intents = new Map<string, number>();

/**
 * The incarnations this tab opened on purpose.
 *
 * A terminal that mounts because its window moved is a reconnect, and a
 * reconnect never takes the display lease (`docs/DEVICE_CONNECTIONS.md`): every
 * device showing the window follows it to the new host, and none of them
 * snatches control just for having followed. The one exception is the device
 * that moved it — it is about to type the agent's launch there, and input is
 * the controller's. That device marks the new incarnation here before it learns
 * of the move's result, and the terminal mounting for it takes the lease as an
 * opening would.
 */
export const openIntent = {
  mark(key: string, now: number = Date.now()): void {
    intents.set(key, now + OPEN_INTENT_TTL_MS);
  },
  /** Read without consuming: a render may run more than once. */
  has(key: string, now: number = Date.now()): boolean {
    const expires = intents.get(key);
    if (expires === undefined) return false;
    if (expires > now) return true;
    intents.delete(key);
    return false;
  },
  clear(key: string): void {
    intents.delete(key);
  },
};
