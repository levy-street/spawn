/**
 * The session-side approval gate's decisions (docs/TRUST_UX.md §3, §7).
 *
 * An unapproved device that opens an agent session is blocked by the daemon's
 * chain admission no matter what; this decides when to put the guided
 * approval card over that dead terminal. Pure and advisory: display routing,
 * never admission.
 */

/**
 * Routes that host a live terminal: one session, or a workspace of panes.
 * (`/sessions/:id` and `/w/:id` — the post-overhaul spellings of what were
 * `/agents/:id` and `/screens/:id`.)
 */
export function isAgentSessionPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return /^\/(?:sessions|w)\/[^/]+\/?$/u.test(pathname);
}
