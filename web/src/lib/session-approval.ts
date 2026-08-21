/**
 * The session-side approval gate's decisions (docs/TRUST_UX.md §3, §7).
 *
 * An unapproved device that opens an agent session is blocked by the daemon's
 * chain admission no matter what; these helpers decide when to put the guided
 * approval card over that dead terminal, and how a device's active "asking for
 * approval" stamp re-surfaces the toast on the devices that can approve it.
 * Pure functions — everything here is advisory display routing, never
 * admission.
 */

/** Routes that host a live agent terminal: one agent, or a screen of panes. */
export function isAgentSessionPath(pathname: string | null): boolean {
  if (!pathname) return false;
  if (pathname === "/agents/new") return false;
  return /^\/(?:agents|screens)\/[^/]+\/?$/u.test(pathname);
}

/**
 * Whether a waiting device belongs in the approval toast despite an earlier
 * Ignore: a FRESH ask (it tried to open a session after the ignore) re-raises
 * it; anything else stays ignored for the sitting.
 */
export function approvalToastEligible(
  device: { approval_requested_at: string | null },
  ignoredAtMs: number | undefined,
): boolean {
  if (ignoredAtMs === undefined) return true;
  if (device.approval_requested_at === null) return false;
  const requested = Date.parse(device.approval_requested_at);
  return Number.isFinite(requested) && requested > ignoredAtMs;
}

/**
 * The one device the toast shows: the most recent active ask wins; devices
 * that never asked keep their list order (newest sign-in first) behind them.
 */
export function pickApprovalToastDevice<T extends { approval_requested_at: string | null }>(
  waiting: readonly T[],
): T | null {
  if (waiting.length === 0) return null;
  const at = (device: T): number =>
    device.approval_requested_at === null ? 0 : Date.parse(device.approval_requested_at) || 0;
  return [...waiting].sort((a, b) => at(b) - at(a))[0] ?? null;
}
